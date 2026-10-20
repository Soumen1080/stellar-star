import {
  EVENT_TAXONOMY,
  ALLOWED_EVENT_NAMES,
  isAllowedEventName,
  getEventDefinition,
} from "@/lib/analytics/taxonomy";
import { ANALYTICS_SCHEMA_VERSION } from "@/lib/analytics/types";

describe("Public Analytics Event Taxonomy & Schema Governance", () => {
  it("enforces schema versioning across the taxonomy", () => {
    expect(ANALYTICS_SCHEMA_VERSION).toBe("1.0.0");
  });

  it("registers all required funnel events", () => {
    const requiredEvents = [
      "app_loaded",
      "wallet_connect_started",
      "wallet_connected",
      "wallet_connect_failed",
      "onboarding_started",
      "onboarding_completed",
      "trip_create_started",
      "trip_created",
      "trip_viewed",
      "expense_create_started",
      "expense_created",
      "payment_started",
      "payment_submitted",
      "payment_completed",
      "payment_failed",
    ];

    for (const name of requiredEvents) {
      expect(ALLOWED_EVENT_NAMES).toContain(name);
      expect(isAllowedEventName(name)).toBe(true);
      const def = getEventDefinition(name as any);
      expect(def).toBeDefined();
      expect(def.rationale).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("strictly prohibits sensitive property keys in event definitions", () => {
    const sensitiveKeyPattern =
      /wallet_?address|account_?id|public_?key|pub_?key|secret_?key|seed|private_?key|priv_?key|tx_?xdr|\bxdr\b|memo|description|\btitle\b|\bnotes\b|receipt|ocr|jwt/i;

    for (const [eventName, def] of Object.entries(EVENT_TAXONOMY)) {
      for (const prop of def.allowedProperties) {
        expect(sensitiveKeyPattern.test(prop)).toBe(false);
      }

      // Must list explicit forbidden attributes
      expect(def.strictlyForbidden.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown or unversioned ad-hoc event names", () => {
    expect(isAllowedEventName("user_clicked_secret_button")).toBe(false);
    expect(isAllowedEventName("transfer_private_key")).toBe(false);
    expect(isAllowedEventName("send_wallet_xdr")).toBe(false);
  });
});
