/**
 * lib/status/evaluate.ts
 *
 * Public service status (Issue #377). Server only.
 *
 * Each component's state comes from a real signal where one exists, combined
 * with any published incident:
 *   app             serving this response; otherwise only published incidents
 *   database        a short, timed query through the service role
 *   notifications   overdue reminder/webhook deliveries and recent dead
 *                   letters in the transactional outbox
 *   quotes          live checks of the exchange-rate providers
 *   reconciliation  age and outcome of the latest recorded worker run
 *
 * With no signal on a deployment, a component reports "unknown" ("Not
 * reporting") rather than claiming to be healthy. The public payload carries
 * only a coarse state and a fixed message per state: no hostnames, provider
 * names, latencies, counts or error text.
 */

import { createServiceRoleClient, type ServerClient } from "@/lib/supabase/server";
import { providerRegistry } from "@/lib/routing/providerRegistry";
import { recentReconciliationRuns } from "@/lib/settlement/reconciliationRun";
import {
  INCIDENT_POLICY,
  STATUS_COMPONENTS,
  getPublishedIncidents,
  isUpdateOverdue,
  type Incident,
  type IncidentSeverity,
  type IncidentUpdateStatus,
  type StatusComponentId,
} from "./incidents";

export type ComponentState = "operational" | "degraded" | "outage" | "unknown";

export const STATE_LABELS: Record<ComponentState, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  outage: "Outage",
  unknown: "Not reporting",
};

const MESSAGES: Record<StatusComponentId, Record<ComponentState, string>> = {
  app: {
    operational: "The website and API are responding.",
    degraded: "Some pages or requests are slower than usual or failing intermittently.",
    outage: "The website or API is unavailable.",
    unknown: "Health is not reported for this component.",
  },
  database: {
    operational: "Saving and loading data is working normally.",
    degraded: "Saving and loading data is slower than usual.",
    outage: "Saving and loading data is failing.",
    unknown: "Database health is not reported on this deployment.",
  },
  notifications: {
    operational: "Reminders and webhooks are being delivered on time.",
    degraded: "Some reminders or webhooks are delayed.",
    outage: "Reminders and webhooks are not being delivered.",
    unknown: "Delivery health is not reported on this deployment.",
  },
  quotes: {
    operational: "Exchange rates are available.",
    degraded: "Exchange rates are slow or coming from a backup source.",
    outage: "Exchange rates are unavailable; amounts in other currencies may be missing.",
    unknown: "Exchange-rate health is not reported on this deployment.",
  },
  reconciliation: {
    operational: "Confirmed payments are being recorded on schedule.",
    degraded: "Recording confirmed payments is delayed. Payments already on the network are safe.",
    outage: "Confirmed payments are not being recorded. Payments already on the network are safe.",
    unknown: "No reconciliation run has been recorded on this deployment yet.",
  },
};

const RANK: Record<ComponentState, number> = { operational: 0, unknown: 1, degraded: 2, outage: 3 };

