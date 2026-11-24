/**
 * lib/events/envelope.ts
 *
 * Issue #454: Core validation, construction, and forward-compatible parsing
 * for the versioned event envelope.
 *
 * Implements Postel's Law (Robustness Principle):
 *   - Strict when producing (validates all required fields, formats, versions).
 *   - Tolerant when consuming (safely ignores unknown/extra fields, accepts compatible versions).
 */

import crypto from "node:crypto";
import {
  CURRENT_EVENT_SPEC_VERSION,
  SUPPORTED_EVENT_SPEC_VERSIONS,
  type EventEnvelope,
  type EventActor,
  type EventAggregate,
  type EventCausation,
  type EventMetadata,
  type EventValidationOptions,
  type EventValidationResult,
  type EventValidationErrorDetail,
} from "@/types/events";
import { validateEventPayload } from "./registry";

export class EventEnvelopeError extends Error {
  readonly errors: EventValidationErrorDetail[];

  constructor(message: string, errors: EventValidationErrorDetail[] = []) {
    super(message);
    this.name = "EventEnvelopeError";
    this.errors = errors;
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_TYPE_PATTERN = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const VALID_ACTOR_TYPES = new Set(["user", "system", "worker", "cron", "anonymous"]);

/**
 * Validates an event envelope against the specification.
 */
export function validateEventEnvelope<T = Record<string, unknown>>(
  input: unknown,
  options: EventValidationOptions = {},
): EventValidationResult<EventEnvelope<T>> {
  const errors: EventValidationErrorDetail[] = [];
  const mode = options.mode ?? "consume";
  const supportedVersions = options.supportedSpecVersions ?? SUPPORTED_EVENT_SPEC_VERSIONS;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      valid: false,
      errors: [{ path: "$", message: "Event envelope must be a JSON object.", code: "ENVELOPE_NOT_AN_OBJECT" }],
    };
  }

  const raw = input as Record<string, unknown>;

  // 1. id
  if (typeof raw.id !== "string" || raw.id.trim() === "") {
    errors.push({ path: "id", field: "id", message: "Event 'id' must be a non-empty string.", code: "REQUIRED_FIELD_MISSING" } as any);
  }

  // 2. type
  if (typeof raw.type !== "string" || raw.type.trim() === "") {
    errors.push({ path: "type", field: "type", message: "Event 'type' must be a non-empty string.", code: "REQUIRED_FIELD_MISSING" } as any);
  } else {
    if (!EVENT_TYPE_PATTERN.test(raw.type.trim())) {
      errors.push({
        path: "type",
        field: "type",
        message: `Event 'type' must follow dot-notation (e.g. 'expense.created'). Found '${raw.type}'.`,
        code: "INVALID_EVENT_TYPE_FORMAT",
      } as any);
    }
    if (options.expectedType && raw.type.trim() !== options.expectedType) {
      errors.push({
        path: "type",
        field: "type",
        message: `Expected event type '${options.expectedType}', found '${raw.type}'.`,
        code: "TYPE_MISMATCH",
      } as any);
    }
  }

  // 3. time
  if (typeof raw.time !== "string" || !ISO_DATE_PATTERN.test(raw.time) || isNaN(Date.parse(raw.time))) {
    errors.push({
      path: "time",
      field: "time",
      message: "Event 'time' must be a valid ISO-8601 UTC timestamp string.",
      code: "INVALID_TIMESTAMP",
    } as any);
  }

  // 4. specVersion
  if (typeof raw.specVersion !== "string" || !supportedVersions.includes(raw.specVersion as any)) {
    errors.push({
      path: "specVersion",
      field: "specVersion",
      message: `Event 'specVersion' '${raw.specVersion}' is unsupported. Supported versions: ${supportedVersions.join(", ")}.`,
      code: "UNSUPPORTED_SPEC_VERSION",
    } as any);
  }

  // 5. actor
  if (!raw.actor || typeof raw.actor !== "object" || Array.isArray(raw.actor)) {
    errors.push({ path: "actor", message: "Event 'actor' must be an object.", code: "REQUIRED_FIELD_MISSING" });
  } else {
    const actor = raw.actor as Record<string, unknown>;
    if (typeof actor.wallet !== "string" || actor.wallet.trim() === "") {
      errors.push({ path: "actor.wallet", message: "Actor 'wallet' must be a non-empty string.", code: "REQUIRED_FIELD_MISSING" });
    }
    if (typeof actor.type !== "string" || !VALID_ACTOR_TYPES.has(actor.type)) {
      errors.push({
        path: "actor.type",
        message: `Actor 'type' must be one of: ${Array.from(VALID_ACTOR_TYPES).join(", ")}. Found '${actor.type}'.`,
        code: "INVALID_ACTOR_TYPE",
      });
    }
  }

  // 6. aggregate
  if (!raw.aggregate || typeof raw.aggregate !== "object" || Array.isArray(raw.aggregate)) {
    errors.push({ path: "aggregate", message: "Event 'aggregate' must be an object.", code: "REQUIRED_FIELD_MISSING" });
  } else {
    const aggregate = raw.aggregate as Record<string, unknown>;
    if (typeof aggregate.type !== "string" || aggregate.type.trim() === "") {
      errors.push({ path: "aggregate.type", message: "Aggregate 'type' must be a non-empty string.", code: "REQUIRED_FIELD_MISSING" });
    }
    if (typeof aggregate.id !== "string" || aggregate.id.trim() === "") {
      errors.push({ path: "aggregate.id", message: "Aggregate 'id' must be a non-empty string.", code: "REQUIRED_FIELD_MISSING" });
    }
    if (aggregate.version !== undefined && aggregate.version !== null) {
      if (typeof aggregate.version !== "number" || !Number.isInteger(aggregate.version) || aggregate.version < 0) {
        errors.push({
          path: "aggregate.version",
          message: "Aggregate 'version' must be a non-negative integer.",
          code: "INVALID_AGGREGATE_VERSION",
        });
      }
    }
  }

