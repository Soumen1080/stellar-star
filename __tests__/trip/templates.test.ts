/**
 * Trip templates & duplicate-from-history (#321).
 *
 * The property under test throughout: a copy carries the group's structure
 * (members, recurring rules, permissions) and never its history (expenses,
 * shares, payments, balances, settled state).
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TRIP_PERMISSIONS,
  buildTemplateFromTrip,
  buildTripDraftFromTemplate,
  buildTripDraftFromTrip,
  canPerformTripAction,
  copyMembers,
  describeCopy,
  newCopyIdempotencyKey,
  normalizePermissions,
  normalizeRecurringRules,
  toTripCopyPayload,
  tripDurationDays,
  validateTripDraft,
} from "@/lib/trip/templates";
import type { Trip, TripTemplate } from "@/types/trip";

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

function sequentialIds(prefix = "new") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function pastTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: "trip-2025",
    name: "Cabin Weekend 2025",
    description: "Annual trip",
    members: [
      { id: "m-alice", name: "Alice", walletAddress: ADDR_A.toLowerCase(), weight: 3 },
      { id: "m-bob", name: "Bob", walletAddress: ADDR_B },
      { id: "m-carol", name: "  Carol  " },
    ],
    expenseIds: ["exp-1", "exp-2", "exp-3"],
    createdAt: "2025-06-01T00:00:00.000Z",
    settled: true,
    createdByWallet: ADDR_A,
    startsOn: "2025-06-06",
    endsOn: "2025-06-08",
    recurringRules: [
      {
        id: "rule-cabin",
        title: "Cabin booking",
        amount: "450.5",
        splitMode: "equal",
        paidByMemberId: "m-bob",
        cadence: "per_trip",
      },
    ],
    permissions: { membersCanAddExpenses: false, membersCanInvite: true },
    ...overrides,
  };
}

const HISTORY_KEYS = ["expenseIds", "expense_ids", "settled", "shares", "txHash", "paid"];

function expectNoHistory(value: unknown) {
  const json = JSON.stringify(value);
  for (const key of HISTORY_KEYS) {
    expect({ key, present: json.includes(`"${key}"`) }).toEqual({ key, present: false });
  }
  expect(json).not.toContain("exp-1");
}

describe("copying never carries history", () => {
  it("buildTemplateFromTrip keeps structure and drops expenses, shares and settled state", () => {
    const template = buildTemplateFromTrip(pastTrip(), { newId: sequentialIds() });

    expect(template.name).toBe("Cabin Weekend 2025");
    expect(template.members.map((m) => m.name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(template.recurringRules).toHaveLength(1);
    expect(template.permissions).toEqual({ membersCanAddExpenses: false, membersCanInvite: true });
    expect(template.durationDays).toBe(3);
    expect(template.sourceTripId).toBe("trip-2025");
    expectNoHistory(template);
  });

  it("buildTripDraftFromTrip produces an unsettled draft with no expense ids", () => {
    const draft = buildTripDraftFromTrip(pastTrip(), {
      newId: sequentialIds(),
      now: new Date("2026-06-05T12:00:00Z"),
    });

    expect(draft.name).toBe("Cabin Weekend 2025 (copy)");
    expectNoHistory(draft);
  });

  it("the RPC payload cannot express expense ids or a settled flag", () => {
    const draft = buildTripDraftFromTrip(pastTrip(), { newId: sequentialIds() });
    const payload = toTripCopyPayload("new-trip-id", draft);

    expect(Object.keys(payload).sort()).toEqual(
      [
        "description",
        "ends_on",
        "id",
        "members",
        "name",
        "permissions",
        "recurring_rules",
        "starts_on",
      ].sort(),
    );
    expectNoHistory(payload);
  });

  it("ignores a hand-crafted draft that tries to smuggle history through", () => {
    const draft = buildTripDraftFromTrip(pastTrip(), { newId: sequentialIds() }) as any;
    draft.expenseIds = ["exp-1"];
    draft.settled = true;
    draft.members[0].shares = [{ paid: true, txHash: "abc" }];

    const payload = toTripCopyPayload("new-trip-id", draft);
    expectNoHistory(payload);
  });
});

describe("member and rule id remapping", () => {
  it("gives every copied member a fresh id and canonicalises wallets", () => {
    const { members, idMap } = copyMembers(pastTrip().members, sequentialIds("m"));

    expect(members.map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(members[0].walletAddress).toBe(ADDR_A);
    expect(members[2].walletAddress).toBeUndefined();
    // Per-expense split weights are not identity and do not travel.
    expect((members[0] as any).weight).toBeUndefined();
    expect(idMap.get("m-bob")).toBe("m-2");
  });

  it("points a rule's payer at the remapped member", () => {
    const draft = buildTripDraftFromTrip(pastTrip(), { newId: sequentialIds() });
    const bob = draft.members.find((m) => m.name === "Bob")!;

    expect(bob.id).not.toBe("m-bob");
    expect(draft.recurringRules![0].paidByMemberId).toBe(bob.id);
    expect(draft.recurringRules![0].id).not.toBe("rule-cabin");
  });

  it("drops members with no name instead of copying blank rows", () => {
    const { members } = copyMembers(
      [{ id: "a", name: "Alice" }, { id: "b", name: "   " }],
      sequentialIds(),
    );
    expect(members).toHaveLength(1);
  });
});

describe("drafts from templates", () => {
  const template: TripTemplate = {
    id: "tpl-1",
    name: "Flat 4B",
    description: "Monthly bills",
    members: [
      { id: "t-a", name: "Alice", walletAddress: ADDR_A },
      { id: "t-b", name: "Bob" },
    ],
    recurringRules: [
      { id: "r1", title: "Rent", amount: "1200", splitMode: "equal", cadence: "monthly", paidByMemberId: "t-a" },
    ],
    permissions: { membersCanAddExpenses: true, membersCanInvite: false },
    durationDays: 30,
    ownerWallet: ADDR_A,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("suggests dates from the template's duration, starting today", () => {
    const draft = buildTripDraftFromTemplate(template, {
      newId: sequentialIds(),
      now: new Date("2026-03-01T09:00:00Z"),
    });

    expect(draft.startsOn).toBe("2026-03-01");
    expect(draft.endsOn).toBe("2026-03-30");
    expect(tripDurationDays(draft.startsOn, draft.endsOn)).toBe(30);
  });

  it("leaves dates empty when the source had none", () => {
    const draft = buildTripDraftFromTemplate({ ...template, durationDays: undefined });
    expect(draft.startsOn).toBeUndefined();
    expect(draft.endsOn).toBeUndefined();
  });

  it("copies permissions and rules but not the template's own ids", () => {
    const draft = buildTripDraftFromTemplate(template, { newId: sequentialIds() });
    expect(draft.permissions).toEqual({ membersCanAddExpenses: true, membersCanInvite: false });
    expect(draft.members.map((m) => m.id)).not.toContain("t-a");
    expect(draft.recurringRules![0].paidByMemberId).toBe(draft.members[0].id);
  });
});

describe("copy preview", () => {
  it("lists what is copied and what is left behind for a past trip", () => {
    const preview = describeCopy({ kind: "trip", trip: pastTrip() });

    expect(preview.copied[0]).toBe("3 members (2 with a wallet address)");
    expect(preview.copied).toContain("1 recurring expense rule");
    expect(preview.copied.join(" ")).toMatch(/cannot add expenses, can invite/);
    expect(preview.excluded).toContain("3 past expenses");
    expect(preview.excluded).toContain("Balances and who-owes-whom");
    expect(preview.excluded).toContain("Payment history and transaction hashes");
    expect(preview.excluded).toContain("Settled status");
  });

  it("never reports expenses for a template, which has none", () => {
    const template = { ...buildTemplateFromTrip(pastTrip()), id: "t", ownerWallet: ADDR_A, createdAt: "", updatedAt: "" };
    const preview = describeCopy({ kind: "template", template });
    expect(preview.excluded.join(" ")).not.toMatch(/past expense/);
  });
});

describe("draft validation", () => {
  const valid = () => buildTripDraftFromTrip(pastTrip(), { newId: sequentialIds() });

  it("accepts a well-formed draft", () => {
    expect(validateTripDraft(valid())).toEqual({});
  });

  it("rejects an end date before the start date", () => {
    const draft = { ...valid(), startsOn: "2026-05-10", endsOn: "2026-05-09" };
    expect(validateTripDraft(draft).endsOn).toMatch(/on or after/);
  });

  it("rejects impossible calendar dates", () => {
    expect(validateTripDraft({ ...valid(), startsOn: "2026-02-30" }).startsOn).toBeDefined();
  });

  it("rejects rule amounts that are not exact positive decimals", () => {
    for (const amount of ["0", "-5", "abc", "1.12345678", "1e3"]) {
      const draft = valid();
      draft.recurringRules![0] = { ...draft.recurringRules![0], amount };
      expect({ amount, error: Boolean(validateTripDraft(draft).rule_amount_0) }).toEqual({
        amount,
        error: true,
      });
    }
  });

  it("flags a rule whose payer was removed from the member list", () => {
    const draft = valid();
    const payerId = draft.recurringRules![0].paidByMemberId!;
    draft.members = draft.members.filter((m) => m.id !== payerId);
    expect(validateTripDraft(draft).rule_payer_0).toBeDefined();
  });
});

describe("normalisers", () => {
  it("defaults missing or malformed permissions", () => {
    expect(normalizePermissions(undefined)).toEqual(DEFAULT_TRIP_PERMISSIONS);
    expect(normalizePermissions({ membersCanInvite: "no" })).toEqual(DEFAULT_TRIP_PERMISSIONS);
    expect(normalizePermissions({ membersCanInvite: false }).membersCanInvite).toBe(false);
  });

  it("keeps rule amounts exact and never in float notation", () => {
    const [rule] = normalizeRecurringRules([
      { id: "r", title: "Rent", amount: "1234.5678901", splitMode: "equal", cadence: "monthly" },
    ]);
    expect(rule.amount).toBe("1234.5678901");
  });

  it("drops rules read back from JSONB that cannot become an expense", () => {
    const rules = normalizeRecurringRules([
      null,
      "rent",
      { title: "", amount: "5" },
      { title: "Ok", amount: "5", cadence: "hourly", splitMode: "weird" },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      title: "Ok",
      amount: "5.0000000",
      cadence: "per_trip",
      splitMode: "equal",
    });
    expect(typeof rules[0].id).toBe("string");
  });
});

describe("permissions", () => {
  const trip = pastTrip({ permissions: { membersCanAddExpenses: false, membersCanInvite: false } });

  it("always lets the creator act, case-insensitively", () => {
    expect(canPerformTripAction(trip, ADDR_A.toLowerCase(), "membersCanAddExpenses")).toBe(true);
  });

  it("applies the trip settings to everyone else", () => {
    expect(canPerformTripAction(trip, ADDR_B, "membersCanAddExpenses")).toBe(false);
    expect(canPerformTripAction(pastTrip(), ADDR_B, "membersCanInvite")).toBe(true);
  });

  it("treats trips that predate permissions as fully open", () => {
    expect(canPerformTripAction({ createdByWallet: ADDR_A }, ADDR_B, "membersCanInvite")).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("are unique per attempt and long enough for the database check", () => {
    const a = newCopyIdempotencyKey();
    const b = newCopyIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});

describe("database function guarantees (static)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const migration = fs.readFileSync(path.join(ROOT, "migrations/0008_trip_templates.sql"), "utf8");
  const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

  it("forces empty history on every copied trip", () => {
    expect(migration).toMatch(/ARRAY\[\]::TEXT\[\],\s+-- history is never copied\s+FALSE,/);
  });

  it("claims the idempotency key before writing and replays on conflict", () => {
    const claim = migration.indexOf("ON CONFLICT (idempotency_key) DO NOTHING");
    const tripInsert = migration.indexOf("INSERT INTO public.trips (");
    expect(claim).toBeGreaterThan(0);
    expect(tripInsert).toBeGreaterThan(claim);
    expect(migration).toContain("CONSTRAINT trip_copy_events_idempotency_key_unique UNIQUE (idempotency_key)");
  });

  it("keeps the audit log append-only (no UPDATE or DELETE policy)", () => {
    expect(migration).not.toMatch(/CREATE POLICY \w+ ON public\.trip_copy_events\s+FOR (UPDATE|DELETE)/);
    expect(migration).toMatch(/GRANT SELECT, INSERT ON public\.trip_copy_events TO authenticated;/);
  });

  it("runs as the caller so RLS decides which sources can be copied", () => {
    expect(migration.match(/^SECURITY INVOKER$/gm)?.length).toBe(2);
    expect(migration).not.toMatch(/SECURITY DEFINER/);
  });

  it("is recorded in the cumulative setup path", () => {
    expect(setup).toContain("('0008', '0008_trip_templates', 'trip_templates_v1')");
    expect(setup).toContain("CREATE OR REPLACE FUNCTION public.create_trip_from_copy(");
  });
});
