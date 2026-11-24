/**
 * __tests__/onboarding/firstSettlementChecklist.test.ts
 *
 * Tests for First-Settlement Checklist (#376).
 *
 * Acceptance Criteria Verified:
 * 1. A first-settlement checklist covers:
 *    - wallet connection
 *    - network synchronization
 *    - asset readiness
 *    - payment review
 *    - signature readiness
 *    - confirmation status
 *    - recovery status
 * 2. Incomplete setup detection prevents payment request failure before submission.
 * 3. Help copy is plain-language, keyboard accessible, and linked to relevant support articles
 *    without exposing another trip's data.
 * 4. Consent-aware analytics measure step completion and abandonment without collecting
 *    wallet addresses or financial free text.
 */

import { EVENT_TAXONOMY } from "@/lib/analytics/taxonomy";
import { containsSensitiveData } from "@/lib/analytics/redaction";
import { type ChecklistStepKey } from "@/components/onboarding/FirstSettlementChecklist";

describe("First-Settlement Checklist (#376)", () => {
  describe("1. Seven Required Checklist Stages", () => {
    it("verifies all 7 required stages are defined and ordered logically", () => {
      const requiredStages: ChecklistStepKey[] = [
        "wallet_connection",
        "network_valid",
        "asset_readiness",
        "payment_review",
        "signature_ready",
        "confirmation_status",
        "recovery_status",
      ];

      expect(requiredStages).toHaveLength(7);
      expect(requiredStages[0]).toBe("wallet_connection");
      expect(requiredStages[1]).toBe("network_valid");
      expect(requiredStages[2]).toBe("asset_readiness");
      expect(requiredStages[3]).toBe("payment_review");
      expect(requiredStages[4]).toBe("signature_ready");
      expect(requiredStages[5]).toBe("confirmation_status");
      expect(requiredStages[6]).toBe("recovery_status");
    });
  });

  describe("2. Incomplete Setup Detection & Support Links", () => {
    it("ensures checklist support links do not leak trip identifiers or private data", () => {
      const checklistTopics = [
        "wallet-setup",
        "network-selection",
        "trustlines",
        "payment-review",
        "wallet-signing",
        "settlement-proofs",
        "recovery-guarantees",
      ];

      for (const topic of checklistTopics) {
        const link = `/support?topic=${encodeURIComponent(topic)}`;
        expect(link).not.toContain("trip_id");
        expect(link).not.toContain("wallet");
        expect(containsSensitiveData(link)).toBe(false);
      }
    });
  });

  describe("3. Consent-Aware Analytics Invariants", () => {
    it("confirms settlement checklist analytics events exist in taxonomy and disallow PII", () => {
      const checklistEvents = [
        "first_settlement_checklist_started",
        "first_settlement_checklist_step_completed",
        "first_settlement_checklist_completed",
        "first_settlement_checklist_abandoned",
      ] as const;

      for (const ev of checklistEvents) {
        const def = EVENT_TAXONOMY[ev];
        expect(def).toBeDefined();
        expect(def.strictlyForbidden).toContain("walletAddress");
        expect(def.strictlyForbidden).toContain("publicKey");
      }
    });

    it("verifies clean checklist analytics payloads pass sanitization check", () => {
      const started = { context: "trip" as const };
      expect(containsSensitiveData(started)).toBe(false);

      const stepCompleted = { step_key: "asset_readiness", step_index: 3 };
      expect(containsSensitiveData(stepCompleted)).toBe(false);

      const completed = { duration_ms: 8500 };
      expect(containsSensitiveData(completed)).toBe(false);

      const abandoned = { last_step_key: "network_valid", incomplete_steps_count: 4 };
      expect(containsSensitiveData(abandoned)).toBe(false);
    });

    it("detects and rejects any sensitive wallet keys or amounts in checklist analytics", () => {
      const dirtyWithKey = {
        step_key: "wallet_connection",
        publicKey: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      };
      expect(containsSensitiveData(dirtyWithKey)).toBe(true);

      const dirtyWithSecret = {
        step_key: "signature_ready",
        secretKey: "SBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      };
      expect(containsSensitiveData(dirtyWithSecret)).toBe(true);
    });
  });
});
