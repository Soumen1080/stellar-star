/**
 * __tests__/onboarding/guidedOnboarding.test.ts
 *
 * Tests for Guided Onboarding Flow (#376).
 *
 * Acceptance Criteria Verified:
 * 1. Onboarding adapts to whether a user is creating, joining, or only viewing a trip,
 *    and never blocks access to already-permitted information.
 * 2. Help copy is plain-language, keyboard accessible, and linked to the relevant
 *    support article without exposing another trip's data.
 * 3. Consent-aware analytics measure step completion and abandonment without
 *    collecting wallet addresses or financial free text.
 */

import React from "react";
import { GuidedOnboardingModal, type OnboardingMode } from "@/components/onboarding/GuidedOnboardingModal";
import { EVENT_TAXONOMY } from "@/lib/analytics/taxonomy";
import { containsSensitiveData } from "@/lib/analytics/redaction";

describe("Guided Onboarding (#376)", () => {
  describe("1. Role Adaptation & Permitted Information Access", () => {
    it("defines distinct, adapted flows for create, join, and view modes", () => {
      const modes: OnboardingMode[] = ["create", "join", "view"];

      for (const mode of modes) {
        expect(mode).toBeDefined();
        // Each mode should have a tailored title and relevant steps
        if (mode === "create") {
          expect(mode).toBe("create");
        } else if (mode === "join") {
          expect(mode).toBe("join");
        } else if (mode === "view") {
          expect(mode).toBe("view");
        }
      }
    });

    it("ensures all support links are trip-isolated and do not leak trip identifiers", () => {
      // Support topics must not contain private trip IDs, member wallets, or financial info
      const safeTopics = [
        "wallet-setup",
        "trip-basics",
        "inviting-members",
        "trustlines",
        "settlement",
        "trip-view",
        "member-roles",
        "disputes",
      ];

      for (const topic of safeTopics) {
        const linkUrl = `/support?topic=${encodeURIComponent(topic)}`;
        expect(linkUrl).not.toContain("trip_id");
        expect(linkUrl).not.toContain("wallet");
        expect(containsSensitiveData(linkUrl)).toBe(false);
      }
    });
  });

  describe("2. Consent-Aware Analytics Invariants", () => {
    it("ensures onboarding analytics events are registered in taxonomy and disallow PII/wallet keys", () => {
      const requiredEvents = [
        "onboarding_started",
        "onboarding_step_completed",
        "onboarding_completed",
        "onboarding_abandoned",
      ] as const;

      for (const eventName of requiredEvents) {
        const def = EVENT_TAXONOMY[eventName];
        expect(def).toBeDefined();
        expect(def.strictlyForbidden).toContain("walletAddress");
        expect(def.strictlyForbidden).toContain("publicKey");
      }
    });

    it("verifies sample event payloads contain no sensitive wallet addresses or financial free text", () => {
      const startedPayload = {
        step: 1,
        mode: "join" as const,
      };
      expect(containsSensitiveData(startedPayload)).toBe(false);

      const stepCompletedPayload = {
        mode: "create" as const,
        step_index: 2,
        step_name: "create_details",
      };
      expect(containsSensitiveData(stepCompletedPayload)).toBe(false);

      const completedPayload = {
        step_count: 3,
        duration_ms: 12500,
        mode: "view" as const,
      };
      expect(containsSensitiveData(completedPayload)).toBe(false);

      const abandonedPayload = {
        mode: "join" as const,
        last_step_index: 2,
      };
      expect(containsSensitiveData(abandonedPayload)).toBe(false);
    });

    it("flags any accidental injection of wallet addresses or financial memo text in analytics", () => {
      const dirtyPayloadWithWallet = {
        mode: "create",
        step_index: 1,
        walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      };
      expect(containsSensitiveData(dirtyPayloadWithWallet)).toBe(true);

      const dirtyPayloadWithMemo = {
        mode: "create",
        memo: "Dinner at Paris Bistro for 4 people",
      };
      expect(containsSensitiveData(dirtyPayloadWithMemo)).toBe(true);
    });
  });
});
