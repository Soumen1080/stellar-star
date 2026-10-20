import {
  type AnalyticsEvent,
  type AnalyticsEventName,
  type EventPropertiesMap,
  type AggregateMetrics,
  ANALYTICS_SCHEMA_VERSION,
} from "./types";
import { isAnalyticsPermitted } from "./consent";
import { sanitizeAnalyticsEvent, containsSensitiveData } from "./redaction";

const IN_MEMORY_EVENTS: AnalyticsEvent[] = [];
const STORAGE_BUFFER_KEY = "stellar-star-analytics-buffer";
const MAX_BUFFER_SIZE = 100;

let sessionId: string | null = null;

function getSessionId(): string {
  if (sessionId) return sessionId;
  if (typeof window !== "undefined") {
    try {
      const stored = sessionStorage.getItem("stellar-star-analytics-session");
      if (stored) {
        sessionId = stored;
        return sessionId;
      }
      sessionId = crypto.randomUUID();
      sessionStorage.setItem("stellar-star-analytics-session", sessionId);
      return sessionId;
    } catch {
      // Storage unavailable
    }
  }
  sessionId = crypto.randomUUID();
  return sessionId;
}

/**
 * Tracks a non-sensitive product event if user has granted explicit consent.
 * Invariant: Never emits sensitive wallet keys, XDR, or descriptions.
 */
export function trackAnalyticsEvent<TName extends AnalyticsEventName>(
  name: TName,
  properties: EventPropertiesMap[TName]
): boolean {
  if (!isAnalyticsPermitted()) {
    // Explicit consent not granted: silently drop event
    return false;
  }

  const rawEvent: AnalyticsEvent<TName> = {
    id: crypto.randomUUID(),
    name,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    properties,
    session: {
      id: getSessionId(),
      locale: typeof window !== "undefined" ? window.navigator?.language || "en-US" : "en-US",
    },
  };

  const sanitized = sanitizeAnalyticsEvent(rawEvent as AnalyticsEvent) as AnalyticsEvent<TName>;

  // Append to in-memory store
  IN_MEMORY_EVENTS.push(sanitized as AnalyticsEvent);
  if (IN_MEMORY_EVENTS.length > MAX_BUFFER_SIZE) {
    IN_MEMORY_EVENTS.shift();
  }

  // Best-effort local persistence for dashboard and testing
  if (typeof window !== "undefined") {
    try {
      let existing: AnalyticsEvent[] = [];
      const raw = localStorage.getItem(STORAGE_BUFFER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      }
      existing.push(sanitized as AnalyticsEvent);
      if (existing.length > MAX_BUFFER_SIZE) existing.shift();
      localStorage.setItem(STORAGE_BUFFER_KEY, JSON.stringify(existing));
    } catch {
      // Storage error
    }

    // Forward to internal ingestion endpoint
    try {
      fetch("/api/analytics/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sanitized),
      }).catch(() => {
        // Degrade silently if offline or endpoint unavailable
      });
    } catch {
      // Best-effort
    }
  }

  return true;
}

export function getStoredEvents(): AnalyticsEvent[] {
  if (typeof window !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_BUFFER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
      return [];
    } catch {
      // Storage error
    }
  }
  return [...IN_MEMORY_EVENTS];
}

export function clearAnalyticsBuffer(): void {
  IN_MEMORY_EVENTS.length = 0;
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_BUFFER_KEY);
    } catch {
      // Storage error
    }
  }
}

/**
 * Computes aggregate activation, completion, and failure rates from an event stream.
 */
export function computeAggregateMetrics(events: AnalyticsEvent[]): AggregateMetrics {
  let appLoadedCount = 0;
  let walletConnectStartedCount = 0;
  let walletConnectedCount = 0;
  let walletConnectFailedCount = 0;
  let tripCreateStartedCount = 0;
  let tripCreatedCount = 0;
  let expenseCreateStartedCount = 0;
  let expenseCreatedCount = 0;
  let paymentStartedCount = 0;
  let paymentCompletedCount = 0;
  let paymentFailedCount = 0;

  const failuresByCode: Record<string, number> = {};
  const walletConnectionsByType: Record<string, number> = {};
  const expensesByCurrency: Record<string, number> = {};

  let redactionPassed = true;

  for (const event of events) {
    // Audit for any sensitive data leaks
    if (containsSensitiveData(event)) {
      redactionPassed = false;
    }

    switch (event.name) {
      case "app_loaded":
        appLoadedCount++;
        break;
      case "wallet_connect_started":
        walletConnectStartedCount++;
        break;
      case "wallet_connected": {
        walletConnectedCount++;
        const type = (event.properties as any)?.wallet_type || "unknown";
        walletConnectionsByType[type] = (walletConnectionsByType[type] || 0) + 1;
        break;
      }
      case "wallet_connect_failed": {
        walletConnectFailedCount++;
        const code = (event.properties as any)?.error_code || "UNKNOWN";
        failuresByCode[code] = (failuresByCode[code] || 0) + 1;
        break;
      }
      case "trip_create_started":
        tripCreateStartedCount++;
        break;
      case "trip_created":
        tripCreatedCount++;
        break;
      case "expense_create_started":
        expenseCreateStartedCount++;
        break;
      case "expense_created": {
        expenseCreatedCount++;
        const curr = (event.properties as any)?.currency || "XLM";
        expensesByCurrency[curr] = (expensesByCurrency[curr] || 0) + 1;
        break;
      }
      case "payment_started":
        paymentStartedCount++;
        break;
      case "payment_completed":
        paymentCompletedCount++;
        break;
      case "payment_failed": {
        paymentFailedCount++;
        const code = (event.properties as any)?.error_code || "PAYMENT_FAILED";
        failuresByCode[code] = (failuresByCode[code] || 0) + 1;
        break;
      }
    }
  }

  // Calculate activation rate: % of visitors who connected wallet and created/participated in trip
  const baseVisitors = Math.max(appLoadedCount, walletConnectedCount, 1);
  const activationRate = Number(((walletConnectedCount / baseVisitors) * 100).toFixed(1));

  // Expense completion rate: % of initiated expense flows that were saved
  const baseExpenses = Math.max(expenseCreateStartedCount, expenseCreatedCount, 1);
  const expenseCompletionRate = Number(((expenseCreatedCount / baseExpenses) * 100).toFixed(1));

  // Payment completion rate: % of initiated payments that reached completed status
  const basePayments = Math.max(paymentStartedCount, paymentCompletedCount + paymentFailedCount, 1);
  const paymentCompletionRate = Number(((paymentCompletedCount / basePayments) * 100).toFixed(1));

  // Friction / failure rate
  const totalOperations = paymentStartedCount + walletConnectStartedCount;
  const totalFailures = paymentFailedCount + walletConnectFailedCount;
  const failureRate = totalOperations > 0
    ? Number(((totalFailures / totalOperations) * 100).toFixed(1))
    : 0;

  return {
    totalVisitors: appLoadedCount,
    walletConnections: walletConnectedCount,
    tripsCreated: tripCreatedCount,
    expensesCreated: expenseCreatedCount,
    paymentsCompleted: paymentCompletedCount,
    paymentsFailed: paymentFailedCount,
    activationRate,
    expenseCompletionRate,
    paymentCompletionRate,
    failureRate,
    failuresByCode,
    walletConnectionsByType,
    expensesByCurrency,
    redactionVerified: redactionPassed,
  };
}
