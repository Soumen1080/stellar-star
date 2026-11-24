/**
 * lib/status/incidents.ts
 *
 * Incident communication policy and the published incident log (Issue #377).
 * Human-readable version: docs/INCIDENT_COMMUNICATION.md.
 *
 * Incidents are published by editing content/status/incidents.json in a pull
 * request. validateIncidentLog() rejects an entry that misses its update
 * cadence, owner or postmortem, and CI runs it on every change.
 *
 * Pure and isomorphic.
 */

import componentsData from "@/content/status/components.json";
import incidentsData from "@/content/status/incidents.json";

export type StatusComponentId = "app" | "database" | "notifications" | "quotes" | "reconciliation";
export type IncidentSeverity = "sev1" | "sev2" | "sev3";
export type IncidentImpact = "degraded" | "outage";
export type IncidentUpdateStatus = "investigating" | "identified" | "monitoring" | "resolved";

export interface IncidentPolicy {
  label: string;
  meaning: string;
  /** Longest allowed gap between public updates while unresolved. */
  updateEveryMinutes: number;
  /** "full": root cause, timeline and actions; "summary": a short resolution note. */
  postmortem: "full" | "summary";
  /** Business days after resolution by which the postmortem is published. */
  postmortemDueBusinessDays: number;
}

export const INCIDENT_POLICY: Record<IncidentSeverity, IncidentPolicy> = {
  sev1: {
    label: "Critical",
    meaning: "Most people cannot sign in, pay, or load their data.",
    updateEveryMinutes: 30,
    postmortem: "full",
    postmortemDueBusinessDays: 5,
  },
  sev2: {
    label: "Major",
    meaning: "A key feature is unavailable or badly degraded for many people.",
    updateEveryMinutes: 60,
    postmortem: "full",
    postmortemDueBusinessDays: 10,
  },
  sev3: {
    label: "Minor",
    meaning: "Limited impact, or a workaround is available.",
    updateEveryMinutes: 240,
    postmortem: "summary",
    postmortemDueBusinessDays: 10,
  },
};

export interface IncidentUpdate {
  at: string;
  status: IncidentUpdateStatus;
  message: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  impact: IncidentImpact;
  components: StatusComponentId[];
  /** A role, not a person, e.g. "Platform on-call". */
  owner: string;
  startedAt: string;
  resolvedAt?: string;
  updates: IncidentUpdate[];
  /** Required once a sev1/sev2 incident is resolved: link to the postmortem. */
  postmortemUrl?: string;
  /** Required once a sev3 incident is resolved. */
  resolutionSummary?: string;
}

export interface StatusComponentDefinition {
  id: StatusComponentId;
  name: string;
  description: string;
}

export const STATUS_COMPONENTS = componentsData.components as StatusComponentDefinition[];
export const STATUS_CONTENT_META = {
  version: componentsData.version,
  updated: componentsData.updated,
  owner: componentsData.owner,
  reviewBy: componentsData.reviewBy,
};

const UPDATE_STATUSES: IncidentUpdateStatus[] = ["investigating", "identified", "monitoring", "resolved"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

function time(value: unknown): number {
  return typeof value === "string" && ISO.test(value) ? Date.parse(value) : NaN;
}

/** Problems with one incident, independent of the current time. */
export function validateIncident(incident: Incident, componentIds: readonly string[]): string[] {
  const errors: string[] = [];
  const where = `incident "${incident?.id ?? "?"}"`;

  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(incident.id ?? "")) errors.push(`${where}: id must be 3-64 lowercase letters, digits or hyphens`);
  if (!incident.title?.trim() || incident.title.length > 120) errors.push(`${where}: title is required (at most 120 characters)`);
  const policy = INCIDENT_POLICY[incident.severity];
  if (!policy) errors.push(`${where}: severity must be sev1, sev2 or sev3`);
  if (incident.impact !== "degraded" && incident.impact !== "outage") errors.push(`${where}: impact must be degraded or outage`);
  if (!Array.isArray(incident.components) || incident.components.length === 0) {
    errors.push(`${where}: list at least one affected component`);
  } else {
    for (const component of incident.components) {
      if (!componentIds.includes(component)) errors.push(`${where}: unknown component "${component}"`);
    }
  }
  if (!incident.owner?.trim()) errors.push(`${where}: an owner is required`);

  const started = time(incident.startedAt);
  if (Number.isNaN(started)) errors.push(`${where}: startedAt must be an ISO UTC timestamp`);

  const updates = Array.isArray(incident.updates) ? incident.updates : [];
  if (updates.length === 0) errors.push(`${where}: at least one public update is required`);

  let previous = started;
  updates.forEach((update, index) => {
    const at = time(update.at);
    if (Number.isNaN(at)) {
      errors.push(`${where}: update ${index + 1} has an invalid timestamp`);
      return;
    }
    if (!UPDATE_STATUSES.includes(update.status)) errors.push(`${where}: update ${index + 1} has an unknown status`);
    if (!update.message?.trim() || update.message.length > 600) {
      errors.push(`${where}: update ${index + 1} needs a message (at most 600 characters)`);
    }
    if (!Number.isNaN(previous) && at < previous) errors.push(`${where}: updates must be in time order`);
    if (policy && !Number.isNaN(previous) && at - previous > policy.updateEveryMinutes * 60_000) {
      errors.push(
        `${where}: update ${index + 1} came more than ${policy.updateEveryMinutes} minutes after the previous one (${policy.label} cadence)`,
      );
    }
    if (update.status === "resolved" && index !== updates.length - 1) {
      errors.push(`${where}: no updates may follow the resolved update`);
    }
    previous = at;
  });

  const last = updates[updates.length - 1];
  const resolved = last?.status === "resolved";
  if (resolved && incident.resolvedAt !== last.at) errors.push(`${where}: resolvedAt must equal the resolved update's time`);
  if (!resolved && incident.resolvedAt) errors.push(`${where}: resolvedAt is set but the last update is not "resolved"`);

  if (resolved && policy?.postmortem === "full") {
    const url = incident.postmortemUrl ?? "";
    if (!/^(https:\/\/|\/)/.test(url)) {
      errors.push(`${where}: a resolved ${policy.label} incident needs postmortemUrl (see docs/INCIDENT_COMMUNICATION.md)`);
    }
  }
  if (resolved && policy?.postmortem === "summary" && !incident.resolutionSummary?.trim()) {
    errors.push(`${where}: a resolved ${policy.label} incident needs resolutionSummary`);
  }
  return errors;
}

/** Problems with the whole log: each incident plus unique ids. */
export function validateIncidentLog(incidents: Incident[], componentIds: readonly string[] = STATUS_COMPONENTS.map((c) => c.id)): string[] {
  const errors = incidents.flatMap((incident) => validateIncident(incident, componentIds));
  const seen = new Set<string>();
  for (const incident of incidents) {
    if (seen.has(incident.id)) errors.push(`incident "${incident.id}": duplicate id`);
    seen.add(incident.id);
  }
  return errors;
}

/** True when an unresolved incident has gone longer than its cadence without an update. */
export function isUpdateOverdue(incident: Incident, now = Date.now()): boolean {
  if (incident.resolvedAt) return false;
  const policy = INCIDENT_POLICY[incident.severity];
  const last = incident.updates[incident.updates.length - 1];
  const lastAt = last ? Date.parse(last.at) : Date.parse(incident.startedAt);
  return now - lastAt > policy.updateEveryMinutes * 60_000;
}

export function getPublishedIncidents(): Incident[] {
  return incidentsData.incidents as Incident[];
}
