/**
 * __tests__/status/statusPage.test.ts
 *
 * Issue #377: a public status page that distinguishes app, database,
 * notification, quote and reconciliation components without exposing
 * infrastructure detail, and incidents that follow a documented cadence,
 * owner and postmortem policy.
 */

import { providerRegistry } from "@/lib/routing/providerRegistry";
import {
  __resetStatusCacheForTests,
  computePublicStatus,
  defaultSignals,
  type ComponentState,
  type StatusSignals,
} from "@/lib/status/evaluate";
import {
  INCIDENT_POLICY,
  STATUS_COMPONENTS,
  STATUS_CONTENT_META,
  getPublishedIncidents,
  isUpdateOverdue,
  validateIncidentLog,
  type Incident,
} from "@/lib/status/incidents";
import { recordReconciliationRun, __resetReconciliationRunsForTests } from "@/lib/settlement/reconciliationRun";
import { GET as statusRoute } from "@/app/api/status/route";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checker = require("../../scripts/check-help-content.js");

const NOW = Date.parse("2026-11-21T12:00:00Z");

function signals(states: Partial<Record<"database" | "notifications" | "quotes" | "reconciliation", ComponentState>> = {}): StatusSignals {
  return {
    database: async () => states.database ?? "operational",
    notifications: async () => states.notifications ?? "operational",
    quotes: async () => states.quotes ?? "operational",
    reconciliation: async () => states.reconciliation ?? "operational",
  };
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "2026-11-21-recording-delay",
    title: "Delays recording confirmed payments",
    severity: "sev2",
    impact: "degraded",
    components: ["reconciliation"],
    owner: "Platform on-call",
    startedAt: "2026-11-21T10:00:00Z",
    updates: [
      { at: "2026-11-21T10:10:00Z", status: "investigating", message: "We're looking into it." },
      { at: "2026-11-21T11:05:00Z", status: "identified", message: "Cause found." },
    ],
    ...overrides,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  __resetStatusCacheForTests();
});

