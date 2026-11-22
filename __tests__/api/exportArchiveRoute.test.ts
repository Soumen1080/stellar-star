/**
 * #324 — POST /api/exports/archive is scoped, rate-limited and audited.
 */

import { NextRequest } from "next/server";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import type { Trip } from "@/types/trip";
import type { Expense } from "@/types/expense";

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

const auditInserts: Array<Record<string, unknown>> = [];
let auditError: { message: string } | null = null;
const fakeClient = {
  from: (table: string) => ({
    insert: async (row: Record<string, unknown>) => {
      if (table === "export_audit_events") auditInserts.push(row);
      return { error: auditError };
    },
  }),
};

const mockFetchTrips = jest.fn();
const mockFetchExpenses = jest.fn();
const mockRateLimit = jest.fn();
const mockTripIdsWithPermission = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServerClientForToken: () => fakeClient,
}));
jest.mock("@/lib/supabase/queries", () => ({
  fetchTrips: (...args: unknown[]) => mockFetchTrips(...args),
  fetchExpenses: (...args: unknown[]) => mockFetchExpenses(...args),
  fetchTripIdsWithPermission: (...args: unknown[]) => mockTripIdsWithPermission(...args),
}));
jest.mock("@/lib/auth/rateLimiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  getClientIp: () => "203.0.113.7",
  rateLimiterUnavailableResponse: (res?: any, reqId?: string) => {
    const { NextResponse } = require("next/server");
    return NextResponse.json(
      { error: "Rate limiting service is temporarily unavailable. Please retry shortly.", code: "RATE_LIMITER_UNAVAILABLE", retryAfterSeconds: 30 },
      { status: 503, headers: { "Retry-After": "30" } }
    );
  },
}));

// Imported after the mocks so the route binds to them.
const { POST } = require("@/app/api/exports/archive/route") as typeof import("@/app/api/exports/archive/route");

const trips: Trip[] = [
  { id: "trip-1", name: "Mine", members: [{ id: "a", name: "A", walletAddress: WALLET }], expenseIds: ["e1"], createdAt: "2026-01-01T00:00:00Z", settled: false },
];
const expenses: Expense[] = [
  {
    id: "e1", title: "Tiny", totalAmount: "0.0000001", currency: "XLM", splitMode: "equal", paidByMemberId: "a",
    members: trips[0].members, shares: [{ memberId: "a", name: "A", amount: "0.0000001", paid: false }],
    createdAt: "2026-01-02T00:00:00Z", settled: false,
  },
];

function request(body: unknown = {}, token: string | null = signWalletSession(WALLET)) {
  return new NextRequest("http://localhost:3000/api/exports/archive", {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auditInserts.length = 0;
  auditError = null;
  mockFetchTrips.mockReset().mockResolvedValue(trips);
  mockFetchExpenses.mockReset().mockResolvedValue(expenses);
  mockRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, resetMs: 0 });
  // Default: the caller may export every trip it asks about.
  mockTripIdsWithPermission.mockReset().mockImplementation(async (ids: string[]) => new Set(ids));
});

function manyTrips(count: number): Trip[] {
  return Array.from({ length: count }, (_, i) => ({
    ...trips[0],
    id: `trip-${i}`,
    name: `Trip ${i}`,
    expenseIds: [],
  }));
}

describe("POST /api/exports/archive", () => {
  it("requires a wallet session", async () => {
    const res = await POST(request({}, null));
    expect(res.status).toBe(401);
    expect(mockFetchTrips).not.toHaveBeenCalled();
  });

  it("serves an exact archive and audits it before returning", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=".+\.json"/);
    const body = await res.text();
    expect(body).toContain('"totalAmount": "0.0000001"');
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({ actor_wallet: WALLET, status: "served", trip_count: 1, expense_count: 1 });
    expect(auditInserts[0].content_sha256).toBe(res.headers.get("x-content-sha256"));
    // The raw IP never reaches the audit log.
    expect(JSON.stringify(auditInserts[0])).not.toContain("203.0.113.7");
  });

  it("refuses trips outside the caller's RLS-visible set, and audits the refusal", async () => {
    const res = await POST(request({ tripIds: ["trip-1", "someone-elses-trip"] }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Mine");
    expect(auditInserts[0]).toMatchObject({ status: "forbidden" });
  });

  it("rate-limits per wallet and audits the refusal", async () => {
    mockRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetMs: 30_000 });
    const res = await POST(request());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(mockFetchTrips).not.toHaveBeenCalled();
    expect(auditInserts[0]).toMatchObject({ status: "rate_limited" });
    expect(String(mockRateLimit.mock.calls[0][0])).toContain(`wallet:${WALLET}`);
  });

  it("fails closed when the audit record cannot be written", async () => {
    auditError = { message: "relation export_audit_events does not exist" };
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("0.0000001");
  });

  it("validates the requested trip ids", async () => {
    const res = await POST(request({ tripIds: ["../../etc"] }));
    expect(res.status).toBe(400);
  });

  describe("batched permission checks (#417)", () => {
    it.each([1, 10, 100, 1000])("checks %i trips with exactly one permission query", async (count) => {
      const many = manyTrips(count);
      mockFetchTrips.mockResolvedValue(many);
      const res = await POST(request({ tripIds: many.map((t) => t.id) }));
      expect(res.status).toBe(200);
      expect(mockTripIdsWithPermission).toHaveBeenCalledTimes(1);
      expect(mockTripIdsWithPermission.mock.calls[0][0]).toHaveLength(count);
      expect(mockTripIdsWithPermission.mock.calls[0][1]).toBe("exports.view");
    });

    it("checks every visible trip in one query when no ids are requested", async () => {
      mockFetchTrips.mockResolvedValue(manyTrips(250));
      const res = await POST(request());
      expect(res.status).toBe(200);
      expect(mockTripIdsWithPermission).toHaveBeenCalledTimes(1);
    });

    it("refuses with 403 when any trip lacks export permission, and serves nothing", async () => {
      const many = manyTrips(5);
      mockFetchTrips.mockResolvedValue(many);
      mockTripIdsWithPermission.mockResolvedValue(new Set(["trip-0", "trip-1", "trip-2", "trip-3"]));
      const res = await POST(request({ tripIds: many.map((t) => t.id) }));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("Trip 0");
      expect(auditInserts[0]).toMatchObject({ status: "forbidden" });
    });

    it("gives an unknown id and an unpermitted id the same response, so existence is not revealed", async () => {
      mockFetchTrips.mockResolvedValue(manyTrips(2));
      const unknown = await POST(request({ tripIds: ["trip-0", "no-such-trip"] }));
      mockTripIdsWithPermission.mockResolvedValue(new Set(["trip-0"]));
      const unpermitted = await POST(request({ tripIds: ["trip-0", "trip-1"] }));
      expect(unknown.status).toBe(403);
      expect(unpermitted.status).toBe(403);
      expect(await unknown.json()).toEqual({ error: expect.any(String) });
      const a = await POST(request({ tripIds: ["trip-0", "no-such-trip"] }));
      const b = await POST(request({ tripIds: ["trip-0", "trip-1"] }));
      expect((await a.json()).error).toBe((await b.json()).error);
    });

    it("rejects more than 1,000 requested ids", async () => {
      const res = await POST(request({ tripIds: Array.from({ length: 1001 }, (_, i) => `t-${i}`) }));
      expect(res.status).toBe(400);
      expect(mockTripIdsWithPermission).not.toHaveBeenCalled();
    });
  });
});
