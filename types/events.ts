/**
 * types/events.ts
 *
 * Issue #454: Shared Versioned Event Envelope Specification (#454 / Item 027).
 *
 * Unifies Realtime, Webhooks, Analytics, Outbox, and Activity streams under a
 * single shared compatibility contract.
 *
 * Guarantees:
 *  1. Every event carries unique ID, domain type, ISO-8601 time, actor, aggregate root,
 *     and explicit causation/correlation chain.
 *  2. Payload versioning is independent of envelope versioning, supporting schema evolution.
 *  3. Forward compatibility: Consumers safely ignore unknown fields in envelope or payload.
 *  4. Incompatible changes fail validation on both producer and consumer sides.
 */

export const CURRENT_EVENT_SPEC_VERSION = "1.0.0";
export const SUPPORTED_EVENT_SPEC_VERSIONS = ["1.0", "1.0.0"] as const;

export type EventActorType = "user" | "system" | "worker" | "cron" | "anonymous";

export interface EventActor {
  /** Wallet address of the actor, or "system" / "anonymous" */
  wallet: string;
  /** Categorical identity of the actor */
  type: EventActorType;
  /** Optional domain role (e.g. "owner", "member", "support") */
  role?: string | null;
}

export interface EventAggregate {
  /** Aggregate root domain entity type (e.g. "expense", "trip", "settlement") */
  type: string;
  /** Unique ID of the aggregate instance */
  id: string;
  /** Monotonically increasing sequence/version of the aggregate state */
  version?: number | null;
}

export interface EventCausation {
  /** ID linking all events in the same business transaction / command */
  correlationId: string;
  /** ID of the direct message/command/event that caused this event */
  causationId?: string | null;
  /** W3C distributed trace ID for OpenTelemetry propagation */
  traceId?: string | null;
  /** HTTP request ID from the initiating API interaction */
  requestId?: string | null;
}

export type EventChannel = "realtime" | "webhook" | "analytics" | "activity" | "outbox";

export interface EventMetadata extends Record<string, unknown> {
  /** Delivery or ingestion channel */
  channel?: EventChannel | string;
  /** Originating service or component */
  source?: string;
  /** Content type of payload if serialized */
  contentType?: string;
  /** Timestamp when event was dispatched or queued */
  dispatchedAt?: string;
}

/**
 * The standard versioned event envelope.
 */
export interface EventEnvelope<
  TPayload = Record<string, unknown>,
  TMeta extends EventMetadata = EventMetadata
> {
  /** Unique event identifier (UUID or evt_...) */
  id: string;
  /** Domain event type in dot-notation (e.g. "expense.created", "trip.updated") */
  type: string;
  /** ISO-8601 UTC timestamp when the event occurred */
  time: string;
  /** Specification version of this envelope */
  specVersion: string;
  /** Actor context */
  actor: EventActor;
  /** Aggregate root context */
  aggregate: EventAggregate;
  /** Causal chain context */
  causation: EventCausation;
  /** Schema version of the payload contract */
  payloadVersion: number | string;
  /** The domain event payload data */
  payload: TPayload;
  /** Optional transport / audit metadata */
  metadata?: TMeta;
}

export interface EventValidationErrorDetail {
  path: string;
  message: string;
  code: string;
}

export interface EventValidationResult<T = EventEnvelope> {
  valid: boolean;
  event?: T;
  errors: EventValidationErrorDetail[];
}

export type ValidationMode = "produce" | "consume";

export interface EventValidationOptions {
  /**
   * "produce": strict schema validation for outgoing events.
   * "consume": tolerant validation allowing extra/unknown fields (Postel's Law).
   */
  mode?: ValidationMode;
  /** Expected spec versions. Defaults to SUPPORTED_EVENT_SPEC_VERSIONS */
  supportedSpecVersions?: readonly string[];
  /** Expected event type */
  expectedType?: string;
  /** Expected payload version or range */
  expectedPayloadVersion?: number | string;
  /** Whether to allow missing causationId / requestId */
  allowEmptyCausationFields?: boolean;
  /** Whether to validate the payload against registered schema rules (defaults to true) */
  validatePayloadSchema?: boolean;
}
