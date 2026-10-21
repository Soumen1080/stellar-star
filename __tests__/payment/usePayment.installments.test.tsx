/** @jest-environment jsdom */
/**
 * usePayment.installments.test.tsx — partial settlement integration (#325).
 *
 * Runs the real payment hook, intent store, installment rules and
 * reconciliation engine against an in-memory database that enforces the
 * idempotency key's UNIQUE constraint and the installment RPC's remaining-
 * balance check. Only the network edges (Horizon, wallet, contract, oracle)
 * are stubbed.
 *
 * Covers:
 *  - installments accumulate exactly and only the last one settles the share
 *  - overpayment is refused before anything is signed
 *  - two concurrent attempts at the same installment move money once
 *  - retry after a submit that crashed before recording reconciles the
 *    existing transaction instead of paying again, and never double-counts
 */

const { act, renderHook } = require("@testing-library/react");

jest.mock("@/lib/stellar/buildTransaction");
jest.mock("@/lib/stellar/submitTransaction");
jest.mock("@/lib/stellar/contract");
jest.mock("@/lib/settlement/settleOnChain");
jest.mock("@/lib/settlement/horizonVerify");
jest.mock("@/lib/supabase/queries");
jest.mock("@/lib/freighter");
jest.mock("@/hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/components/ui/Toast", () => ({ useToast: jest.fn() }));

import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  checkIsPaid,
  precheckPoolBalance,
  recordPaymentOnChain,
  getPoolBalanceStroops,
} from "@/lib/stellar/contract";
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { signXDR } from "@/lib/freighter";
import * as db from "@/lib/supabase/queries";
import type { Expense, SplitShare } from "@/types/expense";

const { applyInstallment, shareBalance } = jest.requireActual(
  "@/lib/settlement/installments",
) as typeof import("@/lib/settlement/installments");

const WALLET_BOB = "GBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAYER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const EXPENSE_ID = "exp-1";
const TRIP_ID = "trip-1";

const bobShare: SplitShare = {
  memberId: "bob",
  name: "Bob",
  walletAddress: WALLET_BOB,
  amount: "10.0000000",
  paid: false,
};

