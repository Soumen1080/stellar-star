/**
 * lib/stellar/resilience/jitter.ts
 *
 * Bounded exponential backoff with full randomized jitter (#426).
 * Prevents thundering herds when Stellar Horizon/Soroban providers degrade.
 */

import { isStellarProviderFault, StellarCircuitOpenError } from "./errors";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  jitterFactor: 0.2, // +/- 20%
  shouldRetry: (err) => isStellarProviderFault(err),
  onRetry: () => {},
  sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Calculates exponential backoff with bounded decorrelated jitter:
 *   delay = min(maxDelayMs, baseDelayMs * 2^(attempt - 1)) * (1 +/- jitter)
 */
export function calculateExponentialJitter(
  attempt: number,
  baseDelayMs = DEFAULT_RETRY_OPTIONS.baseDelayMs,
  maxDelayMs = DEFAULT_RETRY_OPTIONS.maxDelayMs,
  jitterFactor = DEFAULT_RETRY_OPTIONS.jitterFactor
): number {
  const exponent = Math.max(0, attempt - 1);
  const rawBackoff = Math.min(baseDelayMs * Math.pow(2, exponent), maxDelayMs);
  const jitterRange = rawBackoff * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.floor(rawBackoff + jitter));
}

/**
 * Retries an asynchronous function with bounded exponential jitter.
 * Aborts immediately if the circuit breaker is open or the error is non-retryable.
 */
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Never retry if the circuit breaker is open
      if (err instanceof StellarCircuitOpenError) {
        throw err;
      }

      // Check if attempt can be retried
      const isLastAttempt = attempt >= opts.maxAttempts;
      if (isLastAttempt || !opts.shouldRetry(err, attempt)) {
        throw err;
      }

      const delayMs = calculateExponentialJitter(
        attempt,
        opts.baseDelayMs,
        opts.maxDelayMs,
        opts.jitterFactor
      );

      opts.onRetry(err, attempt, delayMs);
      await opts.sleepFn(delayMs);
    }
  }

  throw lastError;
}
