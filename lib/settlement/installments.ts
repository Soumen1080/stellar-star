/**
 * lib/settlement/installments.ts
 *
 * Partial settlement of a single share over several on-chain payments (#325).
 *
 * A share used to be all-or-nothing: one payment, then `paid: true`. Real
 * groups pay in parts, so a share now carries an append-only list of
 * installments, each linked to its own Stellar transaction and attestation.
 *
 * Invariants:
 * 1. Exact: owed, paid and remaining are integer stroops (bigint). No amount
 *    passes through a float, and remaining is always owed - paid exactly.
 * 2. No overpayment: an installment larger than the remaining balance is
 *    rejected, before signing (planInstallment) and again at write time
 *    (applyInstallment, and the `record_share_installment` RPC). There is no
 *    implicit credit; a surplus would need an explicit credit flow.
 * 3. Never partial-as-settled: `paid` becomes true only when remaining hits
 *    exactly zero. Net settlement and reconciliation read the remaining
 *    balance, never the owed amount, for a partially paid share.
 * 4. Idempotent: an installment is identified by its transaction hash, so
 *    recording the same payment twice (retry after submit, reconciliation on
 *    another device) is a no-op rather than a double count.
 * 5. Independently provable: every installment settles on-chain under its
 *    own claim id (`<expenseId>#<seq>`), so the contract's one-record-per
 *    (expense, member) rule never blocks the second part, and a partial
 *    payment can never mark the plain expense id paid on-chain.
 */

import { Money } from "@/lib/money";
import type { ShareInstallment, SplitShare } from "@/types/expense";

/** Separator between an expense id and an installment sequence in a claim id. */
export const INSTALLMENT_CLAIM_SEPARATOR = "#";

/** Hard cap so a claim id always fits the contract's 64-character id limit. */
export const MAX_INSTALLMENTS_PER_SHARE = 999;

export interface ShareBalance {
  owedStroops: bigint;
  paidStroops: bigint;
  remainingStroops: bigint;
  /** Decimal strings at full ledger precision, for display and payment. */
  owed: string;
  paid: string;
  remaining: string;
  installmentCount: number;
  /** True when some, but not all, of the share has been paid. */
  partiallyPaid: boolean;
  fullySettled: boolean;
}

function toStroops(amount: string): bigint {
  return Money.parse(amount).toStroops();
}

function fromStroops(stroops: bigint): string {
  return Money.fromStroops(stroops).format();
}

/** The share's installments, in sequence order. Rows saved before #325 have none. */
export function installmentsOf(share: Pick<SplitShare, "installments">): ShareInstallment[] {
  return [...(share.installments ?? [])].sort((a, b) => a.seq - b.seq);
}

export function hasInstallments(share: Pick<SplitShare, "installments">): boolean {
  return (share.installments?.length ?? 0) > 0;
}

/**
 * Owed / paid / remaining for one share.
 *
 * `paid: true` is authoritative: it is only ever set by a payment that covered
 * the whole remaining balance (a full payment, the final installment, or a net
 * settlement that included this share). A legacy paid share with no
 * installments is therefore fully paid.
 */
export function shareBalance(share: Pick<SplitShare, "amount" | "paid" | "installments">): ShareBalance {
  const owedStroops = toStroops(share.amount);
  const installments = installmentsOf(share);
  const installmentSum = installments.reduce((sum, i) => sum + BigInt(i.amountStroops), 0n);

  const paidStroops = share.paid ? owedStroops : installmentSum < owedStroops ? installmentSum : owedStroops;
  const remainingStroops = owedStroops - paidStroops;

  return {
    owedStroops,
    paidStroops,
    remainingStroops,
    owed: fromStroops(owedStroops),
    paid: fromStroops(paidStroops),
    remaining: fromStroops(remainingStroops),
    installmentCount: installments.length,
    partiallyPaid: paidStroops > 0n && remainingStroops > 0n,
    fullySettled: remainingStroops === 0n,
  };
}

