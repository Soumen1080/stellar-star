/**
 * lib/outbox/worker.ts
 *
 * Leased Worker Engine for Transactional Outbox (#425 / Issue 017).
 *
 * Guarantees:
 * 1. Leased Claims: Multiple worker nodes coordinate via SELECT ... FOR UPDATE SKIP LOCKED.
 * 2. Deduplication: Idempotent external dispatch prevents duplicate consequences.
 * 3. Exponential Backoff with Jitter: Failed deliveries back off exponentially
 *    with bounded randomization to prevent thundering herds.
 * 4. Dead-Letter Queue: Terminal failures transition to 'dead_letter' for operator review.
 * 5. Trace Context: W3C trace ID propagated across every retry attempt.
 */

import {
  type OutboxEvent,
  type OutboxWorkerOptions,
  type OutboxWorkerRunResult,
} from "./types";
import {
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
} from "./repository";
import { getDispatcherForChannel } from "./dispatcher";
import { type StellarStarClient } from "@/lib/supabase/client";

export const DEFAULT_WORKER_BATCH_SIZE = 10;
export const DEFAULT_LEASE_DURATION_SECONDS = 60;
export const DEFAULT_BASE_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_JITTER_FACTOR = 0.2; // +/- 20%

/**
 * Calculates exponential backoff with bounded randomized jitter.
 */
export function calculateBackoff(
  attempt: number,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  jitterFactor = DEFAULT_JITTER_FACTOR
): number {
  const exponent = Math.max(0, attempt - 1);
  const rawBackoff = Math.min(baseBackoffMs * Math.pow(2, exponent), maxBackoffMs);
  const jitterRange = rawBackoff * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.max(100, Math.floor(rawBackoff + jitter));
}

/**
 * Executes a leased outbox worker batch.
 */
export async function runOutboxWorkerBatch(
  options: OutboxWorkerOptions = {},
  client?: StellarStarClient
): Promise<OutboxWorkerRunResult> {
  const startTime = Date.now();
  const workerId =
    options.workerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
  const batchSize = options.batchSize || DEFAULT_WORKER_BATCH_SIZE;
  const leaseDurationSeconds =
    options.leaseDurationSeconds || DEFAULT_LEASE_DURATION_SECONDS;
  const baseBackoffMs = options.baseBackoffMs || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs || DEFAULT_MAX_BACKOFF_MS;
  const jitterFactor = options.jitterFactor ?? DEFAULT_JITTER_FACTOR;

  // 1. Claim a leased batch of pending / expired / retryable rows
  const leasedEvents = await claimOutboxBatch(
    workerId,
    batchSize,
    leaseDurationSeconds,
    client
  );

  let deliveredCount = 0;
  let retriedCount = 0;
  let deadLetterCount = 0;
  const eventSummaries: OutboxWorkerRunResult["events"] = [];

  // 2. Process each claimed event
  for (const event of leasedEvents) {
    const dispatcher = getDispatcherForChannel(
      event.channel,
      options.dispatcher
    );

    if (!dispatcher) {
      const err = `No dispatcher registered for channel '${event.channel}'`;
      await failOutboxEvent(event.id, workerId, err, baseBackoffMs, client);
      deadLetterCount += 1;
      eventSummaries.push({
        id: event.id,
        deduplicationKey: event.deduplicationKey,
        channel: event.channel,
        status: "dead_letter",
        attempts: event.attempts,
        error: err,
      });
      continue;
    }

    try {
      // Execute external dispatch with trace propagation & deduplication key
      const dispatchResult = await dispatcher(event);

      if (dispatchResult.success) {
        // Complete event and release lease
        await completeOutboxEvent(event.id, workerId, client);
        deliveredCount += 1;
        eventSummaries.push({
          id: event.id,
          deduplicationKey: event.deduplicationKey,
          channel: event.channel,
          status: "delivered",
          attempts: event.attempts,
        });
      } else {
        // Handle failure
        const isDeadLetter = event.attempts >= event.maxAttempts;
        const backoffMs = calculateBackoff(
          event.attempts,
          baseBackoffMs,
          maxBackoffMs,
          jitterFactor
        );

        await failOutboxEvent(
          event.id,
          workerId,
          dispatchResult.errorMessage || "Dispatch failed",
          backoffMs,
          client
        );

        if (isDeadLetter) {
          deadLetterCount += 1;
          eventSummaries.push({
            id: event.id,
            deduplicationKey: event.deduplicationKey,
            channel: event.channel,
            status: "dead_letter",
            attempts: event.attempts,
            error: dispatchResult.errorMessage,
          });
        } else {
          retriedCount += 1;
          eventSummaries.push({
            id: event.id,
            deduplicationKey: event.deduplicationKey,
            channel: event.channel,
            status: "failed",
            attempts: event.attempts,
            error: dispatchResult.errorMessage,
          });
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unexpected worker exception";
      const isDeadLetter = event.attempts >= event.maxAttempts;
      const backoffMs = calculateBackoff(
        event.attempts,
        baseBackoffMs,
        maxBackoffMs,
        jitterFactor
      );

      await failOutboxEvent(
        event.id,
        workerId,
        errorMessage,
        backoffMs,
        client
      );

      if (isDeadLetter) {
        deadLetterCount += 1;
        eventSummaries.push({
          id: event.id,
          deduplicationKey: event.deduplicationKey,
          channel: event.channel,
          status: "dead_letter",
          attempts: event.attempts,
          error: errorMessage,
        });
      } else {
        retriedCount += 1;
        eventSummaries.push({
          id: event.id,
          deduplicationKey: event.deduplicationKey,
          channel: event.channel,
          status: "failed",
          attempts: event.attempts,
          error: errorMessage,
        });
      }
    }
  }

  return {
    workerId,
    claimedCount: leasedEvents.length,
    deliveredCount,
    retriedCount,
    deadLetterCount,
    durationMs: Date.now() - startTime,
    events: eventSummaries,
  };
}
