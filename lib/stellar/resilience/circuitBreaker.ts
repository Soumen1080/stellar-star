/**
 * lib/stellar/resilience/circuitBreaker.ts
 *
 * Circuit Breaker for Stellar Providers (Horizon & Soroban) (#426).
 *
 * Implements standard 3-state state machine:
 *   CLOSED    -> Healthy; all requests forwarded.
 *   OPEN      -> Tripped by provider faults; fails fast in <1ms without hitting provider.
 *   HALF_OPEN -> Probing recovery; canary requests verify provider health before closing.
 *
 * Enforces short timeouts so hung connections never consume request workers.
 */

import {
  StellarCircuitOpenError,
  StellarTimeoutError,
  isStellarProviderFault,
} from "./errors";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  callTimeoutMs?: number;
  halfOpenSuccessThreshold?: number;
  isFailure?: (err: unknown) => boolean;
}

export interface CircuitBreakerMetrics {
  name: string;
  state: CircuitState;
  failureCount: number;
  successCount: number;
  halfOpenSuccesses: number;
  openedAt: number | null;
  lastStateChange: number;
}

export const DEFAULT_CIRCUIT_CONFIG: Required<CircuitBreakerConfig> = {
  failureThreshold: 5,
  resetTimeoutMs: 15_000,
  callTimeoutMs: 4_000,
  halfOpenSuccessThreshold: 2,
  isFailure: isStellarProviderFault,
};

const TIMED_OUT_SENTINEL = Symbol("stellar-call-timeout");

export class StellarCircuitBreaker {
  readonly name: string;
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private halfOpenSuccesses = 0;
  private openedAt: number | null = null;
  private lastStateChange: number = Date.now();
  private readonly config: Required<CircuitBreakerConfig>;

  constructor(name: string, config: CircuitBreakerConfig = {}) {
    this.name = name;
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
  }

  get currentState(): CircuitState {
    this.checkAutoTransition();
    return this.state;
  }

  get failureCount(): number {
    return this.failures;
  }

  get metrics(): CircuitBreakerMetrics {
    this.checkAutoTransition();
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failures,
      successCount: this.successes,
      halfOpenSuccesses: this.halfOpenSuccesses,
      openedAt: this.openedAt,
      lastStateChange: this.lastStateChange,
    };
  }

  private checkAutoTransition(): void {
    if (this.state === "OPEN" && this.openedAt) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transitionTo("HALF_OPEN");
      }
    }
  }

  private transitionTo(nextState: CircuitState): void {
    this.state = nextState;
    this.lastStateChange = Date.now();

    if (nextState === "OPEN") {
      this.openedAt = Date.now();
      this.halfOpenSuccesses = 0;
    } else if (nextState === "HALF_OPEN") {
      this.halfOpenSuccesses = 0;
    } else if (nextState === "CLOSED") {
      this.failures = 0;
      this.openedAt = null;
      this.halfOpenSuccesses = 0;
    }
  }

  /**
   * Executes an async operation protected by circuit breaker and strict timeout.
   */
  async execute<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    timeoutMsOverride?: number
  ): Promise<T> {
    this.checkAutoTransition();

    // ── 1. OPEN: Fail Fast ──────────────────────────────────────────────────
    if (this.state === "OPEN") {
      const elapsed = Date.now() - (this.openedAt ?? Date.now());
      const remainingMs = Math.max(0, this.config.resetTimeoutMs - elapsed);
      const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1000));
      throw new StellarCircuitOpenError(this.name, retryAfterSec);
    }

    // ── 2. CLOSED or HALF_OPEN: Forward Call with Short Timeout ─────────────
    const callTimeout = timeoutMsOverride ?? this.config.callTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    try {
      const raceResult = await Promise.race([
        fn(controller.signal),
        new Promise<typeof TIMED_OUT_SENTINEL>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(TIMED_OUT_SENTINEL);
          }, callTimeout);
        }),
      ]);

      if (raceResult === TIMED_OUT_SENTINEL) {
        throw new StellarTimeoutError(this.name, callTimeout);
      }

      this.onSuccess();
      return raceResult as T;
    } catch (err) {
      this.onFailure(err);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private onSuccess(): void {
    this.successes++;

    if (this.state === "HALF_OPEN") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenSuccessThreshold) {
        this.transitionTo("CLOSED");
      }
    } else if (this.state === "CLOSED") {
      // Steady state: reset consecutive failures
      this.failures = 0;
    }
  }

  private onFailure(err: unknown): void {
    // Only genuine provider faults trip the breaker
    if (!this.config.isFailure(err)) {
      return;
    }

    this.failures++;

    if (this.state === "HALF_OPEN") {
      // In probe state, a single failure trips immediately back to OPEN
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED") {
      if (this.failures >= this.config.failureThreshold) {
        this.transitionTo("OPEN");
      }
    }
  }

  /**
   * Forces the circuit breaker to trip open immediately (used in tests/runbooks).
   */
  trip(): void {
    this.failures = this.config.failureThreshold;
    this.transitionTo("OPEN");
  }

  /**
   * Resets the circuit breaker to CLOSED.
   */
  reset(): void {
    this.transitionTo("CLOSED");
  }

  /**
   * Probes provider health explicitly.
   */
  async probe<T>(probeFn: () => Promise<T>): Promise<boolean> {
    try {
      await this.execute(probeFn, 3000);
      return true;
    } catch {
      return false;
    }
  }
}