/** The balance still owed on a share, as an exact decimal string. */
export function remainingShareAmount(share: Pick<SplitShare, "amount" | "paid" | "installments">): string {
  return shareBalance(share).remaining;
}

export function nextInstallmentSeq(share: Pick<SplitShare, "installments">): number {
  return installmentsOf(share).reduce((max, i) => Math.max(max, i.seq), 0) + 1;
}

/** The expense id an installment is attested and recorded under on-chain. */
export function installmentClaimId(expenseId: string, seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_INSTALLMENTS_PER_SHARE) {
    throw new RangeError(`Installment sequence must be between 1 and ${MAX_INSTALLMENTS_PER_SHARE}.`);
  }
  return `${expenseId}${INSTALLMENT_CLAIM_SEPARATOR}${seq}`;
}

/** Splits an on-chain claim id back into its expense id and installment sequence. */
export function parseInstallmentClaimId(claimId: string): { expenseId: string; seq: number | null } {
  const match = /^(.+)#(\d{1,3})$/.exec(claimId);
  if (!match) return { expenseId: claimId, seq: null };
  return { expenseId: match[1], seq: Number(match[2]) };
}

/** Idempotency-key suffix that gives every installment its own intent lock. */
export function installmentKeySuffix(seq: number): string {
  return `:installment-${seq}`;
}

/** Recovers the installment sequence from a settlement intent's idempotency key. */
export function installmentSeqFromKey(idempotencyKey: string): number | null {
  const match = /:installment-(\d{1,3})$/.exec(idempotencyKey);
  return match ? Number(match[1]) : null;
}

export type InstallmentRejection =
  | "ALREADY_SETTLED"
  | "INVALID_AMOUNT"
  | "NON_POSITIVE"
  | "OVERPAYMENT"
  | "TOO_MANY_INSTALLMENTS";

export type InstallmentPlan =
  | {
      ok: true;
      seq: number;
      amount: string;
      amountStroops: bigint;
      /** True when this installment pays the share off exactly. */
      isFinal: boolean;
      remainingAfter: string;
      /**
       * False only for the legacy shape: one payment of the whole share with
       * no prior installments, which keeps the original single-payment path.
       */
      isInstallment: boolean;
      claimId: string | null;
    }
  | { ok: false; code: InstallmentRejection; message: string };

/**
 * Validates a proposed payment against a share before anything is signed.
 *
 * Omitting `requestedAmount` means "pay the rest".
 */
export function planInstallment(
  share: Pick<SplitShare, "amount" | "paid" | "installments">,
  expenseId: string,
  requestedAmount?: string,
): InstallmentPlan {
  const balance = shareBalance(share);
  if (balance.fullySettled) {
    return { ok: false, code: "ALREADY_SETTLED", message: "This share is already fully settled." };
  }

  let amountStroops: bigint;
  if (requestedAmount === undefined || requestedAmount.trim() === "") {
    amountStroops = balance.remainingStroops;
  } else {
    const parsed = Money.tryParse(requestedAmount.trim());
    if (!parsed) {
      return {
        ok: false,
        code: "INVALID_AMOUNT",
        message: "Enter an amount with at most 7 decimal places.",
      };
    }
    amountStroops = parsed.toStroops();
  }

  if (amountStroops <= 0n) {
    return { ok: false, code: "NON_POSITIVE", message: "An installment must be greater than zero." };
  }
  if (amountStroops > balance.remainingStroops) {
    return {
      ok: false,
      code: "OVERPAYMENT",
      message:
        `That is more than the ${balance.remaining} still owed on this share. ` +
        "Overpayments are not accepted; pay at most the remaining balance.",
    };
  }

  const seq = nextInstallmentSeq(share);
  const isInstallment = balance.installmentCount > 0 || amountStroops < balance.remainingStroops;
  if (isInstallment && seq > MAX_INSTALLMENTS_PER_SHARE) {
    return {
      ok: false,
      code: "TOO_MANY_INSTALLMENTS",
      message: `A share can be paid in at most ${MAX_INSTALLMENTS_PER_SHARE} installments.`,
    };
  }

  return {
    ok: true,
    seq,
    amount: fromStroops(amountStroops),
    amountStroops,
    isFinal: amountStroops === balance.remainingStroops,
    remainingAfter: fromStroops(balance.remainingStroops - amountStroops),
    isInstallment,
    claimId: isInstallment ? installmentClaimId(expenseId, seq) : null,
  };
}

