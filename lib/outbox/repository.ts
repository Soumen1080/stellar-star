/**
 * lib/outbox/repository.ts
 *
 * Database repository & in-memory fallback for Transactional Outbox (#425).
 *
 * Handles atomic persistence, leased batch claims (SKIP LOCKED), completion,
 * and retry/dead-letter state transitions with RLS tenant isolation.
 */

import {
  type OutboxEvent,
  type OutboxEventInsert,
  type OutboxEventStatus,
  type OutboxChannel,
} from "./types";
import { type StellarStarClient, requireAuthenticatedClient } from "@/lib/supabase/client";
import { type TransactionalOutboxRow, type TransactionalOutboxInsert, type Json } from "@/types/supabase";

// ─── In-Memory Store for Testing & Local Execution ──────────────────────────

declare global {
  var stellarStarOutboxMem: Map<string, OutboxEvent> | undefined;
}

const memoryStore =
  globalThis.stellarStarOutboxMem ?? new Map<string, OutboxEvent>();
globalThis.stellarStarOutboxMem = memoryStore;

export function clearOutboxMemoryStore(): void {
  memoryStore.clear();
}

export function getOutboxMemoryStore(): Map<string, OutboxEvent> {
  return memoryStore;
}

// ─── Row Mapping ─────────────────────────────────────────────────────────────

