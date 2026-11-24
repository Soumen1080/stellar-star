import type { ProviderCapability, ProviderRecord } from "./types";

export class IncompatibleProviderError extends Error {
  constructor(providerId: string, requiredCapability: ProviderCapability) {
    super(
      `Provider "${providerId}" does not support required capability "${requiredCapability}". ` +
        "Consistency safety rule violated: cannot substitute incompatible provider.",
    );
    this.name = "IncompatibleProviderError";
  }
}

export class DuplicatePaymentPreventedError extends Error {
  readonly txHash: string;
  constructor(txHash: string) {
    super(
      `Payment transaction ${txHash} was already recorded on-chain during provider failover. ` +
        "Resubmission prevented to eliminate duplicate payment effects.",
    );
    this.name = "DuplicatePaymentPreventedError";
    this.txHash = txHash;
  }
}

/**
 * Validates whether a provider is allowed to perform the given capability.
 * Enforces consistency rule: only providers explicitly possessing the required capability
 * can be used for that operation.
 */
export function assertProviderCapability(
  provider: ProviderRecord,
  requiredCapability: ProviderCapability,
): void {
  if (!provider.capabilities.includes(requiredCapability)) {
    throw new IncompatibleProviderError(provider.id, requiredCapability);
  }
}

/**
 * In-flight payment registry ensuring that concurrent requests for the same
 * transaction hash or idempotency key do not result in duplicate network submissions.
 */
class PaymentSubmissionTracker {
  private readonly inFlightTxs = new Map<string, Promise<any>>();
  private readonly settledTxs = new Set<string>();

  /**
   * Tracks an active submission. If an submission for this hash is already active,
   * returns the existing promise to collapse concurrent calls.
   */
  async track<T>(
    txHash: string,
    submissionFn: () => Promise<T>,
  ): Promise<T> {
    if (this.settledTxs.has(txHash)) {
      throw new DuplicatePaymentPreventedError(txHash);
    }

    const existing = this.inFlightTxs.get(txHash);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        const result = await submissionFn();
        this.settledTxs.add(txHash);
        return result;
      } finally {
        this.inFlightTxs.delete(txHash);
      }
    })();

    this.inFlightTxs.set(txHash, promise);
    return promise;
  }

  isSettled(txHash: string): boolean {
    return this.settledTxs.has(txHash);
  }

  clear(): void {
    this.inFlightTxs.clear();
    this.settledTxs.clear();
  }
}

export const paymentSubmissionTracker = new PaymentSubmissionTracker();