function worst(a: ComponentState, b: ComponentState): ComponentState {
  return RANK[b] > RANK[a] ? b : a;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

const DATABASE_TIMEOUT_MS = 3000;
const DATABASE_SLOW_MS = 1500;
const OUTBOX_OVERDUE_MINUTES = 30;
const OUTBOX_OVERDUE_DEGRADED = 25;
const OUTBOX_DEAD_LETTERS_DEGRADED = 10;
/** The worker is scheduled daily (vercel.json); allow a missed slot of slack. */
const RECONCILIATION_STALE_HOURS = 36;

export interface StatusSignals {
  database(client: ServerClient | null): Promise<ComponentState>;
  notifications(client: ServerClient | null, now: number): Promise<ComponentState>;
  quotes(): Promise<ComponentState>;
  reconciliation(client: ServerClient | null, now: number): Promise<ComponentState>;
}

async function probeDatabase(client: ServerClient | null): Promise<ComponentState> {
  if (!client) return "unknown";
  const started = Date.now();
  try {
    const { error } = await (client as any)
      // trips exists on every provisioning path (setup file and migrations).
      .from("trips")
      .select("id", { head: true, count: "exact" })
      .limit(1)
      .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    if (error) return "outage";
    return Date.now() - started > DATABASE_SLOW_MS ? "degraded" : "operational";
  } catch {
    return "outage";
  }
}

async function probeNotifications(client: ServerClient | null, now: number): Promise<ComponentState> {
  if (!client) return "unknown";
  try {
    const overdueBefore = new Date(now - OUTBOX_OVERDUE_MINUTES * 60_000).toISOString();
    const deadSince = new Date(now - 24 * 3_600_000).toISOString();
    const [overdue, dead] = await Promise.all([
      (client as any)
        .from("transactional_outbox")
        .select("id", { head: true, count: "exact" })
        .in("channel", ["reminder", "webhook"])
        .in("status", ["pending", "failed"])
        .lt("next_attempt_at", overdueBefore)
        .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS)),
      (client as any)
        .from("transactional_outbox")
        .select("id", { head: true, count: "exact" })
        .in("channel", ["reminder", "webhook"])
        .eq("status", "dead_letter")
        .gte("created_at", deadSince)
        .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS)),
    ]);
    if (overdue.error || dead.error) return "unknown";
    if ((overdue.count ?? 0) >= OUTBOX_OVERDUE_DEGRADED || (dead.count ?? 0) >= OUTBOX_DEAD_LETTERS_DEGRADED) {
      return "degraded";
    }
    return "operational";
  } catch {
    return "unknown";
  }
}

async function probeQuotes(): Promise<ComponentState> {
  const providers = providerRegistry.getByDomain("fx").filter((p) => !p.disabled);
  if (providers.length === 0) return "unknown";
  const results = await Promise.all(
    providers.map((p) => providerRegistry.checkHealth(p.id).catch(() => ({ healthy: false, latencyMs: 0 }))),
  );
  const healthy = results.filter((r) => r.healthy);
  if (healthy.length === 0) return "outage";
  // The best available source decides: a fast healthy provider means quotes work.
  return healthy.some((r) => r.latencyMs <= 2500) ? "operational" : "degraded";
}

async function probeReconciliation(client: ServerClient | null, now: number): Promise<ComponentState> {
  let latest: { outcome: string; finishedAt: string } | null = null;
  if (client) {
    try {
      const { data, error } = await (client as any)
        .from("reconciliation_worker_runs")
        .select("outcome, finished_at")
        .order("started_at", { ascending: false })
        .limit(1)
        .abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
      if (!error && Array.isArray(data) && data[0]) latest = { outcome: data[0].outcome, finishedAt: data[0].finished_at };
    } catch {
      // Fall back to this instance's history below.
    }
  }
  if (!latest) {
    const [run] = recentReconciliationRuns(1);
    if (run) latest = { outcome: run.outcome, finishedAt: run.finishedAt };
  }
  if (!latest) return "unknown";
  if (latest.outcome === "failed") return "degraded";
  const age = now - Date.parse(latest.finishedAt);
  return age > RECONCILIATION_STALE_HOURS * 3_600_000 ? "degraded" : "operational";
}

export const defaultSignals: StatusSignals = {
  database: probeDatabase,
  notifications: probeNotifications,
  quotes: probeQuotes,
  reconciliation: probeReconciliation,
};

// ─── Public payload ──────────────────────────────────────────────────────────

export interface PublicComponentStatus {
  id: StatusComponentId;
  name: string;
  description: string;
  state: ComponentState;
  label: string;
  message: string;
}

export interface PublicIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  severityLabel: string;
  components: StatusComponentId[];
  owner: string;
  state: IncidentUpdateStatus;
  startedAt: string;
  resolvedAt: string | null;
  updateOverdue: boolean;
  updates: { at: string; status: IncidentUpdateStatus; message: string }[];
  postmortemUrl: string | null;
  resolutionSummary: string | null;
}

