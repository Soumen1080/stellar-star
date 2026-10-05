/**
 * The oracle's record of what it has already attested.
 *
 * The contract's nonce burn makes each *attestation* single-use. That is not
 * quite enough on its own: without this ledger, a debtor could take one real
 * 10 XLM payment and ask for a fresh attestation per expense — different
 * expense ids, different nonces, all individually valid, all pointing at the
 * same 10 XLM. The contract cannot catch that, because it cannot see that two
 * claims share a transaction.
 *
 * So the oracle enforces two things the chain cannot:
 *
 *   1. A given (txHash, expenseId, member) is attested at most once. Re-asking
 *      returns the stored attestation rather than minting a second one, which
 *      keeps a retry after a dropped response idempotent.
 *   2. The sum attested against a txHash never exceeds what that transaction
 *      actually paid.
 *
 * ## Storage
 *
 * Backed by Supabase when configured, so the guarantee holds across oracle
 * instances and restarts; otherwise by a process-local map, which is enough for
 * local development and single-instance deployments and is honest about being
 * so. `isDurable()` reports which, and the endpoint surfaces it — an operator
 * running several instances without the table gets told, rather than finding
 * out from a double-spend.
 */

import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

export interface AttestationLedgerEntry {
  txHash: string;
  expenseId: string;
  member: string;
  amountStroops: string;
  nonce: string;
  expiresAt: number;
  signature: string;
}

const TABLE = "settlement_attestations";

declare global {
  // Survives Next.js development hot reloads, like the auth challenge store.
  var stellarStarAttestations: Map<string, AttestationLedgerEntry> | undefined;
}

const memoryLedger =
  globalThis.stellarStarAttestations ?? new Map<string, AttestationLedgerEntry>();
globalThis.stellarStarAttestations = memoryLedger;

let memoryLock = Promise.resolve();

function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = memoryLock.then(fn, fn);
  memoryLock = next.then(
    () => {},
    () => {},
  );
  return next;
}

function entryKey(txHash: string, expenseId: string, member: string): string {
  return `${txHash}:${expenseId}:${member}`;
}

/** True when the ledger is shared across instances rather than process-local. */
export function isDurable(): boolean {
  return isServerSupabaseConfigured() && createServiceRoleClient() !== null;
}

/** Rows already attested against this transaction hash, from whichever backend. */
async function readByTxHash(txHash: string): Promise<AttestationLedgerEntry[]> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { data, error } = await client
      .from(TABLE)
      .select("tx_hash, expense_id, member, amount_stroops, nonce, expires_at, signature")
      .eq("tx_hash", txHash);

    if (error) {
      throw new Error(`Attestation ledger read failed: ${error.message}`);
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      txHash: String(row.tx_hash),
      expenseId: String(row.expense_id),
      member: String(row.member),
      amountStroops: String(row.amount_stroops),
      nonce: String(row.nonce),
      expiresAt: Number(row.expires_at),
      signature: String(row.signature),
    }));
  }

  return [...memoryLedger.values()].filter((entry) => entry.txHash === txHash);
}

export interface AllocationCheck {
  /** An attestation already minted for this exact claim, if any. */
  existing: AttestationLedgerEntry | null;
  /** Stroops already committed against this transaction, excluding `existing`. */
  allocatedStroops: bigint;
}

/** What has already been claimed against a transaction. */
export async function inspectAllocation(
  txHash: string,
  expenseId: string,
  member: string,
): Promise<AllocationCheck> {
  const rows = await readByTxHash(txHash);
  const key = entryKey(txHash, expenseId, member);

  let existing: AttestationLedgerEntry | null = null;
  let allocatedStroops = 0n;

  for (const row of rows) {
    if (entryKey(row.txHash, row.expenseId, row.member) === key) {
      existing = row;
      continue;
    }
    allocatedStroops += BigInt(row.amountStroops);
  }

  return { existing, allocatedStroops };
}

/**
 * Commits an attestation to the ledger.
 *
 * The unique constraint on (tx_hash, expense_id, member) is what makes this
 * safe under concurrency: two simultaneous requests for the same claim race,
 * one insert loses, and the loser re-reads the winner's row instead of minting
 * a second attestation. Returns the entry that ended up stored, which may be
 * the other request's.
 */
