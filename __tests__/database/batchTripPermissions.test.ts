/**
 * Issue #417: one RLS-safe query resolves archive permissions for every trip.
 */
import fs from "node:fs";
import path from "node:path";
import { fetchTripIdsWithPermission, MAX_BATCH_PERMISSION_TRIPS } from "@/lib/supabase/queries";

const ROOT = path.resolve(__dirname, "../..");
const sql = fs.readFileSync(path.join(ROOT, "migrations/0026_batch_trip_permissions.sql"), "utf8");
const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");
const route = fs.readFileSync(path.join(ROOT, "app/api/exports/archive/route.ts"), "utf8");
const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, "__tests__/database/fixtures/batchTripPermissionsPlan.fixture.json"), "utf8"),
);

function fakeClient(data: unknown, error: unknown = null) {
  const rpc = jest.fn(async () => ({ data, error }));
  return { client: { rpc } as any, rpc };
}

describe("fetchTripIdsWithPermission", () => {
  it("makes exactly one RPC for 1 or 1,000 ids", async () => {
    for (const count of [1, 1000]) {
      const ids = Array.from({ length: count }, (_, i) => `id-${i}`);
      const { client, rpc } = fakeClient(ids);
      const allowed = await fetchTripIdsWithPermission(ids, "exports.view", client);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("trips_with_permission", { p_trip_ids: ids, p_permission: "exports.view" });
      expect(allowed.size).toBe(count);
    }
  });

  it("makes no query for an empty list and dedupes ids", async () => {
    const empty = fakeClient([]);
    expect((await fetchTripIdsWithPermission([], "exports.view", empty.client)).size).toBe(0);
    expect(empty.rpc).not.toHaveBeenCalled();
    const dup = fakeClient(["a"]);
    await fetchTripIdsWithPermission(["a", "a", "a"], "exports.view", dup.client);
    expect(dup.rpc.mock.calls[0]).toEqual(["trips_with_permission", { p_trip_ids: ["a"], p_permission: "exports.view" }]);
  });

  it("accepts row-shaped results and treats absent ids as denied", async () => {
    const { client } = fakeClient([{ trips_with_permission: "a" }]);
    const allowed = await fetchTripIdsWithPermission(["a", "b"], "exports.view", client);
    expect(allowed.has("a")).toBe(true);
    expect(allowed.has("b")).toBe(false);
  });

  it("refuses more than the cap without querying, and surfaces database errors", async () => {
    const big = fakeClient([]);
    const ids = Array.from({ length: MAX_BATCH_PERMISSION_TRIPS + 1 }, (_, i) => `id-${i}`);
    await expect(fetchTripIdsWithPermission(ids, "exports.view", big.client)).rejects.toThrow();
    expect(big.rpc).not.toHaveBeenCalled();
    const broken = fakeClient(null, { message: "boom", code: "42883" });
    await expect(fetchTripIdsWithPermission(["a"], "exports.view", broken.client)).rejects.toThrow();
  });
});

describe("trips_with_permission SQL", () => {
  it("is RLS-safe: scoped to the caller's own membership, anon gets nothing", () => {
    expect(sql).toMatch(/t\.member_wallets @> ARRAY\[c\.wallet\]/);
    expect(sql).toMatch(/c\.wallet IS NOT NULL/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.trips_with_permission\(UUID\[\], TEXT\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.trips_with_permission\(UUID\[\], TEXT\) TO authenticated;/);
  });

  it("returns only permitted ids (no per-id status that would reveal existence)", () => {
    expect(sql).toMatch(/RETURNS SETOF UUID/);
    expect(sql).not.toMatch(/RETURNS TABLE/);
  });

  it("applies the same role rules as trip_has_permission and caps the batch", () => {
    expect(sql).toMatch(/r\.role IN \('owner', 'organizer'\)/);
    expect(sql).toMatch(/r\.role = 'viewer' AND p_permission = 'exports\.view'/);
    expect(sql).toMatch(/cardinality\(p_trip_ids\) <= 1000/);
  });

  it("is mirrored into supabase-setup.sql", () => {
    expect(setup).toContain("CREATE OR REPLACE FUNCTION public.trips_with_permission(p_trip_ids UUID[], p_permission TEXT)");
  });

  it("has a plan fixture showing the primary-key index and one statement per export", () => {
    const plan = fixture.fixtures[0];
    expect(plan.plan.outer).toBe("Index Scan using trips_pkey on trips t");
    expect(plan.performance.statements_per_export).toBe(1);
    expect(plan.equivalence.mismatches).toBe(0);
    expect(plan.non_disclosure.nonexistent_trip_returned).toBe(false);
  });
});

describe("archive route", () => {
  it("no longer checks permissions one trip at a time", () => {
    expect(route).not.toMatch(/hasTripPermission/);
    expect(route).toMatch(/fetchTripIdsWithPermission\(/);
  });
});