export interface NewInstallment {
  seq: number;
  amount: string;
  txHash: string;
  claimId: string;
  ledger?: number | null;
  attestationNonce?: string | null;
  verified?: boolean;
  onChain?: boolean;
  paidAt?: string;
}

export type ApplyInstallmentResult =
  | { ok: true; share: SplitShare; duplicate: boolean }
  | { ok: false; code: "OVERPAYMENT" | "NON_POSITIVE" | "ALREADY_SETTLED"; message: string };

/**
 * Appends one installment to a share. Pure; mirrors `record_share_installment`.
 *
 * Re-applying a transaction already on the share returns it unchanged
 * (`duplicate: true`) so retries and reconciliation stay idempotent.
 */
export function applyInstallment(share: SplitShare, input: NewInstallment): ApplyInstallmentResult {
  const txHash = input.txHash.trim().toLowerCase();
  const existing = installmentsOf(share);

  if (existing.some((i) => i.txHash.toLowerCase() === txHash)) {
    return { ok: true, share, duplicate: true };
  }

  const amountStroops = toStroops(input.amount);
  if (amountStroops <= 0n) {
    return { ok: false, code: "NON_POSITIVE", message: "An installment must be greater than zero." };
  }

  const balance = shareBalance(share);
  if (balance.fullySettled) {
    return { ok: false, code: "ALREADY_SETTLED", message: "This share is already fully settled." };
  }
  if (amountStroops > balance.remainingStroops) {
    return {
      ok: false,
      code: "OVERPAYMENT",
      message: `Installment of ${fromStroops(amountStroops)} exceeds the remaining ${balance.remaining}.`,
    };
  }

  const installment: ShareInstallment = {
    seq: input.seq,
    amount: fromStroops(amountStroops),
    amountStroops: amountStroops.toString(),
    txHash,
    claimId: input.claimId,
    ledger: input.ledger ?? null,
    attestationNonce: input.attestationNonce ?? null,
    verified: input.verified ?? false,
    onChain: input.onChain ?? false,
    paidAt: input.paidAt ?? new Date().toISOString(),
  };

  const paidStroops = balance.paidStroops + amountStroops;
  const fullyPaid = paidStroops === balance.owedStroops;

  return {
    ok: true,
    duplicate: false,
    share: {
      ...share,
      installments: [...existing, installment],
      paidStroops: paidStroops.toString(),
      paid: fullyPaid,
      // The share-level txHash keeps meaning "the payment that settled it".
      txHash: fullyPaid ? txHash : share.txHash,
    },
  };
}

/** Marks an already-recorded installment as attested and/or recorded on-chain. */
export function markInstallmentProof(
  share: SplitShare,
  txHash: string,
  proof: { verified?: boolean; onChain?: boolean; attestationNonce?: string | null; ledger?: number | null },
): SplitShare {
  const hash = txHash.trim().toLowerCase();
  if (!share.installments?.some((i) => i.txHash.toLowerCase() === hash)) return share;
  return {
    ...share,
    installments: share.installments.map((i) =>
      i.txHash.toLowerCase() === hash
        ? {
            ...i,
            verified: proof.verified ?? i.verified,
            onChain: proof.onChain ?? i.onChain,
            attestationNonce: proof.attestationNonce ?? i.attestationNonce,
            ledger: proof.ledger ?? i.ledger,
          }
        : i,
    ),
  };
}
