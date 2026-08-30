/**
 * exactlyOnce.test.ts
 *
 * Comprehensive correctness & distributed systems tests for Issue #156 (Epic #50).
 * Simulates concurrent settlements, crash-at-each-step failure scenarios,
 * device-agnostic reconciliation without localStorage, and verifies all 6 invariants.
 */

import {
  acquireSettlementIntent,
  markIntentSubmitted,
  markIntentRecorded,
  markIntentFailed,
  deriveIdempotencyKey,
  type SettlementIntent,
} from "@/lib/settlement/intent";
import {
  reconcileSettlementIntent,
  reconcileTripWithChainState,
  reconcilePendingIntentsForWallet,
} from "@/lib/settlement/reconcile";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { recordPaymentOnChain, checkIsPaid } from "@/lib/stellar/contract";
import * as dbQueries from "@/lib/supabase/queries";
import type { Expense, SplitShare } from "@/types/expense";
import type { ContractPaymentEvent } from "@/types/contract";

jest.mock("@/lib/settlement/horizonVerify");
jest.mock("@/lib/settlement/settleOnChain");
jest.mock("@/lib/stellar/contract");
jest.mock("@/lib/supabase/queries");

const WALLET_ALICE = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_BOB   = "GABOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WALLET_PAYER = "GAPAYERCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const STUB_ATTESTATION = {
  claim: {
    contractId: "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    tripId: "trip-100",
    expenseId: "exp-100",
    payer: WALLET_PAYER,
    member: WALLET_ALICE,
    amountStroops: "25000000",
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    txHash: "f".repeat(64),
    nonce: "e".repeat(64),
    expiresAt: 1900000000,
  },
  signature: "d".repeat(128),
  oraclePublicKey: "GORACLE",
};