describe("components", () => {
  it("publishes exactly the five promised components, with an owner and review date", () => {
    expect(STATUS_COMPONENTS.map((c) => c.id)).toEqual(["app", "database", "notifications", "quotes", "reconciliation"]);
    expect(STATUS_CONTENT_META.owner).toBeTruthy();
    expect(STATUS_CONTENT_META.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reports all systems operational when every signal is healthy", async () => {
    const status = await computePublicStatus({ now: NOW, signals: signals(), incidents: [], client: null });
    expect(status.overall).toEqual({ state: "operational", label: "All systems operational", notReporting: 0 });
    expect(status.components.every((c) => c.state === "operational")).toBe(true);
  });

  it("says 'not reporting' instead of claiming health when a signal is missing", async () => {
    const status = await computePublicStatus({
      now: NOW,
      signals: signals({ database: "unknown", reconciliation: "unknown" }),
      incidents: [],
      client: null,
    });
    expect(status.overall).toEqual({ state: "operational", label: "No known issues", notReporting: 2 });
    expect(status.components.find((c) => c.id === "database")).toEqual(
      expect.objectContaining({ state: "unknown", label: "Not reporting" }),
    );
  });

  it("rolls the worst component up into the overall state", async () => {
    const degraded = await computePublicStatus({ now: NOW, signals: signals({ quotes: "degraded" }), incidents: [], client: null });
    expect(degraded.overall.label).toBe("Some services are degraded");
    const outage = await computePublicStatus({
      now: NOW,
      signals: signals({ quotes: "degraded", database: "outage" }),
      incidents: [],
      client: null,
    });
    expect(outage.overall).toEqual(expect.objectContaining({ state: "outage", label: "Some services are unavailable" }));
  });

  it("treats a signal that throws as not reporting", async () => {
    const failing: StatusSignals = { ...signals(), database: async () => { throw new Error("ECONNREFUSED 10.0.0.5:5432"); } };
    const status = await computePublicStatus({ now: NOW, signals: failing, incidents: [], client: null });
    expect(status.components.find((c) => c.id === "database")?.state).toBe("unknown");
    expect(JSON.stringify(status)).not.toContain("ECONNREFUSED");
  });

  it("exposes no infrastructure detail", async () => {
    const status = await computePublicStatus({ now: NOW, signals: signals({ quotes: "outage" }), incidents: [], client: null });
    const json = JSON.stringify(status).toLowerCase();
    for (const secret of ["coingecko", "exchangerate", "supabase", "horizon", "http", "latency", "ms\"", "relay", "internal"]) {
      expect({ secret, leaked: json.includes(secret) }).toEqual({ secret, leaked: false });
    }
    expect(Object.keys(status.components[0]).sort()).toEqual(["description", "id", "label", "message", "name", "state"]);
  });
});

describe("incidents on the page", () => {
  it("raises affected components to the incident's impact while it is open", async () => {
    const status = await computePublicStatus({ now: NOW, signals: signals(), incidents: [incident({ impact: "outage" })], client: null });
    expect(status.components.find((c) => c.id === "reconciliation")?.state).toBe("outage");
    expect(status.components.find((c) => c.id === "database")?.state).toBe("operational");
    expect(status.activeIncidents).toHaveLength(1);
    expect(status.activeIncidents[0]).toEqual(
      expect.objectContaining({ owner: "Platform on-call", severityLabel: "Major", state: "identified", updateOverdue: false }),
    );
    // Newest update first.
    expect(status.activeIncidents[0].updates[0].status).toBe("identified");
  });

  it("never downgrades a worse live signal", async () => {
    const status = await computePublicStatus({
      now: NOW,
      signals: signals({ reconciliation: "outage" }),
      incidents: [incident({ impact: "degraded" })],
      client: null,
    });
    expect(status.components.find((c) => c.id === "reconciliation")?.state).toBe("outage");
  });

  it("flags an open incident whose update is overdue", async () => {
    const late = NOW + 2 * 3_600_000;
    const status = await computePublicStatus({ now: late, signals: signals(), incidents: [incident()], client: null });
    expect(status.activeIncidents[0].updateOverdue).toBe(true);
  });

  it("lists incidents resolved in the last 14 days, then drops them", async () => {
    const resolved = incident({
      severity: "sev3",
      updates: [
        { at: "2026-11-21T10:10:00Z", status: "investigating", message: "Looking." },
        { at: "2026-11-21T11:00:00Z", status: "resolved", message: "Fixed." },
      ],
      resolvedAt: "2026-11-21T11:00:00Z",
      resolutionSummary: "A delayed job was restarted.",
    });
    const fresh = await computePublicStatus({ now: NOW, signals: signals(), incidents: [resolved], client: null });
    expect(fresh.activeIncidents).toHaveLength(0);
    expect(fresh.recentIncidents).toHaveLength(1);
    expect(fresh.components.find((c) => c.id === "reconciliation")?.state).toBe("operational");
    const later = await computePublicStatus({ now: NOW + 15 * 86_400_000, signals: signals(), incidents: [resolved], client: null });
    expect(later.recentIncidents).toHaveLength(0);
  });
});

describe("incident policy", () => {
  const ids = STATUS_COMPONENTS.map((c) => c.id);

  it("defines cadence, owner and postmortem rules per severity", () => {
    expect(INCIDENT_POLICY.sev1).toEqual(expect.objectContaining({ updateEveryMinutes: 30, postmortem: "full" }));
    expect(INCIDENT_POLICY.sev2).toEqual(expect.objectContaining({ updateEveryMinutes: 60, postmortem: "full" }));
    expect(INCIDENT_POLICY.sev3).toEqual(expect.objectContaining({ updateEveryMinutes: 240, postmortem: "summary" }));
  });

  it("keeps the CI checker's cadence in step with the policy", () => {
    expect(checker.UPDATE_CADENCE_MINUTES).toEqual({
      sev1: INCIDENT_POLICY.sev1.updateEveryMinutes,
      sev2: INCIDENT_POLICY.sev2.updateEveryMinutes,
      sev3: INCIDENT_POLICY.sev3.updateEveryMinutes,
    });
  });

  it("accepts a well-formed incident", () => {
    expect(validateIncidentLog([incident()], ids)).toEqual([]);
  });

  it("validates the published incident log", () => {
    expect(validateIncidentLog(getPublishedIncidents())).toEqual([]);
  });

  it.each<[string, Partial<Incident>, RegExp]>([
    ["no owner", { owner: " " }, /owner is required/],
    ["unknown component", { components: ["billing" as any] }, /unknown component/],
    ["no components", { components: [] }, /at least one affected component/],
    ["bad severity", { severity: "sev9" as any }, /severity must be/],
    ["bad impact", { impact: "meh" as any }, /impact must be/],
    ["bad id", { id: "Has Spaces" }, /id must be/],
    ["no updates", { updates: [] }, /at least one public update/],
    [
      "a gap longer than the cadence",
      {
        updates: [
          { at: "2026-11-21T10:10:00Z", status: "investigating", message: "a" },
          { at: "2026-11-21T11:30:00Z", status: "identified", message: "b" },
        ],
      },
      /more than 60 minutes after the previous one/,
    ],
    ["a first update later than the cadence", { updates: [{ at: "2026-11-21T11:30:00Z", status: "investigating", message: "a" }] }, /update 1 came more than 60 minutes/],
    [
      "out-of-order updates",
      {
        updates: [
          { at: "2026-11-21T10:40:00Z", status: "investigating", message: "a" },
          { at: "2026-11-21T10:20:00Z", status: "identified", message: "b" },
        ],
      },
      /time order/,
    ],
    [
      "a resolved major incident without a postmortem",
      {
        updates: [{ at: "2026-11-21T10:30:00Z", status: "resolved", message: "done" }],
        resolvedAt: "2026-11-21T10:30:00Z",
      },
      /needs postmortemUrl/,
    ],
    [
      "a resolved minor incident without a summary",
      {
        severity: "sev3",
        updates: [{ at: "2026-11-21T10:30:00Z", status: "resolved", message: "done" }],
        resolvedAt: "2026-11-21T10:30:00Z",
      },
      /needs resolutionSummary/,
    ],
    ["resolvedAt on an open incident", { resolvedAt: "2026-11-21T11:05:00Z" }, /last update is not "resolved"/],
    [
      "an update after resolution",
      {
        updates: [
          { at: "2026-11-21T10:30:00Z", status: "resolved", message: "done" },
          { at: "2026-11-21T10:40:00Z", status: "monitoring", message: "again" },
        ],
      },
      /no updates may follow/,
    ],
  ])("rejects %s", (_label, overrides, pattern) => {
    expect(validateIncidentLog([incident(overrides)], ids).join("\n")).toMatch(pattern);
  });

  it("accepts a resolved major incident with a postmortem link", () => {
    const resolved = incident({
      updates: [{ at: "2026-11-21T10:30:00Z", status: "resolved", message: "done" }],
      resolvedAt: "2026-11-21T10:30:00Z",
      postmortemUrl: "https://example.com/postmortems/recording-delay",
    });
    expect(validateIncidentLog([resolved], ids)).toEqual([]);
  });

  it("rejects duplicate ids", () => {
    expect(validateIncidentLog([incident(), incident()], ids).join("\n")).toMatch(/duplicate id/);
  });

  it("computes overdue updates from the severity cadence", () => {
    expect(isUpdateOverdue(incident(), Date.parse("2026-11-21T12:00:00Z"))).toBe(false);
    expect(isUpdateOverdue(incident(), Date.parse("2026-11-21T12:06:00Z"))).toBe(true);
    expect(isUpdateOverdue(incident({ resolvedAt: "2026-11-21T11:05:00Z" }), Date.parse("2027-01-01T00:00:00Z"))).toBe(false);
  });
});

// ─── Live signals ─────────────────────────────────────────────────────────────

/** A Supabase-like query builder whose every call chains and which resolves to `result`. */
function fakeQuery(result: unknown, calls: string[] = []) {
  const builder: any = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(result).then(resolve, reject);
        return (...args: unknown[]) => {
          calls.push(`${String(prop)}(${JSON.stringify(args[0] ?? "")})`);
          return builder;
        };
      },
    },
  );
  return builder;
}