  // 7. causation
  if (!raw.causation || typeof raw.causation !== "object" || Array.isArray(raw.causation)) {
    errors.push({ path: "causation", message: "Event 'causation' must be an object.", code: "REQUIRED_FIELD_MISSING" });
  } else {
    const causation = raw.causation as Record<string, unknown>;
    if (typeof causation.correlationId !== "string" || causation.correlationId.trim() === "") {
      errors.push({
        path: "causation.correlationId",
        message: "Causation 'correlationId' must be a non-empty string.",
        code: "REQUIRED_FIELD_MISSING",
      });
    }
  }

  // 8. payloadVersion
  if (
    raw.payloadVersion === undefined ||
    raw.payloadVersion === null ||
    (typeof raw.payloadVersion !== "number" && typeof raw.payloadVersion !== "string") ||
    (typeof raw.payloadVersion === "number" && (!Number.isInteger(raw.payloadVersion) || raw.payloadVersion <= 0)) ||
    (typeof raw.payloadVersion === "string" && raw.payloadVersion.trim() === "")
  ) {
    errors.push({
      path: "payloadVersion",
      message: "Event 'payloadVersion' must be a positive integer or non-empty version string.",
      code: "INVALID_PAYLOAD_VERSION",
    });
  } else if (options.expectedPayloadVersion !== undefined) {
    if (String(raw.payloadVersion) !== String(options.expectedPayloadVersion)) {
      errors.push({
        path: "payloadVersion",
        message: `Expected payload version '${options.expectedPayloadVersion}', found '${raw.payloadVersion}'.`,
        code: "PAYLOAD_VERSION_MISMATCH",
      });
    }
  }

  // 9. payload
  if (raw.payload === undefined || raw.payload === null || typeof raw.payload !== "object" || Array.isArray(raw.payload)) {
    errors.push({ path: "payload", message: "Event 'payload' must be an object.", code: "REQUIRED_FIELD_MISSING" });
  } else if (options.validatePayloadSchema !== false && typeof raw.type === "string" && raw.payloadVersion !== undefined) {
    const payloadResult = validateEventPayload(
      raw.type,
      raw.payloadVersion as string | number,
      raw.payload as Record<string, unknown>,
    );
    if (!payloadResult.valid) {
      for (const err of payloadResult.errors) {
        errors.push({
          path: `payload.${err}`,
          field: "payload",
          message: err,
          code: "PAYLOAD_SCHEMA_INVALID",
        } as any);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // In consume mode, preserve the original object (with any unknown fields safely ignored by typed consumers)
  return {
    valid: true,
    event: input as EventEnvelope<T>,
    errors: [],
  };
}

/**
 * Creates a valid, strongly-typed event envelope with deterministic defaults.
 */
export function createEventEnvelope<
  TPayload = Record<string, unknown>,
  TMeta extends EventMetadata = EventMetadata
>({
  id = crypto.randomUUID(),
  type,
  time = new Date().toISOString(),
  specVersion = CURRENT_EVENT_SPEC_VERSION,
  actor,
  aggregate,
  causation,
  payloadVersion = 1,
  payload,
  metadata,
}: {
  id?: string;
  type: string;
  time?: string;
  specVersion?: string;
  actor: EventActor;
  aggregate: EventAggregate;
  causation: EventCausation;
  payloadVersion?: number | string;
  payload: TPayload;
  metadata?: TMeta;
}): EventEnvelope<TPayload, TMeta> {
  const envelope: EventEnvelope<TPayload, TMeta> = {
    id,
    type,
    time,
    specVersion,
    actor,
    aggregate,
    causation,
    payloadVersion,
    payload,
    ...(metadata ? { metadata } : {}),
  };

  const validation = validateEventEnvelope(envelope, { mode: "produce" });
  if (!validation.valid) {
    const summary = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new EventEnvelopeError(`Failed to create valid event envelope: ${summary}`, validation.errors);
  }

  return envelope;
}

/**
 * Serializes an envelope to a canonical JSON string.
 */
export function serializeEventEnvelope<T = Record<string, unknown>>(envelope: EventEnvelope<T>): string {
  const validation = validateEventEnvelope(envelope, { mode: "produce" });
  if (!validation.valid) {
    throw new EventEnvelopeError("Cannot serialize invalid event envelope.", validation.errors);
  }
  return JSON.stringify(envelope);
}

/**
 * Deserializes and validates a JSON string or raw object into a typed EventEnvelope.
 * Safely ignores unknown fields in accordance with Postel's Law.
 */
export function deserializeEventEnvelope<T = Record<string, unknown>>(
  input: string | unknown,
  options: EventValidationOptions = { mode: "consume" },
): EventEnvelope<T> {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new EventEnvelopeError("Invalid JSON input for event envelope.", [
        { path: "$", message: "JSON parsing failed.", code: "INVALID_JSON" },
      ]);
    }
  }

  const result = validateEventEnvelope<T>(parsed, options);
  if (!result.valid || !result.event) {
    const summary = result.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new EventEnvelopeError(`Event envelope validation failed: ${summary}`, result.errors);
  }

  return result.event;
}
