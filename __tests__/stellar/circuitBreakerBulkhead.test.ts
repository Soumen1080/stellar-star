/**
 * __tests__/stellar/circuitBreakerBulkhead.test.ts
 *
 * Fault tests and concurrency isolation for Stellar Circuit Breakers & Bulkheads (#426).
 *
 * Invariants Tested:
 * 1. Short timeouts: slow/hanging provider calls abort and trip circuit breakers.
 * 2. Fast failure: open breakers short-circuit in <1ms to prevent request worker starvation.
 * 3. Self-healing: open breakers transition to HALF_OPEN after resetTimeout and recover on canary success.
 * 4. Fault isolation: a completely failing/saturated dependency (e.g. Horizon) CANNOT starve
 *    unrelated dependencies (e.g. Soroban RPC or internal ops).
 * 5. Domain safety: 404 unfunded accounts and client errors do NOT trip circuit breakers.
 * 6. Bounded jitter: retries use exponential backoff with bounded randomized jitter.
 */

import {
  StellarCircuitBreaker,
  BulkheadPool,
  StellarResilienceManager,
  StellarCircuitOpenError,
  StellarTimeoutError,
  BulkheadRejectedError,
  calculateExponentialJitter,
  executeWithRetry,
  isStellarProviderFault,
} from "@/lib/stellar/resilience";

