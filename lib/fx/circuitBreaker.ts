/**
 * Per-provider circuit breaker.
 *
 * A provider that is timing out or returning errors costs the request latency
 * every time it is tried. A circuit breaker tracks consecutive failures and
 * short-circuits (skips) the provider entirely once they cross a threshold,
 * then probes again after a reset window to see if the provider has recovered.
 *
 * ## States
 *
 *   CLOSED     → normal operation, all calls forwarded.
 *   OPEN       → provider is bypassed; calls return null immediately.
 *   HALF_OPEN  → one probe call is forwarded; success re-closes, failure
 *                re-opens.
 *
 * ## Hangs count as failures
 *
 * Every call is bounded by `callTimeoutMs`. A provider that accepts the
 * connection and then never answers is a failure like any other — without the
 * bound it would never trip the breaker, and each request would pay the full
 * hang.
 *
 * ## Thread safety
 *
 * JavaScript is single-threaded, so in-memory state is safe without locks.
 * The implementation is intentionally free of external dependencies.
 */

import type { CircuitState, CircuitBreakerConfig } from "./types";

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  // Long enough for a healthy provider on a slow network, short enough that a
  // hung provider does not hold up expense creation. Three consecutive hangs
  // (~9 s) open the circuit, after which the provider costs nothing.
  callTimeoutMs: 3_000,
};

/** Sentinel resolved by the timeout race; never a legitimate provider value. */
const TIMED_OUT = Symbol("fx-provider-timeout");

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private openedAt: number | null = null;
  private readonly cfg: CircuitBreakerConfig;

  constructor(
    public readonly name: string,
    config: Partial<CircuitBreakerConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /** Current circuit state — useful for observability and tests. */
  get currentState(): CircuitState {
    return this.state;
  }

  /** Consecutive failure count — useful for tests. */
  get failureCount(): number {
    return this.failures;
  }

  /**
   * Wraps an async call with circuit-breaker semantics.
   *
   * Returns `null` immediately if the circuit is OPEN. In HALF_OPEN state,
   * only one call is allowed through; its outcome determines the next state.
   * In CLOSED state, failures are counted; once they cross `failureThreshold`
   * the circuit opens.
   */
  async call<T>(fn: () => Promise<T | null>): Promise<T | null> {
    // ── OPEN ──────────────────────────────────────────────────────────────────
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed < this.cfg.resetTimeoutMs) {
        // Still within the reset window — bypass immediately.
        return null;
      }
      // Reset window has passed: move to HALF_OPEN and let one probe through.
      this.state = "HALF_OPEN";
    }

    // ── CLOSED / HALF_OPEN ────────────────────────────────────────────────────
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Race the provider against the call budget. A provider that hangs is
      // indistinguishable from one that is down, and must be treated as such —
      // otherwise it never trips the breaker and every request pays the hang.
      const result = await Promise.race([
        fn(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), this.cfg.callTimeoutMs);
        }),
      ]);

      if (result === TIMED_OUT) {
        this.onFailure();
        return null;
      }

      if (result !== null) {
        // Success — reset failure count and re-close if we were half-open.
        this.onSuccess();
        return result;
      }

      // A null result from the provider counts as a failure.
      this.onFailure();
      return null;
    } catch {
      // Providers should not throw, but guard anyway.
      this.onFailure();
      return null;
    } finally {
      // Always clear the timer: an un-cleared one keeps the process alive and
      // makes tests hang after the assertion has already passed.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private onSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
    this.openedAt = null;
  }

  private onFailure(): void {
    this.failures += 1;

    if (this.state === "HALF_OPEN") {
      // A probe failure re-opens the circuit immediately.
      this.open();
      return;
    }

    if (this.failures >= this.cfg.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "OPEN";
    this.openedAt = Date.now();
  }

  /** Force-reset for testing purposes. */
  reset(): void {
    this.state = "CLOSED";
    this.failures = 0;
    this.openedAt = null;
  }
}