describe("usePayment — partial share settlement (#325)", () => {
  const { usePayment } = require("@/hooks/usePayment") as typeof import("@/hooks/usePayment");

  const mockedUseWallet = (jest.requireMock("@/hooks/useWallet") as { useWallet: jest.Mock }).useWallet;
  const mockedUseExpense = (jest.requireMock("@/hooks/useExpense") as { useExpense: jest.Mock }).useExpense;
  const mockedUseToast = (jest.requireMock("@/components/ui/Toast") as { useToast: jest.Mock }).useToast;

  const toastError = jest.fn();
  const toastSuccess = jest.fn();
  const toastInfo = jest.fn();

  let intents: Map<string, any>;
  let expenses: Map<string, Expense>;
  let txCounter: number;
  /** Transactions Horizon knows about: hash -> stroops sent. */
  let horizon: Map<string, bigint>;
  let failNextInstallmentWrite: boolean;

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function storedShare(): SplitShare {
    return expenses.get(EXPENSE_ID)!.shares.find((s) => s.memberId === "bob")!;
  }

  /** The `record_share_installment` RPC: locked, exact, idempotent on txHash. */
  async function recordInstallment(expenseId: string, memberId: string, installment: any): Promise<Expense> {
    if (failNextInstallmentWrite) {
      failNextInstallmentWrite = false;
      throw new Error("network dropped before the installment was recorded");
    }
    const expense = expenses.get(expenseId)!;
    const target = expense.shares.find((s) => s.memberId === memberId)!;
    const applied = applyInstallment(target, installment);
    if (!applied.ok) throw new Error(applied.message);
    const shares = expense.shares.map((s) => (s.memberId === memberId ? applied.share : s));
    const next = { ...expense, shares, settled: shares.every((s) => s.paid) };
    expenses.set(expenseId, next);
    return next;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();

    intents = new Map();
    txCounter = 0;
    horizon = new Map();
    failNextInstallmentWrite = false;
    expenses = new Map([
      [
        EXPENSE_ID,
        {
          id: EXPENSE_ID,
          title: "Dinner",
          totalAmount: "20.0000000",
          currency: "XLM",
          settlementAsset: "native",
          splitMode: "equal",
          paidByMemberId: "alice",
          members: [
            { id: "alice", name: "Alice", walletAddress: PAYER },
            { id: "bob", name: "Bob", walletAddress: WALLET_BOB },
          ],
          shares: [
            { memberId: "alice", name: "Alice", walletAddress: PAYER, amount: "10.0000000", paid: true },
            { ...bobShare },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          settled: false,
        },
      ],
    ]);

    mockedUseWallet.mockReturnValue({ publicKey: WALLET_BOB, refreshBalance: jest.fn() });
    mockedUseToast.mockReturnValue({ success: toastSuccess, error: toastError, info: toastInfo });
    mockedUseExpense.mockReturnValue({
      markSharePaid: jest.fn(async () => {}),
      recordShareInstallment: jest.fn(recordInstallment),
    });

    // ── In-memory settlement_intents with a UNIQUE idempotency_key ──────────
    const toIntent = (row: any) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      requestId: row.request_id,
      tripId: row.trip_id,
      expenseId: row.expense_id,
      memberId: row.member_id,
      payerWallet: row.payer_wallet,
      memberWallet: row.member_wallet,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      txHash: row.tx_hash ?? null,
      ledger: row.ledger ?? null,
      onChain: row.on_chain ?? false,
      errorMessage: row.error_message ?? null,
      createdByWallet: row.created_by_wallet,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    });

    jest.mocked(db.fetchSettlementIntentByIdempotencyKey).mockImplementation(async (key: string) => {
      await tick();
      const row = intents.get(key);
      return row ? toIntent(row) : null;
    });
    jest.mocked(db.fetchSettlementIntentByPayment).mockImplementation(async (txHash: string, exp: string, mem: string) => {
      for (const row of intents.values()) {
        if (row.tx_hash === txHash && row.expense_id === exp && row.member_id === mem) return toIntent(row);
      }
      return null;
    });
    jest.mocked(db.createSettlementIntentRow).mockImplementation(async (payload: any) => {
      await tick();
      if (intents.has(payload.idempotency_key)) {
        throw Object.assign(Object.create(db.DatabaseError.prototype), {
          message: "That record already exists.",
          code: "23505",
        });
      }
      const now = new Date().toISOString();
      const row = {
        id: `intent-${intents.size + 1}`,
        status: "submitting",
        on_chain: false,
        created_at: now,
        updated_at: now,
        ...payload,
      };
      intents.set(payload.idempotency_key, row);
      return toIntent(row);
    });
    jest.mocked(db.updateSettlementIntentRow).mockImplementation(async (id: string, updates: any) => {
      for (const [key, row] of intents.entries()) {
        if (row.id === id) {
          const next = { ...row, ...updates };
          intents.set(key, next);
          return toIntent(next);
        }
      }
      throw new Error(`intent ${id} not found`);
    });
    jest.mocked(db.fetchActiveSettlementIntents).mockResolvedValue([]);
    jest.mocked(db.fetchExpenseById).mockImplementation(async (id: string) => expenses.get(id) ?? null);
    jest.mocked(db.recordShareInstallmentRow).mockImplementation(recordInstallment);
    jest.mocked(db.updateInstallmentProofRow).mockResolvedValue(null);

    // ── Network edges ────────────────────────────────────────────────────────
    jest.mocked(buildPaymentTransaction).mockImplementation(async ({ amount }: any) => ({
      xdr: `unsigned:${amount}`,
      memo: "memo",
    }));
    jest.mocked(signXDR).mockImplementation(async (xdr: string) => `signed:${xdr}`);
    jest.mocked(submitSignedTransaction).mockImplementation(async (signed: string) => {
      txCounter++;
      const hash = txCounter.toString(16).padStart(64, "0");
      const amount = signed.split(":").pop()!;
      const [whole, fraction = ""] = amount.split(".");
      horizon.set(hash, BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0")));
      return { hash, ledger: 100 + txCounter, successful: true };
    });
    jest.mocked(verifyPaymentByHash).mockImplementation(async (hash: string) => ({
      source: WALLET_BOB,
      destination: PAYER,
      amountStroops: horizon.get(hash) ?? 0n,
      ledger: 100,
      closedAt: new Date().toISOString(),
      memo: "memo",
      viaPath: false,
    }));
    jest.mocked(checkIsPaid).mockResolvedValue({ paid: false, success: true });
    jest.mocked(precheckPoolBalance).mockResolvedValue({
      ok: true,
      requiredStroops: 0n,
      balanceStroops: 1_000_000_000n,
    });
    jest.mocked(getPoolBalanceStroops).mockResolvedValue(1_000_000_000n);
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 200 });
    jest.mocked(fetchAttestation).mockImplementation(async (claim: any) => ({
      ok: true,
      attestation: {
        claim: { ...claim, nonce: `nonce-${claim.expenseId}`, expiresAt: 1900000000 },
        signatures: [{ signer: "GORACLE", signature: "sig" }],
      },
    }));
  });

  async function payInstallment(result: any, amount?: string) {
    await act(async () => {
      await result.current.payShare({
        share: storedShare(),
        expenseTitle: "Dinner",
        payerWalletAddress: PAYER,
        tripId: TRIP_ID,
        amount,
      });
    });
  }

  it("records each installment against its own transaction and settles only at zero", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    await payInstallment(result, "2.5");
    expect(shareBalance(storedShare())).toMatchObject({ paid: "2.5000000", remaining: "7.5000000", fullySettled: false });
    expect(storedShare().paid).toBe(false);
    expect(expenses.get(EXPENSE_ID)!.settled).toBe(false);

    await payInstallment(result, "4");
    expect(shareBalance(storedShare()).remaining).toBe("3.5000000");

    // Omitting the amount pays the rest.
    await payInstallment(result);
    const settled = storedShare();
    expect(settled.paid).toBe(true);
    expect(shareBalance(settled).remainingStroops).toBe(0n);
    expect(expenses.get(EXPENSE_ID)!.settled).toBe(true);

    expect(settled.installments).toHaveLength(3);
    expect(settled.installments!.map((i) => [i.seq, i.amount, i.claimId])).toEqual([
      [1, "2.5000000", "exp-1#1"],
      [2, "4.0000000", "exp-1#2"],
      [3, "3.5000000", "exp-1#3"],
    ]);
    // Each installment is independently attested and recorded under its claim id.
    for (const installment of settled.installments!) {
      expect(installment.verified).toBe(true);
      expect(installment.onChain).toBe(true);
      expect(installment.attestationNonce).toBe(`nonce-${installment.claimId}`);
      expect(fetchAttestation).toHaveBeenCalledWith(
        expect.objectContaining({ expenseId: installment.claimId, amountXlm: installment.amount }),
      );
      expect(recordPaymentOnChain).toHaveBeenCalledWith(
        expect.objectContaining({ expenseId: installment.claimId, txHash: installment.txHash }),
      );
    }
    // The plain expense id is never claimed on-chain by a partial payment.
    expect(fetchAttestation).not.toHaveBeenCalledWith(expect.objectContaining({ expenseId: EXPENSE_ID }));
  });

  it("refuses an overpayment before anything is signed", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));
    await payInstallment(result, "6");

    await payInstallment(result, "4.0000001");

    expect(result.current.paymentState.status).toBe("blocked");
    expect(toastError).toHaveBeenCalledWith("Overpayment not allowed", expect.stringContaining("4.0000000"));
    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
    expect(shareBalance(storedShare()).remaining).toBe("4.0000000");
  });

  it("lets only one of two concurrent attempts at the same installment move money", async () => {
    const tabA = renderHook(() => usePayment({ expenseId: EXPENSE_ID })).result;
    const tabB = renderHook(() => usePayment({ expenseId: EXPENSE_ID })).result;
    const stale = storedShare();

    await act(async () => {
      await Promise.all([
        tabA.current.payShare({ share: stale, expenseTitle: "Dinner", payerWalletAddress: PAYER, tripId: TRIP_ID, amount: "6" }),
        tabB.current.payShare({ share: stale, expenseTitle: "Dinner", payerWalletAddress: PAYER, tripId: TRIP_ID, amount: "6" }),
      ]);
    });

    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
    const statuses = [tabA.current.paymentState.status, tabB.current.paymentState.status].sort();
    expect(statuses).toEqual(["blocked", "success"]);
    expect(storedShare().installments).toHaveLength(1);
    expect(shareBalance(storedShare()).remaining).toBe("4.0000000");
  });

  it("does not let a one-shot payment race a first installment on the same share", async () => {
    const tabA = renderHook(() => usePayment({ expenseId: EXPENSE_ID })).result;
    const tabB = renderHook(() => usePayment({ expenseId: EXPENSE_ID })).result;
    const stale = storedShare();

    // Hold tab A's one-shot intent in flight while tab B tries a first installment.
    let releaseSign!: () => void;
    jest.mocked(signXDR).mockImplementationOnce(
      (xdr: string) => new Promise((resolve) => (releaseSign = () => resolve(`signed:${xdr}`))),
    );

    let paidA!: Promise<void>;
    await act(async () => {
      paidA = tabA.current.payShare({ share: stale, expenseTitle: "Dinner", payerWalletAddress: PAYER, tripId: TRIP_ID });
      while (!releaseSign) await tick();
      await tabB.current.payShare({ share: stale, expenseTitle: "Dinner", payerWalletAddress: PAYER, tripId: TRIP_ID, amount: "3" });
    });

    expect(tabB.current.paymentState.status).toBe("blocked");

    await act(async () => {
      releaseSign();
      await paidA;
    });
    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("reconciles a submitted installment on retry instead of paying again", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    // The transaction lands on Stellar, then the app loses the write.
    failNextInstallmentWrite = true;
    await payInstallment(result, "3");
    expect(result.current.paymentState.status).toBe("error");
    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
    expect(storedShare().installments ?? []).toHaveLength(0);

    const [intentRow] = [...intents.values()];
    expect(intentRow.status).toBe("submitted");
    expect(intentRow.idempotency_key).toBe("settle:trip-1:exp-1:bob:installment-1");

    // The user taps Pay again with the same amount.
    await payInstallment(result, "3");

    expect(submitSignedTransaction).toHaveBeenCalledTimes(1);
    expect(result.current.paymentState.status).toBe("success");
    const share = storedShare();
    expect(share.installments).toHaveLength(1);
    expect(share.installments![0]).toMatchObject({ seq: 1, amount: "3.0000000", txHash: intentRow.tx_hash });
    expect(shareBalance(share).remaining).toBe("7.0000000");
    expect(share.paid).toBe(false);
    expect([...intents.values()][0].status).toBe("recorded");

    // A second, unrelated reconciliation of the same transaction is a no-op.
    const { reconcileSettlementIntent } = jest.requireActual(
      "@/lib/settlement/reconcile",
    ) as typeof import("@/lib/settlement/reconcile");
    const [recorded] = [...intents.values()];
    await reconcileSettlementIntent({
      ...recorded,
      id: recorded.id,
      idempotencyKey: recorded.idempotency_key,
      requestId: recorded.request_id,
      tripId: recorded.trip_id,
      expenseId: recorded.expense_id,
      memberId: recorded.member_id,
      payerWallet: recorded.payer_wallet,
      memberWallet: recorded.member_wallet,
      txHash: recorded.tx_hash,
      onChain: false,
      status: "submitted",
      expiresAt: recorded.expires_at,
    });
    expect(storedShare().installments).toHaveLength(1);
    expect(shareBalance(storedShare()).remaining).toBe("7.0000000");
  });
});
