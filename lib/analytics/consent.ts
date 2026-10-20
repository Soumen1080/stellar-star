import { type ConsentSettings, type ConsentRegion, type ConsentStatus } from "./types";

export const CONSENT_STORAGE_KEY = "stellar-star-analytics-consent";

/**
 * Detects whether the user is located in a strict privacy jurisdiction (e.g. EU/EEA, UK)
 * where explicit opt-in consent is legally required prior to firing product telemetry.
 */
export function detectConsentRegion(): ConsentRegion {
  if (typeof window === "undefined") {
    return "strict"; // Fail-safe default on server
  }

  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (timeZone.startsWith("Europe/") || timeZone.startsWith("Atlantic/")) {
      return "strict";
    }

    const lang = (window.navigator?.language || "").toLowerCase();
    const euLangs = [
      "de", "fr", "es", "it", "nl", "pl", "sv", "da", "fi", "pt", "el", "cs", "ro", "hu", "bg", "hr", "sk", "sl", "et", "lv", "lt", "mt", "ga"
    ];
    if (euLangs.some((l) => lang.startsWith(l))) {
      return "strict";
    }
  } catch {
    // Fall back to strict if detection fails
    return "strict";
  }

  return "standard";
}

/**
 * Returns the current stored consent settings or generates defaults according to regional rules.
 */
export function getStoredConsent(): ConsentSettings {
  if (typeof window === "undefined") {
    return {
      status: "pending",
      analytics: false,
      timestamp: new Date().toISOString(),
      region: "strict",
    };
  }

  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ConsentSettings;
      if (parsed && (parsed.status === "granted" || parsed.status === "denied" || parsed.status === "pending")) {
        return parsed;
      }
    }
  } catch {
    // In restricted storage contexts
  }

  const region = detectConsentRegion();
  return {
    status: "pending",
    analytics: false,
    timestamp: new Date().toISOString(),
    region,
  };
}

/**
 * Saves user consent choice to local storage and updates internal state.
 */
export function setStoredConsent(granted: boolean): ConsentSettings {
  const region = detectConsentRegion();
  const consent: ConsentSettings = {
    status: granted ? "granted" : "denied",
    analytics: granted,
    timestamp: new Date().toISOString(),
    region,
  };

  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent));
    } catch {
      // Storage unavailable
    }
  }

  return consent;
}

/**
 * Checks whether analytics collection is currently permitted.
 * Invariant: Must return true ONLY if explicit consent was granted.
 */
export function isAnalyticsPermitted(settings?: ConsentSettings): boolean {
  const current = settings ?? getStoredConsent();
  return current.status === "granted" && current.analytics === true;
}
