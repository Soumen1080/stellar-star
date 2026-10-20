import {
  buildDraftPayload,
  dueOccurrences,
  nthOccurrence,
  occurrencesBetween,
  upcomingOccurrences,
} from "@/lib/recurring/schedule";
import { planDrafts, generateDueDrafts } from "@/lib/recurring/generate";
import type { OccurrenceException, RecurringTemplate } from "@/types/recurring";

function template(overrides: Partial<RecurringTemplate> = {}): RecurringTemplate {
  return {
    id: "t1",
    tripId: "trip",
    title: "Rent",
    description: null,
    category: "rent",
    tags: ["home"],
    currency: "XLM",
    amountRule: { kind: "fixed", amount: "500" },
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice" },
      { id: "m2", name: "Bob" },
    ],
    cadence: { unit: "month", interval: 1 },
    startDate: "2026-01-31",
    endDate: null,
    generateFrom: "2026-01-31",
    reminderLeadDays: null,
    status: "active",
    version: 1,
    createdByWallet: "GA",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const skip = (date: string): OccurrenceException => ({
  id: `x-${date}`,
  templateId: "t1",
  occurrenceDate: date,
  action: "skip",
  overrides: {},
});

describe("cadence math", () => {
  it("clamps month-end anchors without drifting", () => {
    const cadence = { unit: "month" as const, interval: 1 };
    expect([0, 1, 2, 3].map((k) => nthOccurrence("2026-01-31", cadence, k))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("handles leap days on yearly cadences", () => {
    const cadence = { unit: "year" as const, interval: 1 };
    expect(nthOccurrence("2028-02-29", cadence, 1)).toBe("2029-02-28");
    expect(nthOccurrence("2028-02-29", cadence, 4)).toBe("2032-02-29");
  });

  it("supports every-N weeks and respects start/end dates", () => {
    const t = template({ cadence: { unit: "week", interval: 2 }, startDate: "2026-10-01", endDate: "2026-11-01" });
    expect(occurrencesBetween(t, "2026-09-01", "2026-12-31")).toEqual(["2026-10-01", "2026-10-15", "2026-10-29"]);
  });

  it("skips ahead efficiently for long-running daily series", () => {
    const t = template({ cadence: { unit: "day", interval: 1 }, startDate: "2020-01-01" });
    expect(occurrencesBetween(t, "2026-10-19", "2026-10-20")).toEqual(["2026-10-19", "2026-10-20"]);
  });
});

describe("dueOccurrences", () => {
  it("produces nothing for paused or ended templates", () => {
    expect(dueOccurrences(template({ status: "paused" }), [], "2026-06-01")).toEqual([]);
    expect(dueOccurrences(template({ status: "ended" }), [], "2026-06-01")).toEqual([]);
  });

  it("excludes skipped occurrences", () => {
    const due = dueOccurrences(template(), [skip("2026-04-30")], "2026-05-31");
    expect(due).toContain("2026-05-31");
    expect(due).not.toContain("2026-04-30");
  });

  it("does not back-fill a pause after resume (generate_from moves forward)", () => {
    const due = dueOccurrences(template({ generateFrom: "2026-05-15" }), [], "2026-05-31");
    expect(due).toEqual(["2026-05-31"]);
  });

  it("creates drafts early by the reminder lead time", () => {
    const due = dueOccurrences(template({ reminderLeadDays: 3, generateFrom: "2026-05-01" }), [], "2026-05-28");
    expect(due).toEqual(["2026-05-31"]);
  });

  it("limits catch-up after long downtime", () => {
    const t = template({ cadence: { unit: "day", interval: 1 }, startDate: "2020-01-01", generateFrom: "2020-01-01" });
    expect(dueOccurrences(t, [], "2026-10-20").length).toBeLessThanOrEqual(31);
  });
});

describe("drafts", () => {
  it("snapshots the template and applies a one-off override", () => {
    const override: OccurrenceException = {
      id: "o",
      templateId: "t1",
      occurrenceDate: "2026-02-28",
      action: "override",
      overrides: { amount: "550" },
    };
    const payload = buildDraftPayload(template(), override);
    expect(payload).toMatchObject({ title: "Rent", amount: "550", amountKind: "fixed", paidByMemberId: "m1" });
  });

  it("leaves a variable amount for the reviewer", () => {
    const payload = buildDraftPayload(template({ amountRule: { kind: "variable", estimate: null } }), null);
    expect(payload.amount).toBe("");
    expect(payload.amountKind).toBe("variable");
  });

  it("upcoming list marks skipped dates", () => {
    const list = upcomingOccurrences(template(), [skip("2026-03-31")], "2026-02-01", 3);
    expect(list.map((o) => [o.date, o.exception?.action ?? null])).toEqual([
      ["2026-02-28", null],
      ["2026-03-31", "skip"],
      ["2026-04-30", null],
    ]);
  });

  it("records the source template and version on every planned draft", () => {
    const plan = planDrafts([template({ version: 3, generateFrom: "2026-05-01" })], [], "2026-05-31");
    expect(plan).toEqual([expect.objectContaining({ templateId: "t1", templateVersion: 3, occurrenceDate: "2026-05-31" })]);
  });

  it("is idempotent: a second run inserts with ignore-duplicates on (template_id, occurrence_date)", async () => {
    const created = new Set<string>();
    const upsert = jest.fn((rows: Array<{ template_id: string; occurrence_date: string }>, options: unknown) => {
      const fresh = rows.filter((r) => !created.has(`${r.template_id}:${r.occurrence_date}`));
      fresh.forEach((r) => created.add(`${r.template_id}:${r.occurrence_date}`));
      return { select: async () => ({ data: fresh.map((r) => ({ ...r, payload: {}, status: "pending" })), error: null }), options };
    });
    const client = { from: () => ({ upsert }) } as never;
    const t = template({ generateFrom: "2026-05-01" });

    const first = await generateDueDrafts(client, [t], [], "2026-05-31");
    const second = await generateDueDrafts(client, [t], [], "2026-05-31");

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: "template_id,occurrence_date", ignoreDuplicates: true });
  });
});
