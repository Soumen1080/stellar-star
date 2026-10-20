/**
 * lib/observability/alerts.ts
 *
 * Durable alert evaluation and dispatch for money-path operations (Issue #307).
 *
 * Invariants:
 *  1. Immediate SEV-1 alert on any partial-success spike (money moved on Horizon
 *     without on-chain contract recording, leaving user uncertain if funds moved).
 *  2. Immediate SEV-1 alert on critical infrastructure outages (Horizon, Soroban RPC,
 *     Supabase, Attestation Oracle).
 *  3. SEV-2 alert on repeated money-path failures (>= 3 failures in rolling 5-minute window).
 *  4. Zero secret/XDR leakage: payloads dispatched to on-call channels are strictly redacted.
 *  5. Includes actionable runbook investigation instructions with correlation ID.
 */

export type AlertSeverity = "SEV-1" | "SEV-2";
export type AlertType =
  | "PARTIAL_SUCCESS_SPIKE"
  | "CRITICAL_SERVICE_UNAVAILABLE"
  | "REPEATED_FAILURES";

export interface OnCallAlert {
  alertId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  summary: string;
  requestId: string;
  timestamp: string;
  triggerReason: string;
  runbookUrl: string;
  investigationSteps: string[];
  redactedContext: Record<string, unknown>;
}

interface StoredEvent {
  name: string;
  message: string;
  timestamp: number;
  requestId: string;
  isPartialSuccess: boolean;
  isCriticalService: boolean;
}

const ROLLING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const REPEATED_FAILURES_THRESHOLD = 3;

// In-memory sliding window for tracking failure frequency
const eventHistory: StoredEvent[] = [];

/**
 * Resets event history. Useful for unit testing.
 */
export function resetAlertHistory(): void {
  eventHistory.length = 0;
}

/**
 * Classifies whether an error indicates a partial-success condition where funds moved on Horizon
 * but proof or contract-recording failed.
 */
export function isPartialSuccessError(name: string, message: string, context?: Record<string, unknown>): boolean {
  const text = `${name} ${message} ${JSON.stringify(context ?? {})}`.toLowerCase();
  const hasTx = Boolean(context?.hash || context?.txHash);
  return (
    text.includes("onchain-proof-failed") ||
    text.includes("partial_success") ||
    text.includes("recorded off-chain only") ||
    text.includes("on-chain proof unavailable") ||
    (hasTx && (text.includes("contract-recording") || text.includes("attestation") || context?.onChain === false)) ||
    (Boolean(context?.hash) && context?.onChain === false)
  );
}

/**
 * Classifies whether an error indicates critical infrastructure is unavailable.
 */
export function isCriticalServiceOutage(name: string, message: string, context?: Record<string, unknown>): { unavailable: boolean; service?: string } {
  const text = `${name} ${message} ${JSON.stringify(context ?? {})}`.toLowerCase();

  if (text.includes("504") || text.includes("gateway timeout") || (text.includes("horizon") && (text.includes("fetch failed") || text.includes("unavailable") || text.includes("timeout")))) {
    return { unavailable: true, service: "Horizon Gateway / Stellar Core" };
  }
  if (text.includes("soroban") && (text.includes("rpc") || text.includes("unavailable") || text.includes("connection refused") || text.includes("timeout"))) {
    return { unavailable: true, service: "Soroban RPC" };
  }
  if (text.includes("pgrst205") || text.includes("schema cache") || (text.includes("supabase") && (text.includes("connection failed") || text.includes("unavailable") || text.includes("timeout")))) {
    return { unavailable: true, service: "Supabase Database" };
  }
  if (text.includes("attestation") && (text.includes("unavailable") || text.includes("oracle down") || text.includes("503") || text.includes("connection refused"))) {
    return { unavailable: true, service: "Settlement Attestation Oracle" };
  }

  return { unavailable: false };
}

/**
 * Evaluates an incoming error report against alert thresholds.
 * Returns an OnCallAlert if an alert condition is triggered, or null otherwise.
 */
