/**
 * lib/stellar/resilience/errors.ts
 *
 * Safe domain errors for Stellar circuit breakers and bulkheads (#426).
 * Follows stable error codes and redacts detailed causes from public output.
 */

export class StellarCircuitOpenError extends Error {
  readonly code = "STELLAR_CIRCUIT_OPEN";
  readonly status = 503;
  readonly provider: string;
  readonly retryAfterSeconds: number;

  constructor(provider: string, retryAfterSeconds = 15) {
    super(
      `Stellar provider '${provider}' circuit breaker is OPEN due to repeated faults. Failing fast to protect service capacity.`
    );
    this.name = "StellarCircuitOpenError";
    this.provider = provider;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class StellarTimeoutError extends Error {
  readonly code = "STELLAR_TIMEOUT";
  readonly status = 504;
  readonly provider: string;
  readonly timeoutMs: number;

  constructor(provider: string, timeoutMs: number) {
    super(`Stellar provider '${provider}' timed out after ${timeoutMs}ms.`);
    this.name = "StellarTimeoutError";
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export class BulkheadRejectedError extends Error {
  readonly code = "STELLAR_BULKHEAD_REJECTED";
  readonly status = 503;
  readonly pool: string;
  readonly maxConcurrent: number;
  readonly maxQueue: number;

  constructor(pool: string, maxConcurrent: number, maxQueue: number) {
    super(
      `Stellar concurrency bulkhead for '${pool}' is saturated (${maxConcurrent} active, ${maxQueue} queued). Request rejected to prevent service starvation.`
    );
    this.name = "BulkheadRejectedError";
    this.pool = pool;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
  }
}

/**
 * Checks if an error is a genuine provider-level fault (5xx, network drop, timeout, hang).
 * Client errors (404 unfunded, bad sequence, user cancel) must NOT trip the breaker.
 */
export function isStellarProviderFault(err: unknown): boolean {
  if (!err) return false;

  if (err instanceof StellarTimeoutError) return true;
  if (err instanceof StellarCircuitOpenError) return false;
  if (err instanceof BulkheadRejectedError) return false;

  const errObj = err as any;

  // Check HTTP response status codes if present
  const status =
    errObj?.status ||
    errObj?.statusCode ||
    errObj?.response?.status ||
    errObj?.response?.statusCode;

  if (typeof status === "number") {
    // 404 is valid unfunded state in Stellar; 400 is bad client request
    if (status === 404 || status === 400 || status === 401 || status === 403) {
      return false;
    }
    // 5xx or 429 indicates provider degradation
    if (status >= 500 || status === 429) {
      return true;
    }
  }

  // Check network error codes
  const code = String(errObj?.code || "");
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EHOSTUNREACH" ||
    code === "ECONNRESET"
  ) {
    return true;
  }

  // Check error message patterns
  const message = String(errObj?.message || "").toLowerCase();
  if (
    message.includes("network error") ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("gateway timeout") ||
    message.includes("bad gateway") ||
    message.includes("service unavailable") ||
    message.includes("timeout") ||
    message.includes("horizon 5")
  ) {
    return true;
  }

  return false;
}