export interface PublicStatus {
  overall: { state: ComponentState; label: string; notReporting: number };
  components: PublicComponentStatus[];
  activeIncidents: PublicIncident[];
  recentIncidents: PublicIncident[];
  checkedAt: string;
}

const RECENT_INCIDENT_DAYS = 14;

function toPublicIncident(incident: Incident, now: number): PublicIncident {
  const last = incident.updates[incident.updates.length - 1];
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    severityLabel: INCIDENT_POLICY[incident.severity].label,
    components: incident.components,
    owner: incident.owner,
    state: last?.status ?? "investigating",
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt ?? null,
    updateOverdue: isUpdateOverdue(incident, now),
    updates: [...incident.updates].reverse().map(({ at, status, message }) => ({ at, status, message })),
    postmortemUrl: incident.postmortemUrl ?? null,
    resolutionSummary: incident.resolutionSummary ?? null,
  };
}

export interface ComputeStatusOptions {
  now?: number;
  signals?: StatusSignals;
  incidents?: Incident[];
  client?: ServerClient | null;
}

export async function computePublicStatus(options: ComputeStatusOptions = {}): Promise<PublicStatus> {
  const now = options.now ?? Date.now();
  const signals = options.signals ?? defaultSignals;
  const incidents = options.incidents ?? getPublishedIncidents();
  const client = options.client === undefined ? safeServiceClient() : options.client;

  const settle = (p: Promise<ComponentState>) => p.catch((): ComponentState => "unknown");
  const [database, notifications, quotes, reconciliation] = await Promise.all([
    settle(signals.database(client)),
    settle(signals.notifications(client, now)),
    settle(signals.quotes()),
    settle(signals.reconciliation(client, now)),
  ]);
  const measured: Record<StatusComponentId, ComponentState> = {
    app: "operational",
    database,
    notifications,
    quotes,
    reconciliation,
  };

  const active = incidents.filter((incident) => !incident.resolvedAt && Date.parse(incident.startedAt) <= now);
  for (const incident of active) {
    for (const component of incident.components) {
      measured[component] = worst(measured[component], incident.impact);
    }
  }

  const components = STATUS_COMPONENTS.map((definition): PublicComponentStatus => {
    const state = measured[definition.id] ?? "unknown";
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      state,
      label: STATE_LABELS[state],
      message: MESSAGES[definition.id][state],
    };
  });

  const notReporting = components.filter((c) => c.state === "unknown").length;
  const overallState = components.reduce<ComponentState>(
    (acc, c) => (c.state === "unknown" ? acc : worst(acc, c.state)),
    "operational",
  );
  const overallLabel =
    overallState === "outage"
      ? "Some services are unavailable"
      : overallState === "degraded"
        ? "Some services are degraded"
        : notReporting > 0
          ? "No known issues"
          : "All systems operational";

  const recentCutoff = now - RECENT_INCIDENT_DAYS * 86_400_000;
  return {
    overall: { state: overallState, label: overallLabel, notReporting },
    components,
    activeIncidents: active
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map((incident) => toPublicIncident(incident, now)),
    recentIncidents: incidents
      .filter((incident) => incident.resolvedAt && Date.parse(incident.resolvedAt) >= recentCutoff)
      .sort((a, b) => Date.parse(b.resolvedAt!) - Date.parse(a.resolvedAt!))
      .map((incident) => toPublicIncident(incident, now)),
    checkedAt: new Date(now).toISOString(),
  };
}

function safeServiceClient(): ServerClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Probes run at most this often per instance, however busy the page is. */
export const STATUS_CACHE_SECONDS = 30;
let cached: { value: PublicStatus; expires: number } | null = null;
let inflight: Promise<PublicStatus> | null = null;

export async function getPublicStatus(): Promise<PublicStatus> {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.value;
  if (!inflight) {
    inflight = computePublicStatus({ now })
      .then((value) => {
        cached = { value, expires: Date.now() + STATUS_CACHE_SECONDS * 1000 };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function __resetStatusCacheForTests(): void {
  cached = null;
  inflight = null;
}
