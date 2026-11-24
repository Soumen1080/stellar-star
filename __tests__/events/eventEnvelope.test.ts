import {
  createEventEnvelope,
  validateEventEnvelope,
  serializeEventEnvelope,
  deserializeEventEnvelope,
  EventEnvelopeError,
} from "@/lib/events/envelope";
import {
  outboxEventToEnvelope,
  envelopeToOutboxInsert,
  envelopeToWebhookPayload,
  webhookPayloadToEnvelope,
  envelopeToRealtimeBroadcast,
  realtimeBroadcastToEnvelope,
} from "@/lib/events/adapters";
import { DOMAIN_EVENT_REGISTRY, validateEventPayload } from "@/lib/events/registry";
import { CURRENT_EVENT_SPEC_VERSION, type EventEnvelope } from "@/types/events";

describe("Versioned Event Envelope (#454)", () => {
  const validBaseInput = {
    type: "expense.created",
    actor: {
      wallet: "GBEXAMPLEWALLET1234567890ABCDEF",
      type: "user" as const,
      role: "member",
    },
    aggregate: {
      type: "expense",
      id: "exp-1234-uuid",
      version: 1,
    },
    causation: {
      correlationId: "corr-1111",
      causationId: "caus-2222",
      traceId: "trace-3333",
      requestId: "req-4444",
    },
    payloadVersion: 1,
    payload: {
      expenseId: "exp-1234-uuid",
      tripId: "trip-abc-123",
      amount: "150.00",
      currency: "XLM",
      payerWallet: "GBEXAMPLEWALLET1234567890ABCDEF",
      description: "Team Dinner",
    },
  };

  describe("createEventEnvelope", () => {
    it("creates a well-formed envelope with default specVersion, generated id, and time", () => {
      const envelope = createEventEnvelope(validBaseInput);

      expect(envelope.id).toBeDefined();
      expect(typeof envelope.id).toBe("string");
      expect(envelope.specVersion).toBe(CURRENT_EVENT_SPEC_VERSION);
      expect(envelope.type).toBe("expense.created");
      expect(envelope.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(envelope.actor.wallet).toBe("GBEXAMPLEWALLET1234567890ABCDEF");
      expect(envelope.aggregate.id).toBe("exp-1234-uuid");
      expect(envelope.causation.correlationId).toBe("corr-1111");
      expect(envelope.payloadVersion).toBe(1);
      expect(envelope.payload.amount).toBe("150.00");
    });

    it("respects provided id and time overrides", () => {
      const customTime = "2026-01-01T12:00:00.000Z";
      const customId = "evt-custom-001";
      const envelope = createEventEnvelope({
        ...validBaseInput,
        id: customId,
        time: customTime,
      });

      expect(envelope.id).toBe(customId);
      expect(envelope.time).toBe(customTime);
    });

    it("throws EventEnvelopeError when strict produce validation fails on creation", () => {
      expect(() => {
        createEventEnvelope({
          ...validBaseInput,
          type: "INVALID_UPPERCASE",
        });
      }).toThrow(EventEnvelopeError);
    });
  });

  describe("Strict Producer Validation (mode: produce)", () => {
    it("succeeds for valid envelope with registered payload", () => {
      const envelope = createEventEnvelope(validBaseInput);
      const res = validateEventEnvelope(envelope, { mode: "produce" });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("rejects non-object inputs", () => {
      const res = validateEventEnvelope(null, { mode: "produce" });
      expect(res.valid).toBe(false);
      expect(res.errors[0].code).toBe("ENVELOPE_NOT_AN_OBJECT");
    });

    it("rejects missing envelope id", () => {
      const envelope = { ...createEventEnvelope(validBaseInput), id: "" };
      const res = validateEventEnvelope(envelope, { mode: "produce" });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "id")).toBe(true);
    });

    it("rejects invalid specVersion", () => {
      const envelope = { ...createEventEnvelope(validBaseInput), specVersion: "99.0.0" };
      const res = validateEventEnvelope(envelope, { mode: "produce" });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "specVersion")).toBe(true);
    });

    it("rejects invalid event type format", () => {
      const invalidTypes = ["ExpenseCreated", "expense", "expense..created", "EXPENSE.CREATED"];
      for (const t of invalidTypes) {
        const envelope = { ...createEventEnvelope(validBaseInput), type: t };
        const res = validateEventEnvelope(envelope, { mode: "produce" });
        expect(res.valid).toBe(false);
        expect(res.errors.some((e) => e.field === "type")).toBe(true);
      }
    });

    it("rejects invalid ISO timestamp", () => {
      const envelope = { ...createEventEnvelope(validBaseInput), time: "not-a-date" };
      const res = validateEventEnvelope(envelope, { mode: "produce" });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "time")).toBe(true);
    });

    it("rejects invalid actor structure or actor type", () => {
      const envelopeBadWallet = {
        ...createEventEnvelope(validBaseInput),
        actor: { wallet: "", type: "user" as const },
      };
      expect(validateEventEnvelope(envelopeBadWallet, { mode: "produce" }).valid).toBe(false);

      const envelopeBadType = {
        ...createEventEnvelope(validBaseInput),
        actor: { wallet: "GBTEST", type: "robot" as any },
      };
      expect(validateEventEnvelope(envelopeBadType, { mode: "produce" }).valid).toBe(false);
    });

    it("rejects invalid aggregate structure", () => {
      const envelopeBadAgg = {
        ...createEventEnvelope(validBaseInput),
        aggregate: { type: "", id: "exp-1" },
      };
      expect(validateEventEnvelope(envelopeBadAgg, { mode: "produce" }).valid).toBe(false);
    });

    it("rejects missing causation correlationId", () => {
      const envelopeBadCausation = {
        ...createEventEnvelope(validBaseInput),
        causation: { correlationId: "" },
      };
      expect(validateEventEnvelope(envelopeBadCausation, { mode: "produce" }).valid).toBe(false);
    });

    it("rejects invalid payload version", () => {
      const envelopeBadVersion = {
        ...createEventEnvelope(validBaseInput),
        payloadVersion: -1 as any,
      };
      expect(validateEventEnvelope(envelopeBadVersion, { mode: "produce" }).valid).toBe(false);
    });

    it("rejects payload failing schema validation for registered event type", () => {
      const validEnvelope = createEventEnvelope(validBaseInput);
      // Skip creation validation by direct mutation:
      const mutated = {
        ...validEnvelope,
        payload: { expenseId: "exp-123" },
      };
      const res = validateEventEnvelope(mutated, { mode: "produce" });
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.field === "payload" || e.path.startsWith("payload."))).toBe(true);
    });
  });

  describe("Tolerant Consumer Validation (mode: consume / Postel's Law)", () => {
    it("safely accepts envelopes with unknown top-level envelope fields", () => {
      const rawPayload = {
        ...createEventEnvelope(validBaseInput),
        futureFeatureFlag: true,
        extraExtensionData: { nested: 123 },
        experimentalRouterVersion: "v2.5",
      };

      const res = validateEventEnvelope(rawPayload, { mode: "consume" });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("safely accepts payloads with forward-compatible unknown payload fields", () => {
      const rawPayload = {
        ...createEventEnvelope(validBaseInput),
        payload: {
          ...validBaseInput.payload,
          vendorTaxIdentifier: "US-999-XYZ",
          futureProofField: [1, 2, 3],
        },
      };

      const res = validateEventEnvelope(rawPayload, { mode: "consume" });
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it("still catches critical missing envelope invariants even in consume mode", () => {
      const brokenEnvelope = {
        type: "expense.created",
        // missing id, time, specVersion, actor, aggregate, causation
      };
      const res = validateEventEnvelope(brokenEnvelope, { mode: "consume" });
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThanOrEqual(4);
    });

    it("allows skipping payload validation if explicitly requested", () => {
      const envelope = createEventEnvelope(validBaseInput);
      const mutated = {
        ...envelope,
        payload: { arbitrary: "unregistered data" },
      };
      const res = validateEventEnvelope(mutated, {
        mode: "consume",
        validatePayloadSchema: false,
      });
      expect(res.valid).toBe(true);
    });
  });

  describe("Serialization & Deserialization", () => {
    it("serializes and deserializes an envelope cleanly", () => {
      const original = createEventEnvelope(validBaseInput);
      const json = serializeEventEnvelope(original);
      expect(typeof json).toBe("string");

      const parsed = deserializeEventEnvelope(json, { mode: "consume" });
      expect(parsed.id).toBe(original.id);
      expect(parsed.type).toBe(original.type);
      expect(parsed.actor.wallet).toBe(original.actor.wallet);
      expect(parsed.aggregate.id).toBe(original.aggregate.id);
      expect(parsed.causation.correlationId).toBe(original.causation.correlationId);
      expect(parsed.payload.amount).toBe("150.00");
    });

    it("deserialization throws EventEnvelopeError when invalid JSON or schema fails", () => {
      expect(() => deserializeEventEnvelope("{ invalid json ")).toThrow(EventEnvelopeError);

      const invalidEnvelopeJson = JSON.stringify({ specVersion: "1.0.0" });
      expect(() => deserializeEventEnvelope(invalidEnvelopeJson, { mode: "consume" })).toThrow(
        EventEnvelopeError
      );
    });
  });

  describe("Domain Event Schemas (validateEventPayload)", () => {
    it("validates expense.updated", () => {
      const validPayload = {
        expenseId: "exp-1",
        tripId: "trip-1",
        updatedFields: ["amount", "description"],
        previousVersion: 1,
        newVersion: 2,
      };
      expect(validateEventPayload("expense.updated", validPayload).errors).toHaveLength(0);

      const invalidPayload = {
        expenseId: "exp-1",
        // missing tripId
      };
      expect(validateEventPayload("expense.updated", invalidPayload).errors.length).toBeGreaterThan(0);
    });

    it("validates settlement.completed", () => {
      const validPayload = {
        settlementId: "settle-1",
        tripId: "trip-1",
        payerWallet: "GBPAYER",
        recipientWallet: "GBRECIPIENT",
        amount: "500.00",
        currency: "USDC",
        transactionHash: "tx-stellar-hash",
      };
      expect(validateEventPayload("settlement.completed", validPayload).errors).toHaveLength(0);

      const invalidPayload = {
        settlementId: "settle-1",
        // missing tripId, amount, currency
      };
      expect(validateEventPayload("settlement.completed", invalidPayload).errors.length).toBeGreaterThan(0);
    });

    it("validates receipt.scanned", () => {
      const validPayload = {
        receiptId: "rcpt-1",
        tripId: "trip-1",
        uploaderWallet: "GBUPLOADER",
        totalAmount: "45.50",
        currency: "USD",
        confidence: 0.95,
        scanStatus: "succeeded",
      };
      expect(validateEventPayload("receipt.scanned", validPayload).errors).toHaveLength(0);
    });

    it("allows unregistered event types with warning/success if payload is an object", () => {
      expect(validateEventPayload("custom.unregistered.event", { anyData: true }).errors).toHaveLength(0);
      expect(validateEventPayload("custom.unregistered.event", 1, "string-payload" as any).errors).toHaveLength(1);
    });
  });

  describe("Channel Adapters", () => {
    describe("Outbox Adapter", () => {
      it("transforms domain outbox record to standard EventEnvelope and preserves causation", () => {
        const outboxRecord = {
          id: "outbox-row-123",
          event_type: "expense.created",
          aggregate_type: "expense",
          aggregate_id: "exp-1234-uuid",
          aggregate_version: 2,
          actor_wallet: "GBEXAMPLEWALLET1234567890ABCDEF",
          actor_type: "user",
          correlation_id: "corr-1111",
          causation_id: "caus-2222",
          trace_id: "trace-3333",
          payload_version: 1,
          payload: {
            expenseId: "exp-1234-uuid",
            tripId: "trip-abc-123",
            amount: "150.00",
            currency: "XLM",
            payerWallet: "GBEXAMPLEWALLET1234567890ABCDEF",
          },
          created_at: "2026-03-01T10:00:00.000Z",
        };

        const envelope = outboxEventToEnvelope(outboxRecord);
        expect(envelope.id).toBe("outbox-row-123");
        expect(envelope.type).toBe("expense.created");
        expect(envelope.aggregate.id).toBe("exp-1234-uuid");
        expect(envelope.aggregate.version).toBe(2);
        expect(envelope.causation.correlationId).toBe("corr-1111");
        expect(envelope.causation.causationId).toBe("caus-2222");
        expect(envelope.causation.traceId).toBe("trace-3333");
        expect(envelope.metadata?.channel).toBe("outbox");
      });

      it("converts EventEnvelope to database insert format for outbox table", () => {
        const envelope = createEventEnvelope(validBaseInput);
        const insert = envelopeToOutboxInsert(envelope);

        expect(insert.event_type).toBe(envelope.type);
        expect(insert.aggregate_type).toBe(envelope.aggregate.type);
        expect(insert.aggregate_id).toBe(envelope.aggregate.id);
        expect(insert.actor_wallet).toBe(envelope.actor.wallet);
        expect(insert.correlation_id).toBe(envelope.causation.correlationId);
        expect(insert.payload_version).toBe(envelope.payloadVersion);
        expect(insert.payload).toEqual(envelope.payload);
      });
    });

    describe("Webhook Adapter", () => {
      it("formats envelope for webhook dispatch with idempotency key and trace headers", () => {
        const envelope = createEventEnvelope(validBaseInput);
        const webhookPayload = envelopeToWebhookPayload(envelope);

        expect(webhookPayload.idempotencyKey).toBe(envelope.id);
        expect(webhookPayload.eventType).toBe("expense.created");
        expect(webhookPayload.data.envelope.id).toBe(envelope.id);
        expect(webhookPayload.data.payload.amount).toBe("150.00");
      });

      it("parses received webhook payload back to an EventEnvelope", () => {
        const envelope = createEventEnvelope(validBaseInput);
        const webhookPayload = envelopeToWebhookPayload(envelope);
        const parsed = webhookPayloadToEnvelope(webhookPayload);

        expect(parsed.id).toBe(envelope.id);
        expect(parsed.type).toBe(envelope.type);
        expect(parsed.causation.correlationId).toBe(envelope.causation.correlationId);
      });
    });

    describe("Realtime Adapter", () => {
      it("converts envelope to realtime broadcast format", () => {
        const envelope = createEventEnvelope(validBaseInput);
        const broadcast = envelopeToRealtimeBroadcast(envelope);

        expect(broadcast.event).toBe(envelope.type);
        expect(broadcast.correlationId).toBe(envelope.causation.correlationId);
        expect(broadcast.payload).toEqual(envelope.payload);
        expect(broadcast._envelope.id).toBe(envelope.id);
      });

      it("reconstructs envelope from realtime broadcast format", () => {
        const envelope = createEventEnvelope(validBaseInput);
        const broadcast = envelopeToRealtimeBroadcast(envelope);
        const reconstructed = realtimeBroadcastToEnvelope(broadcast);

        expect(reconstructed.id).toBe(envelope.id);
        expect(reconstructed.type).toBe(envelope.type);
        expect(reconstructed.payload.amount).toBe("150.00");
      });
    });
  });
});