function fakeClient(byTable: Record<string, unknown[]>) {
  const used: Record<string, number> = {};
  return {
    from(table: string) {
      const queue = byTable[table] ?? [];
      const index = used[table] ?? 0;
      used[table] = index + 1;
      return fakeQuery(queue[index] ?? queue[queue.length - 1]);
    },
  } as any;
}

describe("default signals", () => {
  it("database: not reporting without a client, outage on error, operational on success", async () => {
    expect(await defaultSignals.database(null)).toBe("unknown");
    expect(await defaultSignals.database(fakeClient({ trips: [{ error: { message: "boom" }, count: null }] }))).toBe("outage");
    expect(await defaultSignals.database(fakeClient({ trips: [{ error: null, count: 3 }] }))).toBe("operational");
  });

  it("notifications: degraded when deliveries back up or dead-letter", async () => {
    const ok = fakeClient({ transactional_outbox: [{ error: null, count: 2 }, { error: null, count: 0 }] });
    expect(await defaultSignals.notifications(ok, NOW)).toBe("operational");
    const backlog = fakeClient({ transactional_outbox: [{ error: null, count: 40 }, { error: null, count: 0 }] });
    expect(await defaultSignals.notifications(backlog, NOW)).toBe("degraded");
    const dead = fakeClient({ transactional_outbox: [{ error: null, count: 0 }, { error: null, count: 12 }] });
    expect(await defaultSignals.notifications(dead, NOW)).toBe("degraded");
    const broken = fakeClient({ transactional_outbox: [{ error: { message: "x" }, count: null }] });
    expect(await defaultSignals.notifications(broken, NOW)).toBe("unknown");
    expect(await defaultSignals.notifications(null, NOW)).toBe("unknown");
  });

  it("reconciliation: from the latest recorded run", async () => {
    const run = (outcome: string, finishedAt: string) =>
      fakeClient({ reconciliation_worker_runs: [{ error: null, data: [{ outcome, finished_at: finishedAt }] }] });
    expect(await defaultSignals.reconciliation(run("succeeded", "2026-11-21T01:00:00Z"), NOW)).toBe("operational");
    expect(await defaultSignals.reconciliation(run("failed", "2026-11-21T01:00:00Z"), NOW)).toBe("degraded");
    expect(await defaultSignals.reconciliation(run("succeeded", "2026-11-19T01:00:00Z"), NOW)).toBe("degraded");

    __resetReconciliationRunsForTests();
    const empty = fakeClient({ reconciliation_worker_runs: [{ error: null, data: [] }] });
    expect(await defaultSignals.reconciliation(empty, NOW)).toBe("unknown");
  });

  it("reconciliation: falls back to this instance's run history", async () => {
    __resetReconciliationRunsForTests();
    jest.spyOn(console, "info").mockImplementation(() => {});
    await recordReconciliationRun(
      {
        id: "r1", requestId: "q", actorKind: "cron", actorId: "cron", trigger: "schedule", batchSize: 15, batches: 1,
        walletFilter: null, startedAt: "2026-11-21T11:00:00Z", finishedAt: "2026-11-21T11:00:05Z", durationMs: 5000,
        outcome: "succeeded", processed: 0, recorded: 0, escalated: 0, pending: 0, failed: 0, errorCount: 0,
        erroredJobIds: [], failureCode: null,
      },
      null,
    );
    expect(await defaultSignals.reconciliation(null, NOW)).toBe("operational");
    __resetReconciliationRunsForTests();
  });

  it("quotes: outage only when no exchange-rate source answers", async () => {
    const check = jest.spyOn(providerRegistry, "checkHealth");
    check.mockResolvedValue({ healthy: false, latencyMs: 3000, message: "down", timestamp: 0 });
    expect(await defaultSignals.quotes()).toBe("outage");
    check.mockReset();
    check
      .mockResolvedValueOnce({ healthy: false, latencyMs: 3000, message: "down", timestamp: 0 })
      .mockResolvedValueOnce({ healthy: true, latencyMs: 120, message: "ok", timestamp: 0 });
    expect(await defaultSignals.quotes()).toBe("operational");
  });
});

describe("GET /api/status", () => {
  it("serves the public payload with a short shared cache", async () => {
    jest.spyOn(providerRegistry, "checkHealth").mockResolvedValue({ healthy: true, latencyMs: 100, message: "ok", timestamp: 0 });
    const res = await statusRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=30/);
    const body = await res.json();
    expect(body.components.map((c: { id: string }) => c.id)).toEqual(["app", "database", "notifications", "quotes", "reconciliation"]);
    // No service role in tests: the database is "not reporting", not "operational".
    expect(body.components.find((c: { id: string }) => c.id === "database").state).toBe("unknown");
    expect(body.components.find((c: { id: string }) => c.id === "quotes").state).toBe("operational");
  });
});
