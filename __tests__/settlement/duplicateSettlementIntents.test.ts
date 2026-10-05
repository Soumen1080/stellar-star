/**
 * duplicateSettlementIntents.test.ts
 *
 * Verifies Issue #253: Duplicate settlement intents are prevented when the same
 * payment is re-synced after a network retry or webhook event re-processing.
 *
 * Enforces:
 * 1. Deterministic idempotency key: txHash + expenseId + memberId + assetCode.
 * 2. Uniqueness at the database level and an idempotent upsert path.
 * 3. Exact reconciliation without duplicate intent rows in the settlement ledger.
 */

import {
  deriveIdempotencyKey,
  derivePaymentIdempotencyKey,
  acquireSettlementIntent,
  upsertSettlementIntent,
  markIntentSubmitted,
  markIntentRecorded,
  type SettlementIntent,
} from "@/lib/settlement/intent";
import { POST as reconcileRoute } from "@/app/api/settlement/reconcile/route";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { checkIsPaid } from "@/lib/stellar/contract";
import * as dbQueries from "@/lib/supabase/queries";
import { NextRequest } from "next/server";

jest.mock("@/lib/settlement/horizonVerify");
jest.mock("@/lib/stellar/contract");
jest.mock("@/lib/supabase/queries");

const WALLET_ALICE = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_PAYER = "GAPAYERCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TX_HASH_1    = "a".repeat(64);
const TX_HASH_2    = "b".repeat(64);