export async function commitAttestation(
  entry: AttestationLedgerEntry,
): Promise<AttestationLedgerEntry> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { error } = await client.from(TABLE).insert({
      tx_hash: entry.txHash,
      expense_id: entry.expenseId,
      member: entry.member,
      amount_stroops: entry.amountStroops,
      nonce: entry.nonce,
      expires_at: entry.expiresAt,
      signature: entry.signature,
    });

    if (error) {
      // 23505 = unique_violation: someone else committed this exact claim first.
      if (error.code === "23505") {
        const { existing } = await inspectAllocation(
          entry.txHash,
          entry.expenseId,
          entry.member,
        );
        if (existing) return existing;
      }
      throw new Error(`Attestation ledger write failed: ${error.message}`);
    }

    return entry;
  }

  return withMemoryLock(async () => {
    const key = entryKey(entry.txHash, entry.expenseId, entry.member);
    const already = memoryLedger.get(key);
    if (already) return already;
    memoryLedger.set(key, entry);
    return entry;
  });
}

/**
 * Per-transaction lock to serialize allocation checks and commits on the same
 * payment transaction hash.
 */
const txLocks = new Map<string, Promise<void>>();

export async function withTxLock<T>(txHash: string, fn: () => Promise<T> | T): Promise<T> {
  const key = txHash.toLowerCase();
  const prevLock = txLocks.get(key) ?? Promise.resolve();

  let releaseLock!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  const nextInQueue = prevLock.then(
    () => currentLock,
    () => currentLock,
  );
  txLocks.set(key, nextInQueue);

  await prevLock;
  try {
    return await fn();
  } finally {
    releaseLock();
    if (txLocks.get(key) === nextInQueue) {
      txLocks.delete(key);
    }
  }
}

export interface AllocateAndCommitOptions {
  txHash: string;
  expenseId: string;
  member: string;
  claimedAmountStroops: bigint;
  totalPaymentStroops: bigint;
  createEntry: () => Promise<AttestationLedgerEntry> | AttestationLedgerEntry;
}

export type AllocateAndCommitResult =
  | { success: true; entry: AttestationLedgerEntry; reused: boolean }
  | {
      success: false;
      reason: "INSUFFICIENT_FUNDS" | "AMOUNT_MISMATCH";
      allocatedStroops: bigint;
      remainingStroops: bigint;
    };

/**
 * Atomically verifies available capacity against a transaction and commits the attestation.
 * Serialized per txHash to prevent concurrent requests from over-allocating the payment.
 */
export async function allocateAndCommit(
  optionsOrEntry: AllocateAndCommitOptions | AttestationLedgerEntry,
  maxPaymentStroops?: bigint,
): Promise<AllocateAndCommitResult> {
  const isOptions = "createEntry" in optionsOrEntry;
  const txHash = optionsOrEntry.txHash;
  const expenseId = optionsOrEntry.expenseId;
  const member = optionsOrEntry.member;
  const claimedAmount = isOptions
    ? optionsOrEntry.claimedAmountStroops
    : BigInt(optionsOrEntry.amountStroops);
  const totalPayment = isOptions
    ? optionsOrEntry.totalPaymentStroops
    : (maxPaymentStroops ?? 0n);
  const getEntry = isOptions
    ? optionsOrEntry.createEntry
    : () => optionsOrEntry;

  return withTxLock(txHash, async () => {
    const allocation = await inspectAllocation(txHash, expenseId, member);

    if (allocation.existing) {
      if (BigInt(allocation.existing.amountStroops) !== claimedAmount) {
        return {
          success: false,
          reason: "AMOUNT_MISMATCH",
          allocatedStroops: allocation.allocatedStroops,
          remainingStroops: totalPayment - allocation.allocatedStroops,
        };
      }
      return {
        success: true,
        entry: allocation.existing,
        reused: true,
      };
    }

    const remaining = totalPayment - allocation.allocatedStroops;
    if (claimedAmount > remaining) {
      return {
        success: false,
        reason: "INSUFFICIENT_FUNDS",
        allocatedStroops: allocation.allocatedStroops,
        remainingStroops: remaining,
      };
    }

    const entryToCommit = await getEntry();
    const stored = await commitAttestation(entryToCommit);

    return {
      success: true,
      entry: stored,
      reused: stored.nonce !== entryToCommit.nonce,
    };
  });
}

/** Test seam: drops the in-memory ledger and active locks. Has no effect on the Supabase table. */
export function resetMemoryLedger(): void {
  memoryLedger.clear();
  txLocks.clear();
}