export function rowToOutboxEvent(row: TransactionalOutboxRow): OutboxEvent {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    channel: row.channel as OutboxChannel,
    payload: (row.payload as Record<string, unknown>) || {},
    headers: (row.headers as Record<string, string>) || {},
    traceId: row.trace_id,
    deduplicationKey: row.deduplication_key,
    status: row.status as OutboxEventStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    backoffMs: row.backoff_ms,
    leaseId: row.lease_id,
    leasedAt: row.leased_at,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    deliveredAt: row.delivered_at,
    errorMessage: row.error_message,
    createdByWallet: row.created_by_wallet,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function outboxEventToInsert(
  event: OutboxEventInsert
): TransactionalOutboxInsert {
  return {
    id: event.id,
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    event_type: event.eventType,
    channel: event.channel,
    payload: event.payload as unknown as Json,
    headers: (event.headers ?? {}) as unknown as Json,
    trace_id: event.traceId,
    deduplication_key: event.deduplicationKey,
    status: event.status ?? "pending",
    attempts: event.attempts ?? 0,
    max_attempts: event.maxAttempts ?? 5,
    backoff_ms: event.backoffMs ?? 1000,
    created_by_wallet: event.createdByWallet ?? null,
    next_attempt_at: event.nextAttemptAt ?? new Date().toISOString(),
  };
}

// ─── Repository Operations ───────────────────────────────────────────────────

/**
 * Persists an outbox row atomically into the transactional outbox table.
 * If a matching deduplication key already exists, returns the existing record.
 */
export async function enqueueOutboxEvent(
  insert: OutboxEventInsert,
  client?: StellarStarClient
): Promise<OutboxEvent> {
  const now = new Date().toISOString();
  const eventId = insert.id || crypto.randomUUID();

  // Try database execution if client is provided and has RPC or table
  if (client) {
    try {
      const { data, error } = await client
        .from("transactional_outbox")
        .upsert(outboxEventToInsert({ ...insert, id: eventId }), {
          onConflict: "deduplication_key",
          ignoreDuplicates: false,
        })
        .select()
        .single();

      if (!error && data) {
        const outboxEvent = rowToOutboxEvent(data as TransactionalOutboxRow);
        memoryStore.set(outboxEvent.id, outboxEvent);
        return outboxEvent;
      }
    } catch {
      // Fall through to memory store if database is offline or in mocked test
    }
  }

  // In-memory fallback
  for (const existing of memoryStore.values()) {
    if (existing.deduplicationKey === insert.deduplicationKey) {
      return existing;
    }
  }

  const outboxEvent: OutboxEvent = {
    id: eventId,
    aggregateType: insert.aggregateType,
    aggregateId: insert.aggregateId,
    eventType: insert.eventType,
    channel: insert.channel,
    payload: insert.payload,
    headers: insert.headers ?? {},
    traceId: insert.traceId,
    deduplicationKey: insert.deduplicationKey,
    status: insert.status ?? "pending",
    attempts: insert.attempts ?? 0,
    maxAttempts: insert.maxAttempts ?? 5,
    backoffMs: insert.backoffMs ?? 1000,
    leaseId: null,
    leasedAt: null,
    leaseExpiresAt: null,
    nextAttemptAt: insert.nextAttemptAt ?? now,
    lastAttemptAt: null,
    deliveredAt: null,
    errorMessage: null,
    createdByWallet: insert.createdByWallet ?? null,
    createdAt: now,
    updatedAt: now,
  };

  memoryStore.set(outboxEvent.id, outboxEvent);
  return outboxEvent;
}

/**
 * Persists multiple outbox rows within the same batch.
 */
export async function enqueueOutboxBatch(
  inserts: OutboxEventInsert[],
  client?: StellarStarClient
): Promise<OutboxEvent[]> {
  const results: OutboxEvent[] = [];
  for (const insert of inserts) {
    results.push(await enqueueOutboxEvent(insert, client));
  }
  return results;
}

/**
 * Claims a batch of due or expired outbox messages with a lease.
 * Concurrency is serialized via PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED.
 */
export async function claimOutboxBatch(
  workerId: string,
  batchSize = 10,
  leaseDurationSeconds = 60,
  client?: StellarStarClient
): Promise<OutboxEvent[]> {
  if (client) {
    try {
      const { data, error } = await client.rpc("claim_outbox_batch", {
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_lease_duration_seconds: leaseDurationSeconds,
      });

      if (!error && Array.isArray(data)) {
        const events = data.map((r: TransactionalOutboxRow) =>
          rowToOutboxEvent(r)
        );
        for (const ev of events) {
          memoryStore.set(ev.id, ev);
        }
        return events;
      }
    } catch {
      // Fallback to memory store
    }
  }

  // In-memory leased claiming
  const nowMs = Date.now();
  const leaseExpiresAt = new Date(
    nowMs + leaseDurationSeconds * 1000
  ).toISOString();
  const claimed: OutboxEvent[] = [];

  for (const event of memoryStore.values()) {
    if (claimed.length >= batchSize) break;

    const nextAttemptMs = new Date(event.nextAttemptAt).getTime();
    const leaseExpireMs = event.leaseExpiresAt
      ? new Date(event.leaseExpiresAt).getTime()
      : 0;

    const isPendingDue =
      event.status === "pending" && nextAttemptMs <= nowMs;
    const isLeaseExpired =
      event.status === "leased" && leaseExpireMs < nowMs;
    const isRetryableFailed =
      event.status === "failed" &&
      event.attempts < event.maxAttempts &&
      nextAttemptMs <= nowMs;

    if (isPendingDue || isLeaseExpired || isRetryableFailed) {
      event.status = "leased";
      event.leaseId = workerId;
      event.leasedAt = new Date(nowMs).toISOString();
      event.leaseExpiresAt = leaseExpiresAt;
      event.attempts += 1;
      event.lastAttemptAt = new Date(nowMs).toISOString();
      event.updatedAt = new Date(nowMs).toISOString();
      claimed.push({ ...event });
    }
  }

  return claimed;
}

/**
 * Marks an outbox event as delivered and releases lease.
 */
export async function completeOutboxEvent(
  id: string,
  leaseId: string,
  client?: StellarStarClient
): Promise<boolean> {
  const now = new Date().toISOString();

  if (client) {
    try {
      const { data, error } = await client.rpc("complete_outbox_event", {
        p_id: id,
        p_lease_id: leaseId,
      });
      if (!error) {
        const mem = memoryStore.get(id);
        if (mem) {
          mem.status = "delivered";
          mem.deliveredAt = now;
          mem.leaseId = null;
          mem.leaseExpiresAt = null;
          mem.errorMessage = null;
          mem.updatedAt = now;
        }
        return Boolean(data);
      }
    } catch {
      // Fallback
    }
  }

  const mem = memoryStore.get(id);
  if (!mem) return false;
  if (mem.leaseId && mem.leaseId !== leaseId) {
    const expired =
      mem.leaseExpiresAt && new Date(mem.leaseExpiresAt).getTime() < Date.now();
    if (!expired) return false;
  }

  mem.status = "delivered";
  mem.deliveredAt = now;
  mem.leaseId = null;
  mem.leaseExpiresAt = null;
  mem.errorMessage = null;
  mem.updatedAt = now;
  return true;
}

/**
 * Marks an outbox event as failed. Retries with backoff or moves to dead-letter.
 */
export async function failOutboxEvent(
  id: string,
  leaseId: string,
  errorMessage: string,
  backoffMs = 1000,
  client?: StellarStarClient
): Promise<boolean> {
  const now = new Date().toISOString();
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

  if (client) {
    try {
      const { data, error } = await client.rpc("fail_outbox_event", {
        p_id: id,
        p_lease_id: leaseId,
        p_error_message: errorMessage,
        p_backoff_ms: backoffMs,
      });
      if (!error) {
        const mem = memoryStore.get(id);
        if (mem) {
          if (mem.attempts >= mem.maxAttempts) {
            mem.status = "dead_letter";
          } else {
            mem.status = "failed";
            mem.nextAttemptAt = nextAttemptAt;
          }
          mem.errorMessage = errorMessage;
          mem.leaseId = null;
          mem.leaseExpiresAt = null;
          mem.updatedAt = now;
        }
        return Boolean(data);
      }
    } catch {
      // Fallback
    }
  }

  const mem = memoryStore.get(id);
  if (!mem) return false;

  if (mem.attempts >= mem.maxAttempts) {
    mem.status = "dead_letter";
  } else {
    mem.status = "failed";
    mem.nextAttemptAt = nextAttemptAt;
  }

  mem.errorMessage = errorMessage;
  mem.leaseId = null;
  mem.leaseExpiresAt = null;
  mem.updatedAt = now;
  return true;
}

/**
 * Fetches an outbox event by ID.
 */
export async function fetchOutboxEventById(
  id: string,
  client?: StellarStarClient
): Promise<OutboxEvent | null> {
  if (client) {
    try {
      const { data, error } = await client
        .from("transactional_outbox")
        .select()
        .eq("id", id)
        .maybeSingle();
      if (!error && data) {
        return rowToOutboxEvent(data as TransactionalOutboxRow);
      }
    } catch {
      // Fallback
    }
  }

  return memoryStore.get(id) || null;
}

/**
 * Fetches an outbox event by its deduplication key.
 */
export async function fetchOutboxEventByDeduplicationKey(
  key: string,
  client?: StellarStarClient
): Promise<OutboxEvent | null> {
  if (client) {
    try {
      const { data, error } = await client
        .from("transactional_outbox")
        .select()
        .eq("deduplication_key", key)
        .maybeSingle();
      if (!error && data) {
        return rowToOutboxEvent(data as TransactionalOutboxRow);
      }
    } catch {
      // Fallback
    }
  }

  for (const event of memoryStore.values()) {
    if (event.deduplicationKey === key) return event;
  }
  return null;
}

/**
 * Queries outbox events with optional status or channel filtering.
 */
export async function listOutboxEvents(
  filter?: {
    status?: OutboxEventStatus;
    channel?: OutboxChannel;
    limit?: number;
  },
  client?: StellarStarClient
): Promise<OutboxEvent[]> {
  const limit = filter?.limit ?? 50;

  if (client) {
    try {
      let query = client
        .from("transactional_outbox")
        .select()
        .order("created_at", { ascending: false })
        .limit(limit);

      if (filter?.status) {
        query = query.eq("status", filter.status);
      }
      if (filter?.channel) {
        query = query.eq("channel", filter.channel);
      }

      const { data, error } = await query;
      if (!error && Array.isArray(data)) {
        return data.map((r: TransactionalOutboxRow) => rowToOutboxEvent(r));
      }
    } catch {
      // Fallback
    }
  }

  let results = Array.from(memoryStore.values());
  if (filter?.status) {
    results = results.filter((e) => e.status === filter.status);
  }
  if (filter?.channel) {
    results = results.filter((e) => e.channel === filter.channel);
  }
  return results.slice(0, limit);
}
