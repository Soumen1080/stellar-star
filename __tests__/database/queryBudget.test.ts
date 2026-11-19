/**
 * __tests__/database/queryBudget.test.ts
 *
 * Unit and integration tests for database deadlines, query budgets,
 * predictable query termination, and telemetry tracing (#421).
 */

import {
  createDatabaseRequestContext,
  runWithQueryBudget,
  getRouteBudget,
  recordQueryTrace,
  getDatabaseObservabilityReport,
  resetDatabaseObservability,
  simulateDatabaseQuery,
  QueryDeadlineExceededError,
  QueryTimeoutError,
  QueryCountBudgetExceededError,
  DEFAULT_ROUTE_BUDGETS,
} from "@/lib/supabase/queryBudget";

describe("Database Deadlines and Query Budgets", () => {
  beforeEach(() => {
    resetDatabaseObservability();
  });

  describe("Route Budget Configurations", () => {
    it("returns pre-configured budgets for sensitive routes", () => {
      const tripsBudget = getRouteBudget("/api/trips");
      expect(tripsBudget.maxQueries).toBe(3);
      expect(tripsBudget.statementTimeoutMs).toBe(2000);
      expect(tripsBudget.deadlineMs).toBe(3000);

      const expensesBudget = getRouteBudget("/api/expenses/123");
      expect(expensesBudget.maxQueries).toBe(4);
      expect(expensesBudget.statementTimeoutMs).toBe(2500);

      const settlementBudget = getRouteBudget("/api/settlement/attest");
      expect(settlementBudget.maxQueries).toBe(6);
      expect(settlementBudget.lockTimeoutMs).toBe(2000);
    });

    it("falls back to safe default budget for unknown routes", () => {
      const customBudget = getRouteBudget("/api/unknown/service");
      expect(customBudget).toEqual(DEFAULT_ROUTE_BUDGETS.default);
      expect(customBudget.statementTimeoutMs).toBe(2500);
      expect(customBudget.lockTimeoutMs).toBe(1500);
      expect(customBudget.idleTransactionTimeoutMs).toBe(3000);
    });
  });

  describe("Request Context & Deadline Propagation", () => {
    it("derives deadline from route budget by default", () => {
      const context = createDatabaseRequestContext({ route: "/api/trips" });
      expect(context.route).toBe("/api/trips");
      expect(context.isExpired()).toBe(false);
      expect(context.remainingMs()).toBeGreaterThan(2500);
      expect(context.remainingMs()).toBeLessThanOrEqual(3000);
      expect(context.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    });

    it("respects propagated x-request-deadline timestamp from headers", () => {
      const futureDeadline = Date.now() + 1200;
      const context = createDatabaseRequestContext({
        route: "/api/expenses",
        headers: {
          "x-request-deadline": String(futureDeadline),
          "x-request-id": "11111111-2222-3333-4444-555555555555",
        },
      });

      expect(context.requestId).toBe("11111111-2222-3333-4444-555555555555");
      expect(context.remainingMs()).toBeLessThanOrEqual(1200);
      expect(context.deadlineTimestamp).toBe(futureDeadline);
    });

    it("respects propagated x-request-timeout-ms from headers", () => {
      const context = createDatabaseRequestContext({
        route: "/api/settlement",
        headers: {
          "x-request-timeout-ms": "1800",
        },
      });

      expect(context.remainingMs()).toBeLessThanOrEqual(1800);
      expect(context.remainingMs()).toBeGreaterThan(1500);
    });
  });

  describe("Predictable Query Termination & Stalled Query Abort", () => {
    it("completes normal fast queries within budget", async () => {
      const context = createDatabaseRequestContext({ route: "/api/trips" });

      const result = await runWithQueryBudget(
        context,
        { operation: "trips.select", table: "trips" },
        async () => {
          return [{ id: "trip-1", name: "Tokyo" }];
        }
      );

      expect(result).toEqual([{ id: "trip-1", name: "Tokyo" }]);
      expect(context.queriesExecuted).toBe(1);
      expect(context.cumulativeDurationMs).toBeGreaterThan(0);

      const report = getDatabaseObservabilityReport();
      expect(report.recentTraces.length).toBe(1);
      expect(report.recentTraces[0].status).toBe("ok");
      expect(report.recentTraces[0].operation).toBe("trips.select");
    });

    it("predictably aborts a stalled query when statement timeout is exceeded", async () => {
      const context = createDatabaseRequestContext({
        route: "/api/trips",
        budget: { statementTimeoutMs: 50 },
      });

      let wasAborted = false;

      await expect(
        runWithQueryBudget(
          context,
          { operation: "trips.stalled_select", table: "trips" },
          async (signal) => {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve("never"), 1000);
              signal.addEventListener("abort", () => {
                wasAborted = true;
                clearTimeout(timer);
                reject(new Error("Query aborted"));
              });
            });
          }
        )
      ).rejects.toThrow(QueryTimeoutError);

      expect(wasAborted).toBe(true);

      const report = getDatabaseObservabilityReport();
      expect(report.overall.timeoutCount).toBe(1);
      expect(report.recentTraces[0].status).toBe("timeout");
      expect(report.recentTraces[0].errorCode).toBe("DATABASE_QUERY_TIMEOUT");
    });

    it("terminates query immediately when propagated deadline has already expired", async () => {
      const context = createDatabaseRequestContext({
        route: "/api/trips",
        budget: { deadlineMs: 1 },
      });

      // Wait 10ms so deadline expires
      await new Promise((r) => setTimeout(r, 15));
      expect(context.isExpired()).toBe(true);

      await expect(
        runWithQueryBudget(
          context,
          { operation: "trips.select", table: "trips" },
          async () => "result"
        )
      ).rejects.toThrow(QueryDeadlineExceededError);

      const report = getDatabaseObservabilityReport();
      expect(report.recentTraces[0].status).toBe("timeout");
      expect(report.recentTraces[0].errorCode).toBe("DATABASE_DEADLINE_EXCEEDED");
    });
  });

  describe("Query Count & Duration Budgets (Chatty / Slow Endpoints)", () => {
    it("flags chatty endpoint when query count exceeds route budget", async () => {
      const context = createDatabaseRequestContext({
        route: "/api/trips", // maxQueries is 3
        strictCountBudget: false,
      });

      for (let i = 0; i < 4; i++) {
        await runWithQueryBudget(
          context,
          { operation: `trips.query_${i}`, table: "trips" },
          async () => i
        );
      }

      expect(context.queriesExecuted).toBe(4);

      const report = getDatabaseObservabilityReport();
      expect(report.routes["/api/trips"].isChatty).toBe(true);
      expect(report.recentTraces[0].status).toBe("chatty");
    });

    it("throws QueryCountBudgetExceededError in strict mode when budget is exceeded", async () => {
      const context = createDatabaseRequestContext({
        route: "/api/trips", // maxQueries is 3
        strictCountBudget: true,
      });

      for (let i = 0; i < 3; i++) {
        await runWithQueryBudget(
          context,
          { operation: `trips.query_${i}`, table: "trips" },
          async () => i
        );
      }

      await expect(
        runWithQueryBudget(
          context,
          { operation: "trips.query_exceeded", table: "trips" },
          async () => 4
        )
      ).rejects.toThrow(QueryCountBudgetExceededError);
    });

    it("flags slow endpoint when query execution duration exceeds threshold", async () => {
      const context = createDatabaseRequestContext({
        route: "/api/expenses",
        budget: { statementTimeoutMs: 500 },
      });

      await runWithQueryBudget(
        context,
        { operation: "expenses.heavy_calculation", table: "expenses" },
        async () => {
          await new Promise((r) => setTimeout(r, 400));
          return true;
        }
      );

      const report = getDatabaseObservabilityReport();
      expect(report.recentTraces[0].status).toBe("slow");
    });
  });

  describe("Telemetry Redaction Invariant", () => {
    it("redacts Stellar secret keys, JWTs, and payloads from telemetry traces", () => {
      const secretKey = "SB3D45J7KL6M8P9QR1S2T3U4V5W6X7Y8Z9A1B2C3D4E5F6G7H8I9J1K2";
      const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

      recordQueryTrace({
        route: "/api/trips",
        requestId: "test-req-id",
        operation: "trips.select",
        table: "trips",
        durationMs: 45,
        queryCount: 1,
        rowsCount: 2,
        status: "error",
        errorCode: `Error with secret ${secretKey} and auth ${jwtToken}`,
        statementTimeoutMs: 2000,
      });

      const report = getDatabaseObservabilityReport();
      const trace = report.recentTraces[0];

      expect(trace.errorCode).not.toContain(secretKey);
      expect(trace.errorCode).toContain("[REDACTED_STELLAR_SECRET]");
      expect(trace.errorCode).not.toContain(jwtToken);
      expect(trace.errorCode).toContain("[REDACTED_JWT]");
    });
  });

  describe("Query Simulation Engine", () => {
    it("simulates fast query and returns success trace", async () => {
      const res = await simulateDatabaseQuery({
        route: "/api/trips",
        delayMs: 10,
      });

      expect(res.success).toBe(true);
      expect(res.trace.status).toBe("ok");
      expect(res.trace.route).toBe("/api/trips");
    });

    it("simulates stalled query and returns timeout trace with error", async () => {
      const res = await simulateDatabaseQuery({
        route: "/api/settlement",
        delayMs: 150,
        shouldTimeout: true,
      });

      expect(res.success).toBe(false);
      expect(res.trace.status).toBe("timeout");
      expect(res.error).toContain("timed out");
    });
  });
});
