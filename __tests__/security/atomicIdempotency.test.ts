/**
 * __tests__/security/atomicIdempotency.test.ts
 *
 * Test suite for Issue #411: Atomically claim idempotency keys.
 *
 * Verifies:
 * 1. Atomic claim in a single transaction returning four deliberate outcomes:
 *    - new_claim
 *    - completed_replay
 *    - incompatible_key_conflict
 *    - temporarily_locked
 * 2. Parallel tests proving exactly one execution under concurrent retries.
 * 3. 409 Conflict rejection for key reuse with a different request payload.
 * 4. Storing completion only after the business operation finishes.
 * 5. Lease expiration and safe recovery for crashed workers.
 */

import {
  withIdempotency,
  claimIdempotencyKey,
  completeIdempotencyClaim,
  releaseIdempotencyClaim,
  atomicClaimInMemory,
  IdempotencyConflictError,
  IdempotencyLockedError,
  computeRequestFingerprint,
  __resetIdempotencyForTests,
} from "@/lib/idempotency/store";

describe("Atomic Idempotency Claims (Issue #411)", () => {
  const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7IRNVAXQIUI46G2XST4KSDUP";
  const ENDPOINT = "/api/expenses";

  beforeEach(() => {
    __resetIdempotencyForTests();
  });

  // --------------------------------------------------------------------------
  // 1. Four Deliberate Outcomes Evaluation
  // --------------------------------------------------------------------------
  describe("Deliberate Four-Outcome Claim Evaluation", () => {
    it("returns 'new_claim' on fresh unobserved key", async () => {
      const key = "fresh-claim-1";
      const fp = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 100 });

      const claim = await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
      });

      expect(claim.outcome).toBe("new_claim");
      expect(claim.lockedUntil).toBeDefined();
    });

    it("returns 'temporarily_locked' when claim is currently in progress within lease", async () => {
      const key = "in-flight-key-2";
      const fp = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 100 });

      // First claim succeeds
      const claim1 = await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
        leaseSeconds: 60,
      });
      expect(claim1.outcome).toBe("new_claim");

      // Immediate second claim with same fingerprint is locked
      const claim2 = await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
      });
      expect(claim2.outcome).toBe("temporarily_locked");
      expect(claim2.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("returns 'completed_replay' with cached status and body when mutation finished", async () => {
      const key = "completed-key-3";
      const fp = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 100 });

      await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
      });

      await completeIdempotencyClaim({
        walletAddress: TEST_WALLET,
        key,
        fingerprint: fp,
        responseStatus: 201,
        responseBody: { id: "expense-123", amount: 100 },
      });

      // Claim on completed record returns replay outcome
      const claim = await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
      });

      expect(claim.outcome).toBe("completed_replay");
      expect(claim.responseStatus).toBe(201);
      expect(claim.responseBody).toEqual({ id: "expense-123", amount: 100 });
    });

    it("returns 'incompatible_key_conflict' when key is reused with mismatched payload", async () => {
      const key = "conflict-key-4";
      const fpOriginal = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 100 });
      const fpTampered = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 999 });

      await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fpOriginal,
      });

      const conflictClaim = await claimIdempotencyKey({
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fpTampered,
      });

      expect(conflictClaim.outcome).toBe("incompatible_key_conflict");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Parallel Tests: Exactly One Execution & Race Prevention
  // --------------------------------------------------------------------------
  describe("Parallel Execution & Race Serialization", () => {
    it("demonstrates exactly one execution under simultaneous parallel retries", async () => {
      let executionCount = 0;
      const key = `parallel-test-${Date.now()}`;
      const payload = { tripId: "trip-paris", amount: "500.00" };

      const businessOperation = async () => {
        executionCount++;
        // Simulate real work duration
        await new Promise((r) => setTimeout(r, 20));
        return { data: { paymentId: "pay-abc-123", executionCount }, status: 201 };
      };

      // Launch 5 simultaneous requests with the same key and payload
      const parallelCalls = Array(5)
        .fill(null)
        .map(() =>
          withIdempotency({
            key,
            walletAddress: TEST_WALLET,
            endpoint: ENDPOINT,
            payload,
            execute: businessOperation,
          })
            .then((res) => ({ success: true, res }))
            .catch((err) => ({ success: false, err })),
        );

      const results = await Promise.all(parallelCalls);

      // Exactly ONE execution must occur
      expect(executionCount).toBe(1);

      // One call must have succeeded as a new claim
      const succeeded = results.filter((r) => r.success);
      expect(succeeded.length).toBeGreaterThanOrEqual(1);

      // In-flight parallel calls were serialized with IdempotencyLockedError
      const lockedCalls = results.filter(
        (r): r is { success: false; err: any } => !r.success && r.err instanceof IdempotencyLockedError,
      );
      expect(lockedCalls.length + succeeded.length).toBe(5);

      // Subsequent sequential retry replayed the cached result
      const replayResult = await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: ENDPOINT,
        payload,
        execute: businessOperation,
      });

      expect(executionCount).toBe(1); // Still exactly 1
      expect(replayResult.replayed).toBe(true);
      expect(replayResult.data.paymentId).toBe("pay-abc-123");
    });

    it("throws 409 IdempotencyConflictError for reuse with a different request payload", async () => {
      const key = `key-conflict-${Date.now()}`;
      const payloadA = { amount: 100, recipient: "Alice" };
      const payloadB = { amount: 200, recipient: "Bob" };

      // First request completes
      await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: ENDPOINT,
        payload: payloadA,
        execute: async () => ({ data: { success: true }, status: 200 }),
      });

      // Second request reuses key with different payload
      await expect(
        withIdempotency({
          key,
          walletAddress: TEST_WALLET,
          endpoint: ENDPOINT,
          payload: payloadB,
          execute: async () => ({ data: { success: true }, status: 200 }),
        }),
      ).rejects.toThrow(IdempotencyConflictError);

      try {
        await withIdempotency({
          key,
          walletAddress: TEST_WALLET,
          endpoint: ENDPOINT,
          payload: payloadB,
          execute: async () => ({ data: { success: true }, status: 200 }),
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(IdempotencyConflictError);
        expect(err.code).toBe("IDEMPOTENCY_CONFLICT");
        expect(err.status).toBe(409);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Lease Expiration & Crashed Worker Recovery
  // --------------------------------------------------------------------------
  describe("Lease Expiration & Crashed Worker Safe Recovery", () => {
    it("safely recovers lease when a worker crashed and lease duration expired", () => {
      const key = "crashed-worker-key";
      const fp = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { amount: 50 });
      const startTime = 1_000_000;
      const leaseSeconds = 10;

      // 1. Initial worker claims key with 10s lease
      const claim1 = atomicClaimInMemory(
        TEST_WALLET,
        key,
        ENDPOINT,
        fp,
        leaseSeconds,
        startTime,
      );
      expect(claim1.outcome).toBe("new_claim");

      // 2. While lease is active at +5s: locked
      const claim2 = atomicClaimInMemory(
        TEST_WALLET,
        key,
        ENDPOINT,
        fp,
        leaseSeconds,
        startTime + 5_000,
      );
      expect(claim2.outcome).toBe("temporarily_locked");

      // 3. Worker crashed and never called completion!
      // At +15s (after lease expired): new worker safely recovers claim
      const claim3 = atomicClaimInMemory(
        TEST_WALLET,
        key,
        ENDPOINT,
        fp,
        leaseSeconds,
        startTime + 15_000,
      );
      expect(claim3.outcome).toBe("new_claim");
      expect(claim3.recovered).toBe(true);
    });

    it("releases pending lock immediately on execution error so retries can claim", async () => {
      const key = "error-release-key";
      const payload = { amount: 75 };
      let attempt = 0;

      const failingOperation = async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("Downstream payment gateway error");
        }
        return { data: { success: true, attempt }, status: 200 };
      };

      // Attempt 1 fails
      await expect(
        withIdempotency({
          key,
          walletAddress: TEST_WALLET,
          endpoint: ENDPOINT,
          payload,
          execute: failingOperation,
        }),
      ).rejects.toThrow("Downstream payment gateway error");

      // Attempt 2 succeeds immediately because lock was released
      const res = await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: ENDPOINT,
        payload,
        execute: failingOperation,
      });

      expect(res.data.success).toBe(true);
      expect(res.data.attempt).toBe(2);
      expect(res.replayed).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Mocked Database RPC Claim Integration
  // --------------------------------------------------------------------------
  describe("Database RPC Execution Path", () => {
    it("delegates claim to client.rpc claim_idempotency_key when client is provided", async () => {
      const mockRpc = jest.fn().mockResolvedValue({
        data: {
          outcome: "new_claim",
          locked_until: new Date(Date.now() + 60_000).toISOString(),
        },
        error: null,
      });

      const mockClient = {
        rpc: mockRpc,
      } as any;

      const key = "db-rpc-key";
      const fp = computeRequestFingerprint(TEST_WALLET, ENDPOINT, { val: 1 });

      const claim = await claimIdempotencyKey({
        client: mockClient,
        walletAddress: TEST_WALLET,
        key,
        endpoint: ENDPOINT,
        fingerprint: fp,
      });

      expect(mockRpc).toHaveBeenCalledWith(
        "claim_idempotency_key",
        expect.objectContaining({
          p_wallet_address: TEST_WALLET,
          p_key: key,
          p_endpoint: ENDPOINT,
          p_request_fingerprint: fp,
        }),
      );
      expect(claim.outcome).toBe("new_claim");
    });
  });
});
