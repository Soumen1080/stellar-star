/**
 * @jest-environment jsdom
 */

import {
  getStoredConsent,
  setStoredConsent,
  isAnalyticsPermitted,
  detectConsentRegion,
  CONSENT_STORAGE_KEY,
} from "@/lib/analytics/consent";
import { trackAnalyticsEvent, getStoredEvents, clearAnalyticsBuffer } from "@/lib/analytics/sink";

describe("Analytics Consent Governance & Regional Compliance", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAnalyticsBuffer();
  });

  it("defaults to non-permitted (false) prior to explicit user consent", () => {
    const consent = getStoredConsent();
    expect(consent.status).toBe("pending");
    expect(isAnalyticsPermitted()).toBe(false);
  });

  it("enables analytics tracking only after explicit grant", () => {
    expect(isAnalyticsPermitted()).toBe(false);

    setStoredConsent(true);
    expect(isAnalyticsPermitted()).toBe(true);

    const updated = getStoredConsent();
    expect(updated.status).toBe("granted");
    expect(updated.analytics).toBe(true);
  });

  it("stops tracking immediately when user revokes or declines consent", () => {
    setStoredConsent(true);
    expect(isAnalyticsPermitted()).toBe(true);

    // Revoke
    setStoredConsent(false);
    expect(isAnalyticsPermitted()).toBe(false);

    const declined = getStoredConsent();
    expect(declined.status).toBe("denied");
    expect(declined.analytics).toBe(false);
  });

  it("silently drops events when consent is not granted", () => {
    // Attempt tracking without consent
    const emitted = trackAnalyticsEvent("app_loaded", { locale: "en-US" });
    expect(emitted).toBe(false);

    // Verify buffer remains empty
    expect(getStoredEvents().length).toBe(0);
  });

  it("records events when consent has been explicitly granted", () => {
    setStoredConsent(true);

    const emitted = trackAnalyticsEvent("app_loaded", { locale: "en-US" });
    expect(emitted).toBe(true);

    const events = getStoredEvents();
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("app_loaded");
    expect(events[0].properties.locale).toBe("en-US");
  });

  it("persists consent preference in localStorage", () => {
    setStoredConsent(true);
    const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).status).toBe("granted");
  });
});