describe("Issue #253: Duplicate Settlement Intents Prevention & Idempotency", () => {
  let mockIntentsDb: Map<string, any>;
  let mockExpensesDb: Map<string, any>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIntentsDb = new Map();
    mockExpensesDb = new Map();

    // Mock rowToSettlementIntent
    jest.mocked(dbQueries.rowToSettlementIntent).mockImplementation((row: any) => {
      if (!row) return null as any;
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key ?? row.idempotencyKey,
        requestId: row.request_id ?? row.requestId,
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

    jest.mocked(dbQueries.createSettlementIntentRow).mockImplementation(async (payload: any) => {
      const id = `intent-${Date.now()}-${Math.random()}`;
      const record = {
        id,
        idempotency_key: payload.idempotency_key,
        request_id: payload.request_id,
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

    jest.mocked(dbQueries.upsertSettlementIntentRow).mockImplementation(async (payload: any) => {
      const existing = mockIntentsDb.get(payload.idempotency_key);
      if (existing) {
        const updated = {
          ...existing,
          ...payload,
          updated_at: new Date().toISOString(),
        };
        mockIntentsDb.set(payload.idempotency_key, updated);
        return dbQueries.rowToSettlementIntent(updated as any);
      }
      return dbQueries.createSettlementIntentRow(payload);
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

    jest.mocked(dbQueries.fetchSettlementIntentByTxHash).mockImplementation(async (txHash: string) => {
      for (const row of mockIntentsDb.values()) {
        if (row.tx_hash === txHash) {
          return dbQueries.rowToSettlementIntent(row as any);
        }
      }
      return null;
    });

    jest.mocked(dbQueries.fetchSettlementIntentByPayment).mockImplementation(
      async (txHash: string, expenseId: string, memberId: string) => {
        for (const row of mockIntentsDb.values()) {
          if (row.tx_hash === txHash && row.expense_id === expenseId && row.member_id === memberId) {
            return dbQueries.rowToSettlementIntent(row as any);
          }
        }
        return null;
      },
    );

    jest.mocked(dbQueries.markSharePaidRow).mockImplementation(
      async (expenseId: string, memberId: string, txHash: string) => {
        mockExpensesDb.set(`${expenseId}:${memberId}`, { paid: true, txHash });
        return {} as any;
      },
    );

    jest.mocked(verifyPaymentByHash).mockResolvedValue({
      source: WALLET_ALICE,
      destination: WALLET_PAYER,
      amountStroops: 50000000n, // 5 XLM
      ledger: 12345,
      closedAt: new Date().toISOString(),
      memo: "Trip|Alice",
      viaPath: false,
    });

    jest.mocked(checkIsPaid).mockResolvedValue({ paid: true, success: true });
  });

  describe("Deterministic Idempotency Key Derivation", () => {
    it("derives deterministic key with txHash + expenseId + memberId + assetCode", () => {
      const key1 = derivePaymentIdempotencyKey(TX_HASH_1, "exp-100", "alice-1", "XLM");
      const key2 = deriveIdempotencyKey("trip-1", "exp-100", "alice-1", TX_HASH_1, "XLM");
      const key3 = deriveIdempotencyKey({
        txHash: TX_HASH_1.toUpperCase(), // case-insensitivity
        expenseId: "exp-100",
        memberId: "alice-1",
        assetCode: "xlm",
      });

      expect(key1).toBe(`settle:${TX_HASH_1}:exp-100:alice-1:XLM`);
      expect(key2).toBe(key1);
      expect(key3).toBe(key1);
    });

    it("falls back to tripId:expenseId:memberId when txHash is not yet available", () => {
      const preSubmitKey = deriveIdempotencyKey("trip-1", "exp-100", "alice-1");
      expect(preSubmitKey).toBe("settle:trip-1:exp-100:alice-1");
    });

    it("differentiates different assets for the same transaction and member", () => {
      const xlmKey = derivePaymentIdempotencyKey(TX_HASH_1, "exp-100", "alice-1", "XLM");
      const usdcKey = derivePaymentIdempotencyKey(TX_HASH_1, "exp-100", "alice-1", "USDC");
      expect(xlmKey).not.toBe(usdcKey);
    });
  });

  describe("Upsert Path & Duplicate Prevention on Network Retries", () => {
    it("re-syncing the same payment through upsertSettlementIntent creates exactly 1 intent row", async () => {
      const params = {
        tripId: "trip-retry",
        expenseId: "exp-retry",
        memberId: "alice-1",
        payerWallet: WALLET_PAYER,
        memberWallet: WALLET_ALICE,
        amount: "5.0",
        currency: "XLM",
        txHash: TX_HASH_1,
        ledger: 12345,
      };

      // First sync (e.g. client submit)
      const intent1 = await upsertSettlementIntent(params);
      expect(intent1.txHash).toBe(TX_HASH_1);
      expect(mockIntentsDb.size).toBe(1);

      // Second sync (e.g. network retry after drop)
      const intent2 = await upsertSettlementIntent(params);
      expect(intent2.id).toBe(intent1.id);
      expect(mockIntentsDb.size).toBe(1); // STILL exactly 1 row

      // Third sync (e.g. background webhook event)
      const intent3 = await upsertSettlementIntent({
        ...params,
        status: "recorded",
        onChain: true,
      });
      expect(intent3.id).toBe(intent1.id);
      expect(intent3.status).toBe("recorded");
      expect(mockIntentsDb.size).toBe(1); // ZERO duplicate rows
    });

    it("acquireSettlementIntent with txHash identifies existing submitted payment and prevents duplicate transfer", async () => {
      // 1. Initial intent
      const acquire1 = await acquireSettlementIntent({
        tripId: "trip-1",
        expenseId: "exp-1",
        memberId: "alice-1",
        payerWallet: WALLET_PAYER,
        memberWallet: WALLET_ALICE,
        amount: "5.0",
        currency: "XLM",
      });
      expect(acquire1.ok).toBe(true);
      if (!acquire1.ok) return;

      // 2. Marked submitted on Horizon
      await markIntentSubmitted(acquire1.intent.id, TX_HASH_1, 100);

      // 3. Client retries with known txHash
      const acquire2 = await acquireSettlementIntent({
        tripId: "trip-1",
        expenseId: "exp-1",
        memberId: "alice-1",
        payerWallet: WALLET_PAYER,
        memberWallet: WALLET_ALICE,
        amount: "5.0",
        currency: "XLM",
        txHash: TX_HASH_1,
      });

      expect(acquire2.ok).toBe(false);
      if (acquire2.ok) return;
      expect(acquire2.code).toBe("SUBMITTED_NEEDS_RECONCILIATION");
      expect(acquire2.intent.txHash).toBe(TX_HASH_1);
      expect(mockIntentsDb.size).toBe(1);
    });
  });

  describe("API Route: POST /api/settlement/reconcile", () => {
    it("reconciles payment and returns duplicate: true on subsequent webhook/retry calls", async () => {
      const payload = {
        txHash: TX_HASH_1,
        expenseId: "exp-api",
        memberId: "alice-1",
        payerWallet: WALLET_PAYER,
        memberWallet: WALLET_ALICE,
        amount: "5.0",
        assetCode: "XLM",
        tripId: "trip-api",
      };

      // Call 1: Reconcile new payment
      const req1 = new NextRequest("http://localhost:3000/api/settlement/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const res1 = await reconcileRoute(req1);
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(data1.ok).toBe(true);
      expect(data1.reconciled).toBe(true);
      expect(data1.intent.status).toBe("recorded");
      expect(mockIntentsDb.size).toBe(1);

      // Verify share marked paid
      expect(mockExpensesDb.get("exp-api:alice-1")?.paid).toBe(true);

      // Call 2: Network retry or webhook re-processing with same payment
      const req2 = new NextRequest("http://localhost:3000/api/settlement/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const res2 = await reconcileRoute(req2);
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.ok).toBe(true);
      expect(data2.duplicate).toBe(true);
      expect(data2.intent.id).toBe(data1.intent.id);
      expect(mockIntentsDb.size).toBe(1); // STRICTLY 1 row, no duplicates
    });

    it("rejects malformed requests missing required fields", async () => {
      const req = new NextRequest("http://localhost:3000/api/settlement/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: "short" }),
      });

      const res = await reconcileRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Missing or malformed");
    });
  });
});
