import {
  calculateBackoffMs,
  verifyPaymentStrict,
  processReconciliationJob,
  evaluateAlertThresholds,
  rowToReconciliationJob,
  WorkerRateLimiter,
  ALERT_THRESHOLDS,
} from "@/lib/settlement/reconciliationWorker";
import { markSharePaidRow } from "@/lib/supabase/queries";
import { markIntentRecorded, markIntentFailed } from "@/lib/settlement/intent";
import type { ReconciliationJob, ReconciliationSummary } from "@/types/reconciliation";

jest.mock("@/lib/utils/constants", () => {
  const actual = jest.requireActual("@/lib/utils/constants");
  return {
    ...actual,
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    CONTRACT_ID: "contract-test-id",
  };
});

jest.mock("@/lib/supabase/queries", () => ({
  markSharePaidRow: jest.fn().mockResolvedValue(undefined),
  recordShareInstallmentRow: jest.fn().mockResolvedValue(undefined),
  fetchActiveSettlementIntents: jest.fn().mockResolvedValue([]),
  fetchSettlementIntentByTxHash: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/settlement/intent", () => ({
  markIntentRecorded: jest.fn().mockResolvedValue(undefined),
  markIntentFailed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/stellar/contract", () => ({
  checkIsPaid: jest.fn().mockResolvedValue({ paid: true }),
  recordPaymentOnChain: jest.fn().mockResolvedValue({ success: true, ledger: 100 }),
}));

jest.mock("@/lib/settlement/settleOnChain", () => ({
  fetchAttestation: jest.fn().mockResolvedValue({ ok: true, attestation: { claim: { nonce: "nonce-1" } } }),
}));

