/**
 * types/outbox.ts
 *
 * Domain types for Transactional Outbox Pattern (#425 / Issue 017).
 *
 * Guarantees:
 * 1. Atomically captures state transitions and external consequences.
 * 2. Leased workers retry delivery with exponential backoff and jitter.
 * 3. Enforces deduplication and distributed W3C trace ID propagation.
 * 4. Preserves decimal-string money precision across webhook/reminder/analytics boundaries.
 */

export type OutboxEventStatus =
  | "pending"
  | "leased"
  | "delivered"
  | "failed"
  | "dead_letter";

export type OutboxChannel = "webhook" | "reminder" | "analytics";

export type OutboxAggregateType =
  | "expense"
  | "settlement"
  | "trip"
  | "reminder"
  | "dispute";

export interface OutboxEvent {
  id: string;
  aggregateType: OutboxAggregateType | string;
  aggregateId: string;
  eventType: string;
  channel: OutboxChannel;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  traceId: string;
  deduplicationKey: string;
  status: OutboxEventStatus;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  leaseId: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  nextAttemptAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  errorMessage: string | null;
  createdByWallet?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEventInsert {
  id?: string;
  aggregateType: OutboxAggregateType | string;
  aggregateId: string;
  eventType: string;
  channel: OutboxChannel;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  traceId: string;
  deduplicationKey: string;
  status?: OutboxEventStatus;
  attempts?: number;
  maxAttempts?: number;
  backoffMs?: number;
  createdByWallet?: string | null;
  nextAttemptAt?: string;
}

export interface OutboxDispatchResult {
  success: boolean;
  statusCode?: number;
  externalDeliveryId?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export type OutboxDispatchFn = (
  event: OutboxEvent
) => Promise<OutboxDispatchResult>;

export interface OutboxDispatcherRegistry {
  webhook?: OutboxDispatchFn;
  reminder?: OutboxDispatchFn;
  analytics?: OutboxDispatchFn;
}

export interface OutboxWorkerOptions {
  workerId?: string;
  batchSize?: number;
  leaseDurationSeconds?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterFactor?: number;
  dispatcher?: OutboxDispatcherRegistry;
}

export interface OutboxWorkerRunResult {
  workerId: string;
  claimedCount: number;
  deliveredCount: number;
  retriedCount: number;
  deadLetterCount: number;
  durationMs: number;
  events: {
    id: string;
    deduplicationKey: string;
    channel: OutboxChannel;
    status: OutboxEventStatus;
    attempts: number;
    error?: string;
  }[];
}