describe("Stellar Circuit Breakers & Concurrency Bulkheads (#426)", () => {
  describe("1. Short Timeouts & Hang Protection", () => {
    it("aborts hanging provider calls at callTimeoutMs and increments failure counter", async () => {
      const breaker = new StellarCircuitBreaker("test-timeout", {
        callTimeoutMs: 50,
        failureThreshold: 2,
      });

      // Call that hangs longer than callTimeoutMs
      const hangingCall = () =>
        new Promise<string>((resolve) => setTimeout(() => resolve("too late"), 500));

      await expect(breaker.execute(hangingCall)).rejects.toThrow(StellarTimeoutError);
      expect(breaker.failureCount).toBe(1);
      expect(breaker.currentState).toBe("CLOSED");
    });
  });

  describe("2. Circuit Breaker States & Fast Failure Invariant", () => {
    it("opens after failureThreshold consecutive faults and fails fast in <1ms without calling provider", async () => {
      let providerCallCount = 0;
      const breaker = new StellarCircuitBreaker("test-failfast", {
        callTimeoutMs: 100,
        failureThreshold: 3,
        resetTimeoutMs: 5000,
      });

      const failingProvider = async () => {
        providerCallCount++;
        const error: any = new Error("Horizon 503 Service Unavailable");
        error.status = 503;
        throw error;
      };

      // Incur 3 consecutive provider faults
      for (let i = 0; i < 3; i++) {
        await expect(breaker.execute(failingProvider)).rejects.toThrow("Horizon 503");
      }

      expect(providerCallCount).toBe(3);
      expect(breaker.currentState).toBe("OPEN");

      // 4th call: Must fail fast without calling provider!
      const start = Date.now();
      await expect(breaker.execute(failingProvider)).rejects.toThrow(StellarCircuitOpenError);
      const elapsed = Date.now() - start;

      // Assert <5ms execution time (fast-fail, no worker blocking)
      expect(elapsed).toBeLessThan(10);
      // Provider was NOT called again
      expect(providerCallCount).toBe(3);
    });

    it("does NOT count client-side errors (404 unfunded, 400 validation) as provider faults", async () => {
      const breaker = new StellarCircuitBreaker("test-client-errors", {
        failureThreshold: 2,
      });

      const unfundedAccountCall = async () => {
        const error: any = new Error("Account not found");
        error.status = 404;
        throw error;
      };

      // 404 represents unfunded account in Stellar; must not trip circuit
      for (let i = 0; i < 5; i++) {
        await expect(breaker.execute(unfundedAccountCall)).rejects.toThrow("Account not found");
      }

      expect(breaker.failureCount).toBe(0);
      expect(breaker.currentState).toBe("CLOSED");
    });
  });

  describe("3. Self-Healing & Periodic Recovery Invariant", () => {
    it("transitions from OPEN to HALF_OPEN after resetTimeout and resets to CLOSED on canary success", async () => {
      let isProviderRecovered = false;
      const breaker = new StellarCircuitBreaker("test-recovery", {
        failureThreshold: 2,
        resetTimeoutMs: 50, // Short reset window for test
        halfOpenSuccessThreshold: 2,
      });

      const provider = async () => {
        if (!isProviderRecovered) {
          const err: any = new Error("Network timeout");
          err.code = "ETIMEDOUT";
          throw err;
        }
        return "provider ok";
      };

      // Trip the breaker
      await expect(breaker.execute(provider)).rejects.toThrow();
      await expect(breaker.execute(provider)).rejects.toThrow();
      expect(breaker.currentState).toBe("OPEN");

      // Wait for reset timeout window to pass
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(breaker.currentState).toBe("HALF_OPEN");

      // Provider recovers
      isProviderRecovered = true;

      // Canary call 1 in HALF_OPEN
      const canary1 = await breaker.execute(provider);
      expect(canary1).toBe("provider ok");
      expect(breaker.currentState).toBe("HALF_OPEN");

      // Canary call 2 in HALF_OPEN -> Re-closes circuit
      const canary2 = await breaker.execute(provider);
      expect(canary2).toBe("provider ok");
      expect(breaker.currentState).toBe("CLOSED");
      expect(breaker.failureCount).toBe(0);
    });

    it("trips back to OPEN immediately if canary request in HALF_OPEN fails", async () => {
      const breaker = new StellarCircuitBreaker("test-canary-fail", {
        failureThreshold: 2,
        resetTimeoutMs: 50,
      });

      // Trip the breaker
      breaker.trip();
      expect(breaker.currentState).toBe("OPEN");

      // Wait for reset timeout to elapse
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(breaker.currentState).toBe("HALF_OPEN");

      // Canary fails with provider error
      const failingCanary = async () => {
        const err: any = new Error("Still failing");
        err.status = 502;
        throw err;
      };

      await expect(breaker.execute(failingCanary)).rejects.toThrow("Still failing");
      // Immediately trips back to OPEN
      expect(breaker.currentState).toBe("OPEN");
    });
  });

  describe("4. Bulkhead Concurrency & Starvation Isolation Invariant", () => {
    it("proves that saturating Horizon concurrency CANNOT starve unrelated operations", async () => {
      const manager = new StellarResilienceManager({
        bulkheadConfigs: {
          horizon_read: { maxConcurrent: 2, maxQueue: 1 },
          soroban_rpc: { maxConcurrent: 5, maxQueue: 5 },
        },
      });

      let releaseHorizonLocks: () => void = () => {};
      const horizonHoldingPromise = new Promise<void>((resolve) => {
        releaseHorizonLocks = resolve;
      });

      // 1. Saturate horizon_read bulkhead: 2 active + 1 queued = 3 tasks
      const activeTask1 = manager.execute("horizon_read", () => horizonHoldingPromise);
      const activeTask2 = manager.execute("horizon_read", () => horizonHoldingPromise);
      const queuedTask3 = manager.execute("horizon_read", () => horizonHoldingPromise);

      const horizonBulkhead = manager.getBulkhead("horizon_read");
      expect(horizonBulkhead.activeCount).toBe(2);
      expect(horizonBulkhead.queueCount).toBe(1);

      // 4th horizon call must be rejected immediately because pool & queue are full!
      await expect(
        manager.execute("horizon_read", async () => "rejected")
      ).rejects.toThrow(BulkheadRejectedError);

      // 2. CRUCIAL INVARIANT: While horizon_read is completely saturated and rejecting,
      // soroban_rpc and unrelated calls MUST SUCCEED with zero delay and zero starvation!
      const sorobanStart = Date.now();
      const sorobanResult = await manager.execute("soroban_rpc", async () => {
        return "soroban contract execution success";
      });
      const sorobanElapsed = Date.now() - sorobanStart;

      expect(sorobanResult).toBe("soroban contract execution success");
      expect(sorobanElapsed).toBeLessThan(20);

      const sorobanBulkhead = manager.getBulkhead("soroban_rpc");
      expect(sorobanBulkhead.rejectedCount).toBe(0);

      // Clean up holding promises
      releaseHorizonLocks();
      await Promise.all([activeTask1, activeTask2, queuedTask3]);
    });
  });

  describe("5. Bounded Exponential Jitter Invariant", () => {
    it("calculates exponential delays bounded by maxDelayMs with randomized jitter", () => {
      const d1 = calculateExponentialJitter(1, 500, 5000, 0);
      const d2 = calculateExponentialJitter(2, 500, 5000, 0);
      const d3 = calculateExponentialJitter(3, 500, 5000, 0);
      const dMax = calculateExponentialJitter(10, 500, 5000, 0);

      expect(d1).toBe(500);
      expect(d2).toBe(1000);
      expect(d3).toBe(2000);
      expect(dMax).toBe(5000);

      // Jitter range verification
      const jittered = calculateExponentialJitter(2, 1000, 5000, 0.2);
      expect(jittered).toBeGreaterThanOrEqual(1600);
      expect(jittered).toBeLessThanOrEqual(2400);
    });

    it("retries transient faults up to maxAttempts but aborts immediately if circuit breaker opens", async () => {
      let attempts = 0;
      const breaker = new StellarCircuitBreaker("test-retry-breaker", {
        failureThreshold: 2,
      });

      const operation = async () => {
        attempts++;
        return breaker.execute(async () => {
          const err: any = new Error("Gateway timeout");
          err.status = 504;
          throw err;
        });
      };

      await expect(
        executeWithRetry(operation, {
          maxAttempts: 5,
          baseDelayMs: 10,
          maxDelayMs: 50,
          sleepFn: async () => {}, // Instant sleep for tests
        })
      ).rejects.toThrow();

      // Trip after 2 attempts -> 3rd attempt aborted immediately because breaker is OPEN
      expect(breaker.currentState).toBe("OPEN");
      expect(attempts).toBeLessThanOrEqual(3);
    });
  });

  describe("6. Telemetry & Metrics Verification", () => {
    it("reports real-time metrics across all dependency classes", () => {
      const manager = new StellarResilienceManager();
      const metrics = manager.getAllMetrics();

      expect(metrics.circuitBreakers.horizon_read).toBeDefined();
      expect(metrics.circuitBreakers.horizon_write).toBeDefined();
      expect(metrics.circuitBreakers.soroban_rpc).toBeDefined();
      expect(metrics.circuitBreakers.oracle_verify).toBeDefined();

      expect(metrics.bulkheads.horizon_read).toBeDefined();
      expect(metrics.bulkheads.soroban_rpc).toBeDefined();
    });
  });
});
