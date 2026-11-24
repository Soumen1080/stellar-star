/**
 * __tests__/api/databasePerformanceApi.test.ts
 *
 * API route tests for database performance observability and simulation (#421).
 */

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/analytics/database-performance/route";
import { resetDatabaseObservability } from "@/lib/supabase/queryBudget";

describe("Database Performance & Telemetry API", () => {
  beforeEach(() => {
    resetDatabaseObservability();
  });

  it("GET returns database performance metrics and preconfigured route budgets", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.overall).toBeDefined();
    expect(data.overall.totalCalls).toBe(0);
    expect(data.routes).toBeDefined();
    expect(data.routes["/api/trips"]).toBeDefined();
    expect(data.budgets).toBeDefined();
    expect(data.budgets["/api/trips"].maxQueries).toBe(3);
    expect(Array.isArray(data.recentTraces)).toBe(true);
  });

  it("POST executes simulation and returns real-time trace telemetry", async () => {
    const req = new NextRequest("http://localhost:3000/api/analytics/database-performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        simulate: true,
        route: "/api/trips",
        delayMs: 20,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.trace).toBeDefined();
    expect(data.trace.route).toBe("/api/trips");
    expect(data.trace.status).toBe("ok");
    expect(data.updatedReport.overall.totalCalls).toBe(1);
  });

  it("POST ingests custom database trace records cleanly", async () => {
    const req = new NextRequest("http://localhost:3000/api/analytics/database-performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route: "/api/expenses",
        requestId: "trace-req-uuid-1234",
        operation: "expenses.select",
        table: "expenses",
        durationMs: 85,
        queryCount: 1,
        status: "ok",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.trace.route).toBe("/api/expenses");
    expect(data.trace.requestId).toBe("trace-req-uuid-1234");
  });

  it("POST rejects invalid payloads with 400 Bad Request", async () => {
    const req = new NextRequest("http://localhost:3000/api/analytics/database-performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invalidKey: "no-simulate-and-no-trace",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const data = await res.json();
    expect(data.error).toContain("Invalid request payload");
  });
});