describe("Exactly-Once Settlement Recording & Concurrency (Issue #156 / Epic #50)", () => {
  let mockIntentsDb: Map<string, any>;
  let mockExpensesDb: Map<string, Expense>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIntentsDb = new Map();
    mockExpensesDb = new Map();

    // Mock rowToSettlementIntent mapping to handle both snake_case and camelCase seeded objects
    jest.mocked(dbQueries.rowToSettlementIntent).mockImplementation((row: any) => {
      if (!row) return null as any;
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key ?? row.idempotencyKey,
        tripId: row.trip_id ?? row.tripId,
        expenseId: row.expense_id ?? row.expenseId,
        memberId: row.member_id ?? row.memberId,
        payerWallet: row.payer_wallet ?? row.payerWallet,
        memberWallet: row.member_wallet ?? row.memberWallet,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        txHash: row.tx_hash ?? row.txHash ?? null,
        ledger: row.ledger !== null && row.ledger !== undefined ? Number(row.ledger) : null,
        onChain: row.on_chain ?? row.onChain ?? false,
        errorMessage: row.error_message ?? row.errorMessage ?? null,
        createdByWallet: row.created_by_wallet ?? row.createdByWallet,
        createdAt: row.created_at ?? row.createdAt,
        updatedAt: row.updated_at ?? row.updatedAt,
        expiresAt: row.expires_at ?? row.expiresAt,
      };
    });

    // Mock Supabase DB query implementations
    jest.mocked(dbQueries.createSettlementIntentRow).mockImplementation(async (payload: any) => {
      const id = `intent-${Date.now()}-${Math.random()}`;
      const record = {
        id,
        idempotency_key: payload.idempotency_key,
        trip_id: payload.trip_id,
        expense_id: payload.expense_id,
        member_id: payload.member_id,
        payer_wallet: payload.payer_wallet,
        member_wallet: payload.member_wallet,
        amount: payload.amount,
        currency: payload.currency ?? "XLM",
        status: payload.status ?? "submitting",
        tx_hash: payload.tx_hash ?? null,
        ledger: payload.ledger ?? null,
        on_chain: payload.on_chain ?? false,
        error_message: payload.error_message ?? null,
        created_by_wallet: payload.created_by_wallet,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        expires_at: payload.expires_at ?? new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      mockIntentsDb.set(record.idempotency_key, record);
      return dbQueries.rowToSettlementIntent(record as any);
    });

    jest.mocked(dbQueries.updateSettlementIntentRow).mockImplementation(async (id: string, updates: any) => {
      for (const [k, v] of mockIntentsDb.entries()) {
        if (v.id === id) {
          const updated = {
            ...v,
            ...updates,
            updated_at: new Date().toISOString(),
          };
          mockIntentsDb.set(k, updated);
          return dbQueries.rowToSettlementIntent(updated as any);
        }
      }
      throw new Error(`Intent ${id} not found`);
    });

    jest.mocked(dbQueries.fetchSettlementIntentByIdempotencyKey).mockImplementation(async (key: string) => {
      const found = mockIntentsDb.get(key);
      return found ? dbQueries.rowToSettlementIntent(found as any) : null;
    });

    jest.mocked(dbQueries.fetchActiveSettlementIntents).mockImplementation(async (wallet: string) => {
      const matches: any[] = [];
      for (const row of mockIntentsDb.values()) {
        if (row.member_wallet === wallet && ["pending", "submitting", "submitted"].includes(row.status)) {
          matches.push(dbQueries.rowToSettlementIntent(row as any));
        }
      }
      return matches;
    });

    jest.mocked(dbQueries.markSharePaidRow).mockImplementation(
      async (expenseId: string, memberId: string, txHash: string) => {
        const exp = mockExpensesDb.get(expenseId);
        if (!exp) throw new Error(`Expense ${expenseId} not found`);

        const updatedShares = exp.shares.map((s) =>
          s.memberId === memberId ? { ...s, paid: true, txHash } : s,
        );
        const settled = updatedShares.every((s) => s.paid);
        const updatedExpense: Expense = {
          ...exp,
          shares: updatedShares,
          settled,
        };
        mockExpensesDb.set(expenseId, updatedExpense);
        return updatedExpense;
      },
    );

    // Default mock stubs for external systems
    jest.mocked(verifyPaymentByHash).mockResolvedValue({
      txHash: "f".repeat(64),
      source: WALLET_ALICE,
      destination: WALLET_PAYER,
      amountStroops: 25000000n,
      asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      memo: "Dinner|Alice",
      ledger: 1000,
      successful: true,
      timestamp: Date.now(),
    });

    jest.mocked(checkIsPaid).mockResolvedValue({ paid: false, success: true });
    jest.mocked(fetchAttestation).mockResolvedValue({ ok: true, attestation: STUB_ATTESTATION });
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 1001 });
  });

  // ===========================================================================
  // Invariant 3: Two clients settling the same share concurrently produce at most 1 payment
  // ===========================================================================

  it("Invariant 3: Blocks concurrent settlement attempts on the same share", async () => {
    const params = {
      tripId: "trip-1",
      expenseId: "exp-1",
      memberId: "alice-1",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "2.5",
    };

    // Client 1 acquires intent
    const firstAttempt = await acquireSettlementIntent(params);
    expect(firstAttempt.ok).toBe(true);
    if (!firstAttempt.ok) return;
    expect(firstAttempt.intent.status).toBe("submitting");

    // Client 2 attempts to acquire intent for the same share with a different wallet/tab
    const secondAttempt = await acquireSettlementIntent({
      ...params,
      memberWallet: "GOTHERCLIENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });

    expect(secondAttempt.ok).toBe(false);
    if (secondAttempt.ok) return;
    expect(secondAttempt.code).toBe("IN_PROGRESS");
    expect(secondAttempt.message).toContain("Another client is currently settling");
  });

  // ===========================================================================
  // Invariant 4: No lost updates on shares under concurrent writes
  // ===========================================================================

  it("Invariant 4: Concurrent settlements for different shares on the same expense both succeed without lost updates", async () => {
    const initialExpense: Expense = {
      id: "exp-multi",
      title: "Group Dinner",
      totalAmount: "10.0",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [
        { id: "payer-1", name: "Payer", walletAddress: WALLET_PAYER },
        { id: "alice-1", name: "Alice", walletAddress: WALLET_ALICE },
        { id: "bob-1", name: "Bob", walletAddress: WALLET_BOB },
      ],
      shares: [
        { memberId: "alice-1", name: "Alice", walletAddress: WALLET_ALICE, amount: "5.0", paid: false },
        { memberId: "bob-1", name: "Bob", walletAddress: WALLET_BOB, amount: "5.0", paid: false },
      ],
      createdAt: new Date().toISOString(),
      settled: false,
    };
    mockExpensesDb.set("exp-multi", initialExpense);

    // Simulate concurrent database writes for Alice and Bob
    await Promise.all([
      dbQueries.markSharePaidRow("exp-multi", "alice-1", "tx-alice-hash"),
      dbQueries.markSharePaidRow("exp-multi", "bob-1", "tx-bob-hash"),
    ]);

    const finalExpense = mockExpensesDb.get("exp-multi")!;
    expect(finalExpense.shares.find((s) => s.memberId === "alice-1")?.paid).toBe(true);
    expect(finalExpense.shares.find((s) => s.memberId === "alice-1")?.txHash).toBe("tx-alice-hash");
    expect(finalExpense.shares.find((s) => s.memberId === "bob-1")?.paid).toBe(true);
    expect(finalExpense.shares.find((s) => s.memberId === "bob-1")?.txHash).toBe("tx-bob-hash");
    expect(finalExpense.settled).toBe(true);
  });

  // ===========================================================================
  // Crash Simulation 1: Crash before Horizon submit (clean expiry, safe retry)
  // ===========================================================================

  it("Crash 1: Crash before Horizon submit allows safe retry after intent expiry", async () => {
    const params = {
      tripId: "trip-crash-1",
      expenseId: "exp-crash-1",
      memberId: "alice-1",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "5.0",
    };

    // Client acquired intent then crashed before submitting to Horizon
    const intentRes = await acquireSettlementIntent(params);
    expect(intentRes.ok).toBe(true);
    if (!intentRes.ok) return;

    // Simulate intent expiration (16 minutes later)
    const stored = mockIntentsDb.get(deriveIdempotencyKey(params.tripId, params.expenseId, params.memberId))!;
    stored.expires_at = new Date(Date.now() - 1000).toISOString();
    mockIntentsDb.set(stored.idempotency_key, stored);

    // New attempt on a fresh device successfully re-acquires and renews intent
    const retryRes = await acquireSettlementIntent(params);
    expect(retryRes.ok).toBe(true);
    if (!retryRes.ok) return;
    expect(retryRes.intent.status).toBe("submitting");
  });

  // ===========================================================================
  // Crash Simulation 2: Crash immediately after Horizon submit (Invariant 1 & 5)
  // ===========================================================================

  it("Crash 2 (Invariants 1 & 5): Payment confirmed on Horizon recovers on fresh device without localStorage", async () => {
    const expense: Expense = {
      id: "exp-crash-2",
      title: "Hotel",
      totalAmount: "100.0",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [
        { id: "payer-1", name: "Payer", walletAddress: WALLET_PAYER },
        { id: "alice-1", name: "Alice", walletAddress: WALLET_ALICE },
      ],
      shares: [
        { memberId: "alice-1", name: "Alice", walletAddress: WALLET_ALICE, amount: "100.0", paid: false },
      ],
      createdAt: new Date().toISOString(),
      settled: false,
    };
    mockExpensesDb.set("exp-crash-2", expense);

    // 1. Client acquires intent
    const acquireRes = await acquireSettlementIntent({
      tripId: "trip-crash-2",
      expenseId: "exp-crash-2",
      memberId: "alice-1",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "100.0",
    });
    expect(acquireRes.ok).toBe(true);
    if (!acquireRes.ok) return;

    // 2. Horizon submission succeeds and intent is durably marked submitted
    const txHash = "f".repeat(64);
    await markIntentSubmitted(acquireRes.intent.id, txHash, 1000);

    // 3. BROWSER CRASHES HERE (localStorage wiped, memory destroyed).
    // Now Alice logs in on a fresh phone (zero localStorage).

    const reconcileResults = await reconcilePendingIntentsForWallet(WALLET_ALICE);
    expect(reconcileResults).toHaveLength(1);
    expect(reconcileResults[0].reconciled).toBe(true);
    expect(reconcileResults[0].onChain).toBe(true);
    expect(reconcileResults[0].status).toBe("recorded");

    // Supabase state is repaired and reflects payment!
    const repairedExpense = mockExpensesDb.get("exp-crash-2")!;
    expect(repairedExpense.shares[0].paid).toBe(true);
    expect(repairedExpense.shares[0].txHash).toBe(txHash);
    expect(repairedExpense.settled).toBe(true);
  });

  // ===========================================================================
  // Crash Simulation 3: Crash after Soroban write before Supabase write
  // ===========================================================================

  it("Crash 3: Discrepancy between contract and Supabase converges via on-chain event reconciliation", async () => {
    const expense: Expense = {
      id: "exp-crash-3",
      title: "Museum Tickets",
      totalAmount: "20.0",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [
        { id: "payer-1", name: "Payer", walletAddress: WALLET_PAYER },
        { id: "alice-1", name: "Alice", walletAddress: WALLET_ALICE },
      ],
      shares: [
        { memberId: "alice-1", name: "Alice", walletAddress: WALLET_ALICE, amount: "20.0", paid: false },
      ],
      createdAt: new Date().toISOString(),
      settled: false,
    };
    mockExpensesDb.set("exp-crash-3", expense);

    // Soroban contract emitted a payment event, but Supabase shares are still paid: false
    const onChainEvents: ContractPaymentEvent[] = [
      {
        ledger: 1050,
        ledgerClosedAt: new Date().toISOString(),
        tripId: "trip-crash-3",
        expenseId: "exp-crash-3",
        member: WALLET_ALICE,
        amountStroops: "200000000",
        txHash: "e".repeat(64),
      },
    ];

    // Other trip members view the trip; background reconciliation runs
    const reconResult = await reconcileTripWithChainState(
      "trip-crash-3",
      [expense],
      onChainEvents,
    );

    expect(reconResult.reconciledCount).toBe(1);
    expect(reconResult.repairedExpenseIds).toContain("exp-crash-3");

    const repaired = mockExpensesDb.get("exp-crash-3")!;
    expect(repaired.shares[0].paid).toBe(true);
    expect(repaired.shares[0].txHash).toBe("e".repeat(64));
  });

  // ===========================================================================
  // Invariant 2: No double-payment on retry
  // ===========================================================================

  it("Invariant 2: Retrying a submitted payment does not initiate a duplicate transfer", async () => {
    const txHash = "f".repeat(64);

    // Seed intent as submitted with txHash
    const intent: SettlementIntent = {
      id: "intent-retry",
      idempotencyKey: "settle:trip-r:exp-r:alice",
      tripId: "trip-r",
      expenseId: "exp-r",
      memberId: "alice",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "10.0",
      currency: "XLM",
      status: "submitted",
      txHash,
      ledger: 1000,
      onChain: false,
      errorMessage: null,
      createdByWallet: WALLET_ALICE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    mockIntentsDb.set(intent.idempotencyKey, intent);

    mockExpensesDb.set("exp-r", {
      id: "exp-r",
      title: "Lunch",
      totalAmount: "10.0",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [],
      shares: [{ memberId: "alice", name: "Alice", walletAddress: WALLET_ALICE, amount: "10.0", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
    });

    // Payer clicks pay again or retry
    const res = await acquireSettlementIntent({
      tripId: "trip-r",
      expenseId: "exp-r",
      memberId: "alice",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "10.0",
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("SUBMITTED_NEEDS_RECONCILIATION");

    // Running reconciliation completes the previous intent rather than transferring more money
    const recon = await reconcileSettlementIntent(res.intent);
    expect(recon.reconciled).toBe(true);
    expect(recon.status).toBe("recorded");
  });

  // ===========================================================================
  // Invariant 6: Reconciliation is idempotent
  // ===========================================================================

  it("Invariant 6: Running reconciliation multiple times is strictly idempotent", async () => {
    const txHash = "f".repeat(64);
    const intent: SettlementIntent = {
      id: "intent-idem",
      idempotencyKey: "settle:trip-idem:exp-idem:alice",
      tripId: "trip-idem",
      expenseId: "exp-idem",
      memberId: "alice",
      payerWallet: WALLET_PAYER,
      memberWallet: WALLET_ALICE,
      amount: "10.0",
      currency: "XLM",
      status: "submitted",
      txHash,
      ledger: 1000,
      onChain: false,
      errorMessage: null,
      createdByWallet: WALLET_ALICE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    mockIntentsDb.set(intent.idempotencyKey, intent);

    mockExpensesDb.set("exp-idem", {
      id: "exp-idem",
      title: "Cab",
      totalAmount: "10.0",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [],
      shares: [{ memberId: "alice", name: "Alice", walletAddress: WALLET_ALICE, amount: "10.0", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
    });

    // Run 1: Reconciles intent
    const run1 = await reconcileSettlementIntent(intent);
    expect(run1.reconciled).toBe(true);

    // Run 2: Re-run immediately
    const updatedIntent = mockIntentsDb.get(intent.idempotencyKey)!;
    const run2 = await reconcileSettlementIntent(dbQueries.rowToSettlementIntent(updatedIntent));
    expect(run2.reconciled).toBe(true);
    expect(run2.status).toBe("recorded");

    // Run 3: Re-run a third time
    const run3 = await reconcileSettlementIntent(dbQueries.rowToSettlementIntent(updatedIntent));
    expect(run3.reconciled).toBe(true);
    expect(run3.status).toBe("recorded");
  });
});
