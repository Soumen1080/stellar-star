/**
 * The invariant the whole S4 seam exists to serve:
 *
 *   "Rate unavailability never blocks expense creation. The degraded path is a
 *    designed state, not an error branch."
 *
 * The service, cache, breaker and route all honour it. The consumer is where it
 * was broken: useExpenseForm read `data.rate` without checking `unavailable`,
 * and since an unavailable response carries `rate: null`, `parseFloat(null)`
 * produced NaN and the expense was persisted with `totalAmount: "NaN"` — a
 * silently corrupt record, worse than a blocked submit.
 *
 * These tests pin the consumer-side contract.
 */

import { fetchExchangeRate, describeAge } from "@/lib/fx/quote";
import { CircuitBreaker } from "@/lib/fx/circuitBreaker";

function jsonResponse(body: unknown) {
  return { json: async () => body } as unknown as Response;
}

function fetchReturning(body: unknown): typeof fetch {
  return (async () => jsonResponse(body)) as unknown as typeof fetch;
}

describe("REGRESSION: an unavailable rate never becomes NaN", () => {
  it("returns null when the service reports unavailable", async () => {
    // Exactly what the route returns when every provider is down.
    const quote = await fetchExchangeRate(
      "INR",
      fetchReturning({
        rate: null,
        source: null,
        fetchedAt: null,
        stale: false,
        rateAgeMs: null,
        unavailable: true,
      }),
    );

    // Null is the signal to skip conversion. Previously this produced
    // Number(null) === 0 / parseFloat(null) === NaN and kept going.
    expect(quote).toBeNull();
  });

  it("returns null rather than a NaN rate for a malformed payload", async () => {
    for (const rate of [null, undefined, "", "abc", NaN]) {
      const quote = await fetchExchangeRate(
        "INR",
        fetchReturning({ rate, unavailable: false, fetchedAt: 1 }),
      );
      expect(quote).toBeNull();
    }
  });

  it("rejects a non-positive rate, which would zero out every share", async () => {
    for (const rate of [0, -1]) {
      const quote = await fetchExchangeRate(
        "INR",
        fetchReturning({ rate, unavailable: false, fetchedAt: 1 }),
      );
      expect(quote).toBeNull();
    }
  });

  it("returns null instead of throwing when the route itself is unreachable", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    // A third-party outage must not surface as an exception in the submit path.
    await expect(fetchExchangeRate("INR", failing)).resolves.toBeNull();
  });

  it("returns null when the route reports a validation error", async () => {
    const quote = await fetchExchangeRate(
      "INR",
      fetchReturning({ error: "bad currency code" }),
    );
    expect(quote).toBeNull();
  });
});

describe("a usable quote carries its provenance", () => {
  it("surfaces source, fetched time and freshness", async () => {
    const fetchedAt = Date.UTC(2026, 0, 1, 12, 0, 0);
    const quote = await fetchExchangeRate(
      "INR",
      fetchReturning({
        rate: 0.000142,
        source: "coingecko",
        fetchedAt,
        stale: false,
        rateAgeMs: 4200,
        unavailable: false,
      }),
    );

    expect(quote).not.toBeNull();
    expect(quote!.rate).toBe("0.000142");
    expect(quote!.source).toBe("coingecko");
    expect(quote!.stale).toBe(false);
    // `fetchedAt` is the route's field name; reading `timestamp` (as the old
    // code did) silently produced an undefined provenance stamp.
    expect(quote!.fetchedAtIso).toBe(new Date(fetchedAt).toISOString());
  });

  it("marks a stale quote as stale and keeps its age", async () => {
    const quote = await fetchExchangeRate(
      "INR",
      fetchReturning({
        rate: 0.000142,
        source: "coingecko",
        fetchedAt: Date.now() - 120_000,
        stale: true,
        rateAgeMs: 120_000,
        unavailable: false,
      }),
    );

    // Stale is usable — a slightly old rate beats no expense — but it must
    // never arrive unlabelled.
    expect(quote!.stale).toBe(true);
    expect(quote!.rateAgeMs).toBe(120_000);
  });
});

describe("describeAge", () => {
  it("renders an age a person can judge staleness by", () => {
    expect(describeAge(30_000)).toBe("less than a minute");
    expect(describeAge(60_000)).toBe("1 minute");
    expect(describeAge(300_000)).toBe("5 minutes");
    expect(describeAge(3_600_000)).toBe("1 hour");
    expect(describeAge(86_400_000)).toBe("1 day");
  });

  it("does not produce nonsense for a missing age", () => {
    expect(describeAge(NaN)).toBe("an unknown time");
    expect(describeAge(-1)).toBe("an unknown time");
  });
});

describe("a hanging provider is bypassed without paying its timeout", () => {
  const neverResolves = () => new Promise<string | null>(() => {});

  it("counts a hang as a failure instead of waiting forever", async () => {
    const breaker = new CircuitBreaker("hanging", { callTimeoutMs: 20 });

    const result = await breaker.call(neverResolves);

    // Without the call budget this assertion is never reached.
    expect(result).toBeNull();
    expect(breaker.failureCount).toBe(1);
  });

  it("opens the circuit after repeated hangs, then stops paying the budget", async () => {
    const breaker = new CircuitBreaker("hanging", {
      callTimeoutMs: 20,
      failureThreshold: 3,
    });

    for (let i = 0; i < 3; i++) await breaker.call(neverResolves);
    expect(breaker.currentState).toBe("OPEN");

    // Once OPEN the provider is skipped entirely: the call returns without
    // waiting on the hung upstream at all.
    const started = Date.now();
    const result = await breaker.call(neverResolves);
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(20);
  });

  it("still returns a fast provider's value untouched", async () => {
    const breaker = new CircuitBreaker("fast", { callTimeoutMs: 1_000 });

    await expect(breaker.call(async () => "0.42")).resolves.toBe("0.42");
    expect(breaker.currentState).toBe("CLOSED");
    expect(breaker.failureCount).toBe(0);
  });
});
