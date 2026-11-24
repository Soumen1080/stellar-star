/**
 * lib/stellar/resilience/manager.ts
 *
 * Centralized Stellar Resilience Manager (#426).
 *
 * Coordinates circuit breakers, concurrency bulkheads, short timeouts,
 * and bounded exponential jitter across all Stellar dependency classes:
 *   - 'horizon_read'
 *   - 'horizon_write'
 *   - 'soroban_rpc'
 *   - 'oracle_verify'
 */

import { StellarCircuitBreaker, CircuitBreakerConfig } from "./circuitBreaker";
import { BulkheadPool, BulkheadConfig } from "./bulkhead";
import { executeWithRetry, RetryOptions } from "./jitter";

export type StellarDependencyClass =
  | "horizon_read"
  | "horizon_write"
  | "soroban_rpc"
  | "oracle_verify";

export interface ResilienceManagerOptions {
  circuitConfigs?: Partial<Record<StellarDependencyClass, CircuitBreakerConfig>>;
  bulkheadConfigs?: Partial<Record<StellarDependencyClass, BulkheadConfig>>;
}

export interface ExecuteStellarOptions {
  timeoutMs?: number;
  retry?: boolean | RetryOptions;
}

export class StellarResilienceManager {
  private breakers: Map<StellarDependencyClass, StellarCircuitBreaker>;
  private bulkheads: Map<StellarDependencyClass, BulkheadPool>;

  constructor(options: ResilienceManagerOptions = {}) {
    this.breakers = new Map([
      [
        "horizon_read",
        new StellarCircuitBreaker("horizon_read", {
          callTimeoutMs: 4_000,
          failureThreshold: 5,
          resetTimeoutMs: 15_000,
          ...options.circuitConfigs?.horizon_read,
        }),
      ],
      [
        "horizon_write",
        new StellarCircuitBreaker("horizon_write", {
          callTimeoutMs: 10_000,
          failureThreshold: 3,
          resetTimeoutMs: 20_000,
          ...options.circuitConfigs?.horizon_write,
        }),
      ],
      [
        "soroban_rpc",
        new StellarCircuitBreaker("soroban_rpc", {
          callTimeoutMs: 8_000,
          failureThreshold: 5,
          resetTimeoutMs: 15_000,
          ...options.circuitConfigs?.soroban_rpc,
        }),
      ],
      [
        "oracle_verify",
        new StellarCircuitBreaker("oracle_verify", {
          callTimeoutMs: 5_000,
          failureThreshold: 4,
          resetTimeoutMs: 15_000,
          ...options.circuitConfigs?.oracle_verify,
        }),
      ],
    ]);

    this.bulkheads = new Map([
      [
        "horizon_read",
        new BulkheadPool("horizon_read", {
          maxConcurrent: 25,
          maxQueue: 50,
          queueTimeoutMs: 4_000,
          ...options.bulkheadConfigs?.horizon_read,
        }),
      ],
      [
        "horizon_write",
        new BulkheadPool("horizon_write", {
          maxConcurrent: 10,
          maxQueue: 20,
          queueTimeoutMs: 8_000,
          ...options.bulkheadConfigs?.horizon_write,
        }),
      ],
      [
        "soroban_rpc",
        new BulkheadPool("soroban_rpc", {
          maxConcurrent: 20,
          maxQueue: 40,
          queueTimeoutMs: 6_000,
          ...options.bulkheadConfigs?.soroban_rpc,
        }),
      ],
      [
        "oracle_verify",
        new BulkheadPool("oracle_verify", {
          maxConcurrent: 15,
          maxQueue: 30,
          queueTimeoutMs: 5_000,
          ...options.bulkheadConfigs?.oracle_verify,
        }),
      ],
    ]);
  }

  getCircuitBreaker(dep: StellarDependencyClass): StellarCircuitBreaker {
    const breaker = this.breakers.get(dep);
    if (!breaker) {
      throw new Error(`Unknown Stellar dependency class '${dep}'`);
    }
    return breaker;
  }

  getBulkhead(dep: StellarDependencyClass): BulkheadPool {
    const bulkhead = this.bulkheads.get(dep);
    if (!bulkhead) {
      throw new Error(`Unknown Stellar dependency class '${dep}'`);
    }
    return bulkhead;
  }

  /**
   * Executes an operation through the appropriate bulkhead pool,
   * circuit breaker, and timeout guard.
   */
  async execute<T>(
    dependencyClass: StellarDependencyClass,
    fn: (signal?: AbortSignal) => Promise<T>,
    options: ExecuteStellarOptions = {}
  ): Promise<T> {
    const bulkhead = this.getBulkhead(dependencyClass);
    const breaker = this.getCircuitBreaker(dependencyClass);

    const callFn = () =>
      bulkhead.execute(() => breaker.execute(fn, options.timeoutMs));

    if (options.retry) {
      const retryOpts =
        typeof options.retry === "object" ? options.retry : {};
      return executeWithRetry(callFn, retryOpts);
    }

    return callFn();
  }

  getAllMetrics() {
    const breakerMetrics: Record<string, any> = {};
    for (const [key, b] of this.breakers.entries()) {
      breakerMetrics[key] = b.metrics;
    }

    const bulkheadMetrics: Record<string, any> = {};
    for (const [key, bh] of this.bulkheads.entries()) {
      bulkheadMetrics[key] = bh.metrics;
    }

    return {
      circuitBreakers: breakerMetrics,
      bulkheads: bulkheadMetrics,
    };
  }

  resetAll(): void {
    for (const b of this.breakers.values()) {
      b.reset();
    }
    for (const bh of this.bulkheads.values()) {
      bh.reset();
    }
  }
}

// ─── Global Singleton Instance ────────────────────────────────────────────────

declare global {
  var globalStellarResilience: StellarResilienceManager | undefined;
}

export const stellarResilience =
  globalThis.globalStellarResilience ?? new StellarResilienceManager();
globalThis.globalStellarResilience = stellarResilience;

export async function resilientHorizonRead<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: ExecuteStellarOptions
): Promise<T> {
  return stellarResilience.execute("horizon_read", fn, options);
}

export async function resilientHorizonWrite<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: ExecuteStellarOptions
): Promise<T> {
  return stellarResilience.execute("horizon_write", fn, options);
}

export async function resilientSorobanRpc<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: ExecuteStellarOptions
): Promise<T> {
  return stellarResilience.execute("soroban_rpc", fn, options);
}

export async function resilientOracleVerify<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: ExecuteStellarOptions
): Promise<T> {
  return stellarResilience.execute("oracle_verify", fn, options);
}