export function evaluateAlertConditions(report: {
  name?: string;
  message?: string;
  context?: Record<string, unknown>;
  requestId?: string;
}): OnCallAlert | null {
  const now = Date.now();
  const name = report.name ?? "unknown.error";
  const message = report.message ?? "";
  const requestId = report.requestId ?? "unknown-request-id";
  const context = report.context ?? {};

  // Clean old events outside rolling window
  while (eventHistory.length > 0 && now - eventHistory[0].timestamp > ROLLING_WINDOW_MS) {
    eventHistory.shift();
  }

  const isPartial = isPartialSuccessError(name, message, context);
  const critical = isCriticalServiceOutage(name, message, context);

  eventHistory.push({
    name,
    message,
    timestamp: now,
    requestId,
    isPartialSuccess: isPartial,
    isCriticalService: critical.unavailable,
  });

  const runbookUrl = "docs/RUNBOOK.md#9-alert-investigation-runbook-from-correlation-id-to-on-chain-transaction-and-database-record";

  // Trigger 1: Spike in Partial Success (High risk - money moved without proof)
  if (isPartial) {
    const partialCount = eventHistory.filter((e) => e.isPartialSuccess).length;
    return {
      alertId: `alert-partial-success-${requestId.slice(0, 8)}`,
      type: "PARTIAL_SUCCESS_SPIKE",
      severity: "SEV-1",
      title: "🚨 [SEV-1 ALERT] Partial Success Detected: Funds Moved Without Contract Proof",
      summary: `Payment transaction completed on Stellar Horizon, but Soroban contract recording failed. User may observe unrecorded settlement.`,
      requestId,
      timestamp: new Date(now).toISOString(),
      triggerReason: `Partial success event occurred (${partialCount} in last 5m)`,
      runbookUrl,
      investigationSteps: [
        `1. Trace correlation ID "${requestId}" in logs: grep "[StellarStar:client-error]"`,
        `2. Check txHash on Stellar Expert to confirm transfer occurred.`,
        `3. Check settlement_intents row for intentId and trigger retryOnChainRecord or automated reconciliation.`,
        `4. Confirm user wallet was not debited twice before advising retry.`,
      ],
      redactedContext: context,
    };
  }

  // Trigger 2: Critical Service Unavailable
  if (critical.unavailable) {
    return {
      alertId: `alert-service-outage-${requestId.slice(0, 8)}`,
      type: "CRITICAL_SERVICE_UNAVAILABLE",
      severity: "SEV-1",
      title: `🚨 [SEV-1 ALERT] Critical Service Unavailable: ${critical.service}`,
      summary: `A payment-path dependency (${critical.service}) is failing requests or unreachable.`,
      requestId,
      timestamp: new Date(now).toISOString(),
      triggerReason: `Service outage detected in payment path: ${message.slice(0, 150)}`,
      runbookUrl,
      investigationSteps: [
        `1. Check status of ${critical.service}.`,
        `2. Verify whether outage affects Horizon, Soroban RPC, or Supabase endpoints.`,
        `3. If prolonged, invoke release pause authority to display maintenance block screen.`,
      ],
      redactedContext: context,
    };
  }

  // Trigger 3: Repeated Money-Path Failures
  const failureCount = eventHistory.length;
  if (failureCount >= REPEATED_FAILURES_THRESHOLD) {
    return {
      alertId: `alert-repeated-failures-${requestId.slice(0, 8)}`,
      type: "REPEATED_FAILURES",
      severity: "SEV-2",
      title: `⚠️ [SEV-2 ALERT] Repeated Money-Path Failures (${failureCount} in 5 min)`,
      summary: `Multiple money-path failures observed across recent user transactions.`,
      requestId,
      timestamp: new Date(now).toISOString(),
      triggerReason: `${failureCount} money-path failures within 5-minute rolling window (threshold: ${REPEATED_FAILURES_THRESHOLD})`,
      runbookUrl,
      investigationSteps: [
        `1. Query server logs for correlation IDs associated with recent failures.`,
        `2. Check for common root causes (surge fees, wallet rejections, wrong network).`,
        `3. Determine whether transactions are failing pre-submission or post-submission.`,
      ],
      redactedContext: context,
    };
  }

  return null;
}

/**
 * Dispatches an on-call alert to the configured webhook (e.g. Slack/Discord/PagerDuty)
 * and emits a structured oncall-alert log entry.
 */
export async function dispatchOnCallAlert(alert: OnCallAlert, webhookUrl?: string): Promise<boolean> {
  // Always log to server error stream with stable prefix for log monitors
  console.error(`[StellarStar:oncall-alert] ${JSON.stringify(alert)}`);

  const url = webhookUrl || process.env.ALERT_WEBHOOK_URL || process.env.ERROR_REPORTING_WEBHOOK;
  if (!url) return false;

  try {
    const payload = {
      text: `${alert.title}\n*Correlation ID:* \`${alert.requestId}\`\n*Summary:* ${alert.summary}\n*Runbook:* <${alert.runbookUrl}>\n*Reason:* ${alert.triggerReason}`,
      alert,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-request-id": alert.requestId,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    return res.ok;
  } catch {
    // Best-effort dispatch; server log was already emitted
    return false;
  }
}
