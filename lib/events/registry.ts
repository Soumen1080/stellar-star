/**
 * lib/events/registry.ts
 *
 * Issue #454: Event Payload Schemas, Registry, and Version Validation.
 *
 * Validates payload structures for registered domain events across
 * Realtime, Webhooks, Analytics, Outbox, and Activity streams.
 */

export interface PayloadValidationRule {
  field: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  pattern?: RegExp;
}

export interface RegisteredEventSchema {
  type: string;
  version: number | string;
  description: string;
  rules: PayloadValidationRule[];
}

/** Registry of canonical domain event schemas */
export const DOMAIN_EVENT_REGISTRY: Record<string, Record<string | number, RegisteredEventSchema>> = {
  "expense.created": {
    1: {
      type: "expense.created",
      version: 1,
      description: "An expense was created within a trip",
      rules: [
        { field: "expenseId", type: "string", required: true },
        { field: "tripId", type: "string", required: true },
        { field: "amount", type: "string", required: true }, // Decimal string
        { field: "currency", type: "string", required: true },
        { field: "payerWallet", type: "string", required: true },
      ],
    },
  },
  "expense.updated": {
    1: {
      type: "expense.updated",
      version: 1,
      description: "An expense was updated or split adjusted",
      rules: [
        { field: "expenseId", type: "string", required: true },
        { field: "tripId", type: "string", required: true },
      ],
    },
  },
  "settlement.completed": {
    1: {
      type: "settlement.completed",
      version: 1,
      description: "On-chain or off-chain debt settlement completed",
      rules: [
        { field: "settlementId", type: "string", required: true },
        { field: "tripId", type: "string", required: true },
        { field: "amount", type: "string", required: true },
        { field: "currency", type: "string", required: true },
      ],
    },
  },
  "trip.member_joined": {
    1: {
      type: "trip.member_joined",
      version: 1,
      description: "A new member claimed an invitation and joined a trip",
      rules: [
        { field: "tripId", type: "string", required: true },
        { field: "memberWallet", type: "string", required: true },
      ],
    },
  },
  "receipt.scanned": {
    1: {
      type: "receipt.scanned",
      version: 1,
      description: "Receipt upload passed malware scan and was quarantined or promoted",
      rules: [
        { field: "receiptId", type: "string", required: true },
        { field: "tripId", type: "string", required: true },
      ],
    },
  },
  "analytics.tracked": {
    1: {
      type: "analytics.tracked",
      version: 1,
      description: "Client or server behavioral telemetry measurement",
      rules: [
        { field: "eventName", type: "string", required: true },
        { field: "properties", type: "object", required: true },
      ],
    },
  },
};

/**
 * Validates a payload against registered domain schema rules.
 * Unknown extra fields are permitted (forward-compatible).
 */
export function validateEventPayload(
  eventType: string,
  payloadVersionOrPayload: number | string | Record<string, unknown>,
  maybePayload?: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  let payloadVersion: number | string = 1;
  let payload: Record<string, unknown> = {};

  if (typeof payloadVersionOrPayload === "number" || typeof payloadVersionOrPayload === "string") {
    payloadVersion = payloadVersionOrPayload;
    if (!maybePayload || typeof maybePayload !== "object" || Array.isArray(maybePayload)) {
      return { valid: false, errors: ["Event payload must be an object."] };
    }
    payload = maybePayload;
  } else if (payloadVersionOrPayload && typeof payloadVersionOrPayload === "object" && !Array.isArray(payloadVersionOrPayload)) {
    payload = payloadVersionOrPayload as Record<string, unknown>;
  } else {
    return { valid: false, errors: ["Event payload must be an object."] };
  }

  const typeSchemas = DOMAIN_EVENT_REGISTRY[eventType];
  if (!typeSchemas) {
    // Unregistered event type: passes open validation if payload is an object
    return { valid: true, errors: [] };
  }

  const schema = typeSchemas[payloadVersion];
  if (!schema) {
    return {
      valid: false,
      errors: [
        `Unsupported payloadVersion '${payloadVersion}' for event type '${eventType}'. Supported versions: ${Object.keys(
          typeSchemas,
        ).join(", ")}.`,
      ],
    };
  }

  const errors: string[] = [];

  for (const rule of schema.rules) {
    const val = payload[rule.field];

    if (val === undefined || val === null) {
      if (rule.required) {
        errors.push(`Missing required payload field '${rule.field}' for '${eventType}' v${payloadVersion}.`);
      }
      continue;
    }

    const actualType = Array.isArray(val) ? "array" : typeof val;
    if (actualType !== rule.type) {
      errors.push(
        `Payload field '${rule.field}' must be of type '${rule.type}'. Received '${actualType}'.`,
      );
      continue;
    }

    if (rule.pattern && typeof val === "string" && !rule.pattern.test(val)) {
      errors.push(`Payload field '${rule.field}' failed pattern check.`);
    }
  }

  return { valid: errors.length === 0, errors };
}
