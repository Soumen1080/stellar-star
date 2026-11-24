/**
 * lib/events/adapters.ts
 *
 * Issue #454: Channel adapters mapping domain channels (Outbox, Webhook,
 * Realtime, Analytics) to and from the standardized EventEnvelope contract.
 */

import type { EventEnvelope, EventChannel } from "@/types/events";
import type { OutboxEvent, OutboxEventInsert } from "@/types/outbox";
import { createEventEnvelope, deserializeEventEnvelope, serializeEventEnvelope } from "./envelope";

/**
 * Converts a database Transactional Outbox event row into a standardized EventEnvelope.
 */
export function outboxEventToEnvelope<T = Record<string, unknown>>(
  row: OutboxEvent | Record<string, any>,
): EventEnvelope<T> {
  const raw = row as Record<string, any>;
  const eventType = raw.eventType || raw.event_type;
  const aggregateType = raw.aggregateType || raw.aggregate_type;
  const aggregateId = raw.aggregateId || raw.aggregate_id;
  const aggregateVersion = raw.aggregateVersion || raw.aggregate_version;
  const actorWallet = raw.createdByWallet || raw.actor_wallet || raw.actorWallet || "system";
  const actorType = raw.actorType || raw.actor_type || (actorWallet !== "system" ? "user" : "system");
  const createdAt = raw.createdAt || raw.created_at || new Date().toISOString();
  const traceId = raw.traceId || raw.trace_id;
  const correlationId = raw.deduplicationKey || raw.correlation_id || raw.correlationId || traceId || raw.id;
  const causationId = raw.headers?.causationId ?? raw.headers?.["x-causation-id"] ?? raw.causation_id ?? raw.causationId ?? null;
  const requestId = raw.headers?.requestId ?? raw.headers?.["x-request-id"] ?? raw.request_id ?? raw.requestId ?? null;
  const payloadVersion = raw.payloadVersion || raw.payload_version || (raw.headers?.payloadVersion as string) || 1;
  const channel = raw.channel || "outbox";

  return createEventEnvelope<T>({
    id: raw.id,
    type: eventType,
    time: createdAt,
    actor: {
      wallet: actorWallet,
      type: actorType,
    },
    aggregate: {
      type: String(aggregateType),
      id: aggregateId,
      ...(aggregateVersion !== undefined ? { version: Number(aggregateVersion) } : {}),
    },
    causation: {
      correlationId,
      causationId,
      traceId,
      requestId,
    },
    payloadVersion,
    payload: (raw.payload ?? {}) as T,
    metadata: {
      channel,
      source: "outbox",
    },
  });
}

/**
 * Converts an EventEnvelope into a Transactional Outbox insertion payload.
 */
export function envelopeToOutboxInsert<T = Record<string, unknown>>(
  envelope: EventEnvelope<T>,
  channel: EventChannel = "webhook",
): OutboxEventInsert & {
  event_type?: string;
  aggregate_type?: string;
  aggregate_id?: string;
  actor_wallet?: string | null;
  correlation_id?: string;
  payload_version?: number | string;
} {
  return {
    id: envelope.id,
    aggregateType: envelope.aggregate.type,
    aggregateId: envelope.aggregate.id,
    eventType: envelope.type,
    channel: channel as any,
    payload: envelope.payload as Record<string, unknown>,
    traceId: envelope.causation.traceId || envelope.causation.correlationId,
    deduplicationKey: envelope.causation.correlationId || envelope.id,
    createdByWallet: envelope.actor.wallet !== "system" ? envelope.actor.wallet : null,
    headers: {
      specVersion: envelope.specVersion,
      payloadVersion: String(envelope.payloadVersion),
      correlationId: envelope.causation.correlationId,
      ...(envelope.causation.causationId ? { causationId: envelope.causation.causationId } : {}),
      ...(envelope.causation.requestId ? { requestId: envelope.causation.requestId } : {}),
    },
    // Database snake_case aliases for convenience
    event_type: envelope.type,
    aggregate_type: envelope.aggregate.type,
    aggregate_id: envelope.aggregate.id,
    actor_wallet: envelope.actor.wallet !== "system" ? envelope.actor.wallet : null,
    correlation_id: envelope.causation.correlationId,
    payload_version: envelope.payloadVersion,
  };
}

/**
 * Formats an event for webhook HTTP transmission.
 */
export function envelopeToWebhookPayload<T = Record<string, unknown>>(
  envelope: EventEnvelope<T>,
): {
  idempotencyKey: string;
  eventType: string;
  time: string;
  data: {
    envelope: EventEnvelope<T>;
    payload: T;
  };
} {
  return {
    idempotencyKey: envelope.id,
    eventType: envelope.type,
    time: envelope.time,
    data: {
      envelope,
      payload: envelope.payload,
    },
  };
}

/**
 * Parses an incoming webhook payload into a verified EventEnvelope.
 * Safely ignores unknown fields (consumer forward-compatibility).
 */
export function webhookPayloadToEnvelope<T = Record<string, unknown>>(
  raw: unknown,
): EventEnvelope<T> {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    const dataObj = (raw as Record<string, any>).data;
    if (dataObj && typeof dataObj === "object" && dataObj.envelope) {
      return deserializeEventEnvelope<T>(dataObj.envelope, { mode: "consume" });
    }
  }
  return deserializeEventEnvelope<T>(raw, { mode: "consume" });
}

/**
 * Prepares an envelope for Supabase Realtime broadcast channels.
 */
export function envelopeToRealtimeBroadcast<T = Record<string, unknown>>(
  envelope: EventEnvelope<T>,
): {
  event: string;
  correlationId: string;
  payload: T;
  _envelope: EventEnvelope<T>;
} {
  return {
    event: envelope.type,
    correlationId: envelope.causation.correlationId,
    payload: envelope.payload,
    _envelope: envelope,
  };
}

/**
 * Ingests a message from Supabase Realtime broadcast into an EventEnvelope.
 */
export function realtimeBroadcastToEnvelope<T = Record<string, unknown>>(
  broadcastPayload: unknown,
): EventEnvelope<T> {
  if (broadcastPayload && typeof broadcastPayload === "object") {
    const obj = broadcastPayload as Record<string, any>;
    if (obj._envelope) {
      return deserializeEventEnvelope<T>(obj._envelope, { mode: "consume" });
    }
    if (obj.payload && typeof obj.payload === "object" && obj.payload.id && obj.payload.type) {
      return deserializeEventEnvelope<T>(obj.payload, { mode: "consume" });
    }
  }
  return deserializeEventEnvelope<T>(broadcastPayload, { mode: "consume" });
}
