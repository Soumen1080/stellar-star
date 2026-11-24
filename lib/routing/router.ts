import type { ProviderCapability, ProviderDomain, ProviderRecord, RouteExecutionOptions } from "./types";
import { providerRegistry } from "./providerRegistry";
import { assertProviderCapability, paymentSubmissionTracker, DuplicatePaymentPreventedError } from "./consistency";

export interface FailoverAttemptLog {
  providerId: string;
  error: string;
  latencyMs: number;
}

export class NoHealthyProviderError extends Error {
  readonly domain: ProviderDomain;
  readonly capability: ProviderCapability;
  constructor(domain: ProviderDomain, capability: ProviderCapability) {
    super(
      `No healthy, enabled providers available for domain "${domain}" and capability "${capability}". ` +
        "Service temporarily unavailable.",
    );
    this.name = "NoHealthyProviderError";
    this.domain = domain;
    this.capability = capability;
  }
}

export class AllProvidersFailedError extends Error {
  readonly domain: ProviderDomain;
  readonly capability: ProviderCapability;
  readonly attempts: FailoverAttemptLog[];

  constructor(domain: ProviderDomain, capability: ProviderCapability, attempts: FailoverAttemptLog[]) {
    const details = attempts.map((a) => `[${a.providerId} (${a.latencyMs}ms): ${a.error}]`).join(", ");
    super(
      `All compatible providers failed for "${domain}:${capability}". Attempts: ${details}`,
    );
    this.name = "AllProvidersFailedError";
    this.domain = domain;
    this.capability = capability;
    this.attempts = attempts;
  }
}

/**
 * Executes an operation with health-aware ordered fallback routing and strict
 * consistency contracts.
 */
export async function executeWithFailover<T>(
  options: RouteExecutionOptions,
  operation: (provider: ProviderRecord) => Promise<T>,
): Promise<T> {
  const {
    domain,
    capability,
    allowDegraded = true,
    requireSubmissionConsistency = false,
    verifyTxExists,
    txHash,
  } = options;

  // Retrieve compatible, healthy/degraded providers ordered by priority and latency
  const candidates = providerRegistry.getCompatibleProviders(domain, capability, {
    allowDegraded,
  });

  if (candidates.length === 0) {
    throw new NoHealthyProviderError(domain, capability);
  }

  // Submission deduplication wrapper for payment submissions
  if (requireSubmissionConsistency && txHash) {
    return paymentSubmissionTracker.track(txHash, () =>
      executeCandidatesLoop(candidates, options, operation),
    );
  }

  return executeCandidatesLoop(candidates, options, operation);
}

async function executeCandidatesLoop<T>(
  candidates: ProviderRecord[],
  options: RouteExecutionOptions,
  operation: (provider: ProviderRecord) => Promise<T>,
): Promise<T> {
  const { domain, capability, requireSubmissionConsistency, verifyTxExists, txHash } = options;
  const attempts: FailoverAttemptLog[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];

    // Enforce consistency assertion: provider must possess required capability
    assertProviderCapability(provider, capability);

    // CRITICAL CONSISTENCY GUARD FOR PAYMENT SUBMISSION FAILOVER:
    // If we experienced a timeout/failure on a previous provider, BEFORE submitting
    // to the fallback provider, verify if the transaction actually landed on-chain!
    if (i > 0 && requireSubmissionConsistency && txHash && verifyTxExists) {
      try {
        const alreadyLanded = await verifyTxExists(txHash);
        if (alreadyLanded) {
          // Transaction already processed by the network; failover must NOT submit again
          throw new DuplicatePaymentPreventedError(txHash);
        }
      } catch (err: unknown) {
        if (err instanceof DuplicatePaymentPreventedError) {
          throw err;
        }
        // Verification network check failed; continue safely
      }
    }

    const start = Date.now();
    try {
      const result = await operation(provider);
      const latency = Math.max(1, Date.now() - start);

      providerRegistry.recordExecution(provider.id, true, latency);
      return result;
    } catch (err: unknown) {
      const latency = Math.max(1, Date.now() - start);
      const errorMsg = err instanceof Error ? err.message : String(err);

      providerRegistry.recordExecution(provider.id, false, latency, err instanceof Error ? err : undefined);
      attempts.push({ providerId: provider.id, error: errorMsg, latencyMs: latency });

      // If error is a DuplicatePaymentPreventedError, re-throw immediately
      if (err instanceof DuplicatePaymentPreventedError) {
        throw err;
      }
    }
  }

  throw new AllProvidersFailedError(domain, capability, attempts);
}
