/**
 * Circuit breaker — unit tests.
 *
 * Covers:
 *   - CLOSED → OPEN on reaching the failure threshold.
 *   - OPEN state short-circuits calls without executing them.
 *   - OPEN → HALF_OPEN after the reset timeout has elapsed.
 *   - HALF_OPEN → CLOSED on a successful probe.
 *   - HALF_OPEN → OPEN on a failed probe (re-opens immediately).
 *   - A success before the threshold resets the failure count.
 */

import { CircuitBreaker } from "@/lib/fx/circuitBreaker";

function makeBreaker(failureThreshold = 3, resetTimeoutMs = 1_000) {
  return new CircuitBreaker("test-provider", { failureThreshold, resetTimeoutMs });
}

const fail = () => Promise.resolve<null>(null);
const succeed = () => Promise.resolve<number>(42);

describe("CircuitBreaker — CLOSED state", () => {
  it("starts in CLOSED state", () => {
    const breaker = makeBreaker();
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });

  it("passes through successful calls", async () => {
    const breaker = makeBreaker();
    const result = await breaker.call(succeed);
    expect(result).toBe(42);
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });

  it("counts consecutive failures", async () => {
    const breaker = makeBreaker(3);
    await breaker.call(fail);
    expect(breaker.failureCount).toBe(1);
    expect(breaker.currentState).toBe("CLOSED");

    await breaker.call(fail);
    expect(breaker.failureCount).toBe(2);
    expect(breaker.currentState).toBe("CLOSED");
  });

  it("opens when failures reach the threshold", async () => {
    const breaker = makeBreaker(3);
    await breaker.call(fail);
    await breaker.call(fail);
    await breaker.call(fail);
    expect(breaker.currentState).toBe("OPEN");
  });

  it("resets failure count on a success before the threshold", async () => {
    const breaker = makeBreaker(3);
    await breaker.call(fail);
    await breaker.call(fail);
    // Success resets the count.
    await breaker.call(succeed);
    expect(breaker.failureCount).toBe(0);
    expect(breaker.currentState).toBe("CLOSED");
    // Must fail 3 more times to open.
    await breaker.call(fail);
    expect(breaker.currentState).toBe("CLOSED");
  });
});

describe("CircuitBreaker — OPEN state", () => {
  it("short-circuits calls without executing them", async () => {
    const breaker = makeBreaker(1, 10_000);
    await breaker.call(fail); // Opens.
    expect(breaker.currentState).toBe("OPEN");

    let called = false;
    const result = await breaker.call(() => {
      called = true;
      return Promise.resolve(99);
    });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  it("remains OPEN within the reset timeout", async () => {
    const breaker = makeBreaker(1, 60_000);
    await breaker.call(fail);
    // Multiple calls within the window all short-circuit.
    for (let i = 0; i < 5; i++) {
      const result = await breaker.call(succeed);
      expect(result).toBeNull();
    }
    expect(breaker.currentState).toBe("OPEN");
  });

  it("transitions to HALF_OPEN once the reset window elapses", async () => {
    const breaker = makeBreaker(1, 50);
    await breaker.call(fail); // Opens.
    expect(breaker.currentState).toBe("OPEN");

    // Wait for the reset timeout.
    await new Promise((r) => setTimeout(r, 60));

    // Next call is allowed through (HALF_OPEN probe).
    const result = await breaker.call(succeed);
    expect(result).toBe(42);
    expect(breaker.currentState).toBe("CLOSED");
  });
});

describe("CircuitBreaker — HALF_OPEN state", () => {
  async function openThenWait(breaker: CircuitBreaker, resetMs: number) {
    await breaker.call(fail); // Opens the breaker.
    await new Promise((r) => setTimeout(r, resetMs + 10));
    // Verify it would move to HALF_OPEN on next call (without calling yet).
    expect(breaker.currentState).toBe("OPEN");
  }

  it("closes the circuit on a successful probe", async () => {
    const breaker = makeBreaker(1, 50);
    await openThenWait(breaker, 50);

    const result = await breaker.call(succeed);
    expect(result).toBe(42);
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });

  it("re-opens immediately on a failed probe", async () => {
    const breaker = makeBreaker(1, 50);
    await openThenWait(breaker, 50);

    const result = await breaker.call(fail);
    expect(result).toBeNull();
    expect(breaker.currentState).toBe("OPEN");
  });
});

describe("CircuitBreaker — reset()", () => {
  it("resets state to CLOSED for test use", async () => {
    const breaker = makeBreaker(1);
    await breaker.call(fail); // Opens.
    expect(breaker.currentState).toBe("OPEN");

    breaker.reset();
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });
});