describe("Automated On-Chain Reconciliation Worker (#313)", () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
  });

  const creditorWallet = "GCREDITOR".padEnd(56, "A");
  const debtorWallet = "GDEBTOR".padEnd(56, "B");
  const mockTxHash = "a".repeat(64);

  const mockJob: ReconciliationJob = {
    id: "job-1",
    intentId: "intent-1",
    tripId: "trip-1",
    expenseId: "exp-1",
    memberId: "mem-1",
    payerWallet: creditorWallet,
    memberWallet: debtorWallet,
    asset: "XLM",
    amount: "10.0000000",
    amountStroops: "100000000",
    expectedMemo: "SSP-req-1",
    requestId: "req-1",
    txHash: mockTxHash,
    ledger: null,
    status: "submitted_not_confirmed",
    attempts: 1,
    maxAttempts: 10,
    backoffMs: 5000,
    lastAttemptAt: null,
    nextAttemptAt: new Date().toISOString(),
    escalationReason: null,
    errorMessage: null,
    verifiedAt: null,
    recordedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe("1. Backoff and Rate Limiting", () => {
    it("computes exponential backoff within bounds with jitter", () => {
      const b0 = calculateBackoffMs(0, 5000, 300000, 0);
      expect(b0).toBe(5000);

      const b1 = calculateBackoffMs(1, 5000, 300000, 0);
      expect(b1).toBe(10000);

      const b2 = calculateBackoffMs(2, 5000, 300000, 0);
      expect(b2).toBe(20000);

      const bMax = calculateBackoffMs(15, 5000, 300000, 0);
      expect(bMax).toBe(300000);
    });

    it("rate limiter spaces requests cleanly", async () => {
      const limiter = new WorkerRateLimiter(20);
      const start = Date.now();
      await limiter.acquire();
      await limiter.acquire();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(15);
    });
  });

  describe("2. Strict 5-Point Verification & Anti-Ambiguity Guard", () => {
    it("escalates on destination wallet mismatch without marking paid", async () => {
      const wrongRecipient = "GWRONGRECIPIENT".padEnd(56, "X");

      // Horizon tx endpoint
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          ledger: 12345,
          created_at: new Date().toISOString(),
          source_account: debtorWallet,
          memo: "SSP-req-1",
          memo_type: "text",
        }),
      });

      // Horizon operations endpoint
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              {
                type: "payment",
                from: debtorWallet,
                to: wrongRecipient,
                asset_type: "native",
                amount: "10.0000000",
              },
            ],
          },
        }),
      });

      const limiter = new WorkerRateLimiter(0);
      const result = await verifyPaymentStrict(
        mockTxHash,
        {
          payerWallet: creditorWallet,
          asset: "XLM",
          amountStroops: 100_000_000n,
          expectedMemo: "SSP-req-1",
        },
        limiter,
      );

      expect(result.ok).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.escalationReason).toContain("Destination mismatch");
    });

    it("escalates on asset mismatch (e.g. sent wrong token)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          ledger: 12345,
          created_at: new Date().toISOString(),
          source_account: debtorWallet,
          memo: "SSP-req-1",
          memo_type: "text",
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              {
                type: "payment",
                from: debtorWallet,
                to: creditorWallet,
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GISSUER".padEnd(56, "I"),
                amount: "10.0000000",
              },
            ],
          },
        }),
      });

      const limiter = new WorkerRateLimiter(0);
      const result = await verifyPaymentStrict(
        mockTxHash,
        {
          payerWallet: creditorWallet,
          asset: "XLM",
          amountStroops: 100_000_000n,
          expectedMemo: "SSP-req-1",
        },
        limiter,
      );

      expect(result.ok).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.escalationReason).toContain("Asset mismatch");
    });

    it("escalates on underpayment (amount shortfall)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          ledger: 12345,
          created_at: new Date().toISOString(),
          source_account: debtorWallet,
          memo: "SSP-req-1",
          memo_type: "text",
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              {
                type: "payment",
                from: debtorWallet,
                to: creditorWallet,
                asset_type: "native",
                amount: "5.0000000", // Only half the required 10 XLM!
              },
            ],
          },
        }),
      });

      const limiter = new WorkerRateLimiter(0);
      const result = await verifyPaymentStrict(
        mockTxHash,
        {
          payerWallet: creditorWallet,
          asset: "XLM",
          amountStroops: 100_000_000n,
          expectedMemo: "SSP-req-1",
        },
        limiter,
      );

      expect(result.ok).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.escalationReason).toContain("Amount shortfall");
    });

    it("escalates on conflicting memo", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          ledger: 12345,
          created_at: new Date().toISOString(),
          source_account: debtorWallet,
          memo: "WRONG-MEMO-EXP-999",
          memo_type: "text",
        }),
      });

      const limiter = new WorkerRateLimiter(0);
      const result = await verifyPaymentStrict(
        mockTxHash,
        {
          payerWallet: creditorWallet,
          asset: "XLM",
          amountStroops: 100_000_000n,
          expectedMemo: "SSP-req-1",
        },
        limiter,
      );

      expect(result.ok).toBe(false);
      expect(result.escalated).toBe(true);
      expect(result.escalationReason).toContain("Memo conflict");
    });

    it("approves exact valid payment across all 5 checks", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          ledger: 12345,
          created_at: new Date().toISOString(),
          source_account: debtorWallet,
          memo: "SSP-req-1",
          memo_type: "text",
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [
              {
                type: "payment",
                from: debtorWallet,
                to: creditorWallet,
                asset_type: "native",
                amount: "10.0000000",
              },
            ],
          },
        }),
      });

      const limiter = new WorkerRateLimiter(0);
      const result = await verifyPaymentStrict(
        mockTxHash,
        {
          payerWallet: creditorWallet,
          asset: "XLM",
          amountStroops: 100_000_000n,
          expectedMemo: "SSP-req-1",
        },
        limiter,
      );

      expect(result.ok).toBe(true);
      expect(result.escalated).toBe(false);
      expect(result.verifiedPayment?.amountStroops).toBe(100_000_000n);
      expect(result.verifiedPayment?.ledger).toBe(12345);
    });
  });

  describe("3. State Machine Progression", () => {
    it("resolves confirmed_not_recorded by updating share and intent to recorded", async () => {
      const mockUpdate = jest.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnValue({
            eq: mockUpdate,
          }),
        }),
      };

      const jobToRecord: ReconciliationJob = {
        ...mockJob,
        status: "confirmed_not_recorded",
        ledger: 12345,
      };

      const result = await processReconciliationJob(
        jobToRecord,
        mockSupabase as any,
        new WorkerRateLimiter(0),
      );

      expect(result.status).toBe("recorded");
      expect(result.changed).toBe(true);
      expect(markSharePaidRow).toHaveBeenCalledWith(
        jobToRecord.expenseId,
        jobToRecord.memberId,
        jobToRecord.txHash,
        mockSupabase,
      );
      expect(markIntentRecorded).toHaveBeenCalledWith(
        jobToRecord.intentId,
        12345,
        true,
        mockSupabase,
      );
    });

    it("fails an expired unsubmitted intent cleanly after max attempts", async () => {
      const mockUpdate = jest.fn().mockResolvedValue({ error: null });
      const mockSupabase = {
        from: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnValue({
            eq: mockUpdate,
          }),
        }),
      };

      // Mock account payment search returning empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ _embedded: { records: [] } }),
      });

      const expiredJob: ReconciliationJob = {
        ...mockJob,
        status: "not_submitted",
        txHash: null,
        attempts: 10, // Max attempts reached
        createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      };

      const result = await processReconciliationJob(
        expiredJob,
        mockSupabase as any,
        new WorkerRateLimiter(0),
      );

      expect(result.status).toBe("failed");
      expect(result.changed).toBe(true);
      expect(markIntentFailed).toHaveBeenCalled();
    });
  });

  describe("4. Operator Alert Thresholds", () => {
    it("flags PENDING_AGING_EXCEEDED when pending job > 15 minutes", () => {
      const summary: ReconciliationSummary = {
        total: 10,
        notSubmitted: 1,
        submittedNotConfirmed: 2,
        confirmedNotRecorded: 0,
        recorded: 7,
        escalated: 0,
        failed: 0,
        totalPending: 3,
        pendingAging: { under5m: 1, from5mTo15m: 1, over15m: 1 },
        failureRatePercent: 0,
      };

      const alerts = evaluateAlertThresholds(summary);
      expect(alerts.some((a) => a.code === "PENDING_AGING_EXCEEDED")).toBe(true);
    });

    it("flags HIGH_PENDING_QUEUE when backlog exceeds 10 jobs", () => {
      const summary: ReconciliationSummary = {
        total: 25,
        notSubmitted: 5,
        submittedNotConfirmed: 6,
        confirmedNotRecorded: 2,
        recorded: 12,
        escalated: 0,
        failed: 0,
        totalPending: 13, // > 10
        pendingAging: { under5m: 13, from5mTo15m: 0, over15m: 0 },
        failureRatePercent: 0,
      };

      const alerts = evaluateAlertThresholds(summary);
      expect(alerts.some((a) => a.code === "HIGH_PENDING_QUEUE")).toBe(true);
    });

    it("flags AMBIGUOUS_PAYMENTS_ESCALATED with critical severity for any escalated payment", () => {
      const summary: ReconciliationSummary = {
        total: 10,
        notSubmitted: 0,
        submittedNotConfirmed: 0,
        confirmedNotRecorded: 0,
        recorded: 8,
        escalated: 2, // Ambiguous payments flagged
        failed: 0,
        totalPending: 0,
        pendingAging: { under5m: 0, from5mTo15m: 0, over15m: 0 },
        failureRatePercent: 0,
      };

      const alerts = evaluateAlertThresholds(summary);
      const escAlert = alerts.find((a) => a.code === "AMBIGUOUS_PAYMENTS_ESCALATED");
      expect(escAlert).toBeDefined();
      expect(escAlert?.level).toBe("critical");
    });
  });
});
