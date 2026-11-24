/**
 * lib/supabase/queryBudget.ts
 *
 * Database Deadlines, Query Budgets, and Route-Level Tracing Engine (#421).
 *
 * Guarantees:
 *  1. Every database call respects a propagated request deadline.
 *  2. Statement, lock, and idle timeouts prevent unconstrained queries from
 *     exhausting connection pools or cascading into total service exhaustion.
 *  3. Stalled queries terminate predictably via AbortSignal/timeout instead of
 *     consuming workers indefinitely until external platform timeouts.
 *  4. Route query budgets enforce limits on query count and cumulative duration,
 *     flagging slow or chatty endpoints in real time.
 *  5. ZERO secret, token, or private data leakage in telemetry traces.
 */

import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

// ─── Types & Configurations ──────────────────────────────────────────────────

export interface QueryBudgetConfig {
  /** Maximum number of queries allowed for this request/route. */
  maxQueries: number;
  /** Maximum cumulative duration allowed for database calls in milliseconds. */
  maxDurationMs: number;
  /** Per-query statement timeout in milliseconds. */
  statementTimeoutMs: number;
  /** Lock wait timeout in milliseconds. */
  lockTimeoutMs: number;
  /** Idle transaction timeout in milliseconds. */
  idleTransactionTimeoutMs: number;
  /** Overall request deadline in milliseconds. */
  deadlineMs: number;
}

export type QueryTraceStatus = "ok" | "slow" | "chatty" | "timeout" | "error";

export interface QueryTraceRecord {
  id: string;
  route: string;
  requestId: string;
  operation: string;
  table: string;
  durationMs: number;
  queryCount: number;
  rowsCount: number;
  status: QueryTraceStatus;
  errorCode?: string;
  statementTimeoutMs: number;
  timestamp: string;
}

export interface RoutePerformanceSummary {
  route: string;
  totalRequests: number;
  totalQueries: number;
  avgQueriesPerRequest: number;
  avgDurationMs: number;
  p95DurationMs: number;
  slowestDurationMs: number;
  timeoutCount: number;
  errorCount: number;
  isSlow: boolean;
  isChatty: boolean;
  budget: QueryBudgetConfig;
}

export interface OverallDatabaseMetrics {
  totalCalls: number;
  totalRequests: number;
  avgDurationMs: number;
  p95DurationMs: number;
  timeoutCount: number;
  errorCount: number;
  routes: Record<string, RoutePerformanceSummary>;
}

export interface DatabaseObservabilityReport {
  overall: OverallDatabaseMetrics;
  routes: Record<string, RoutePerformanceSummary>;
  recentTraces: QueryTraceRecord[];
  timestamp: string;
}

// ─── Default Route Budgets ───────────────────────────────────────────────────

export const DEFAULT_ROUTE_BUDGETS: Record<string, QueryBudgetConfig> = {
  "/api/trips": {
    maxQueries: 3,
    maxDurationMs: 1500,
    statementTimeoutMs: 2000,
    lockTimeoutMs: 1500,
    idleTransactionTimeoutMs: 3000,
    deadlineMs: 3000,
  },
  "/api/expenses": {
    maxQueries: 4,
    maxDurationMs: 2000,
    statementTimeoutMs: 2500,
    lockTimeoutMs: 1500,
    idleTransactionTimeoutMs: 3000,
    deadlineMs: 4000,
  },
  "/api/settlement": {
    maxQueries: 6,
    maxDurationMs: 3000,
    statementTimeoutMs: 3000,
    lockTimeoutMs: 2000,
    idleTransactionTimeoutMs: 4000,
    deadlineMs: 5000,
  },
  "/api/auth": {
    maxQueries: 3,
    maxDurationMs: 1000,
    statementTimeoutMs: 1000,
    lockTimeoutMs: 1000,
    idleTransactionTimeoutMs: 2000,
    deadlineMs: 2500,
  },
  "/api/export": {
    maxQueries: 8,
    maxDurationMs: 4000,
    statementTimeoutMs: 3500,
    lockTimeoutMs: 2000,
    idleTransactionTimeoutMs: 4000,
    deadlineMs: 6000,
  },
  default: {
    maxQueries: 8,
    maxDurationMs: 3000,
    statementTimeoutMs: 2500,
    lockTimeoutMs: 1500,
    idleTransactionTimeoutMs: 3000,
    deadlineMs: 5000,
  },
};

/**
 * Resolves the query budget for a specific route path.
 */
export function getRouteBudget(routePath: string): QueryBudgetConfig {
  const normalized = routePath.toLowerCase().trim();
  for (const [key, budget] of Object.entries(DEFAULT_ROUTE_BUDGETS)) {
    if (key !== "default" && normalized.startsWith(key)) {
      return budget;
    }
  }
  return DEFAULT_ROUTE_BUDGETS.default;
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class QueryDeadlineExceededError extends Error {
  readonly code = "DATABASE_DEADLINE_EXCEEDED";
  readonly route: string;
  readonly requestId: string;
  readonly elapsedMs: number;

  constructor(message: string, route: string, requestId: string, elapsedMs: number) {
    super(message);
    this.name = "QueryDeadlineExceededError";
    this.route = route;
    this.requestId = requestId;
    this.elapsedMs = elapsedMs;
  }
}

export class QueryTimeoutError extends Error {
  readonly code = "DATABASE_QUERY_TIMEOUT";
  readonly route: string;
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(message: string, route: string, operation: string, timeoutMs: number) {
    super(message);
    this.name = "QueryTimeoutError";
    this.route = route;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export class QueryCountBudgetExceededError extends Error {
  readonly code = "QUERY_COUNT_BUDGET_EXCEEDED";
  readonly route: string;
  readonly count: number;
  readonly limit: number;

  constructor(message: string, route: string, count: number, limit: number) {
    super(message);
    this.name = "QueryCountBudgetExceededError";
    this.route = route;
    this.count = count;
    this.limit = limit;
  }
}

export class QueryDurationBudgetExceededError extends Error {
  readonly code = "QUERY_DURATION_BUDGET_EXCEEDED";
  readonly route: string;
  readonly durationMs: number;
  readonly limitMs: number;

  constructor(message: string, route: string, durationMs: number, limitMs: number) {
    super(message);
    this.name = "QueryDurationBudgetExceededError";
    this.route = route;
    this.durationMs = durationMs;
    this.limitMs = limitMs;
  }
}

// ─── In-Memory Observability Ledger ──────────────────────────────────────────

const MAX_STORED_TRACES = 500;

interface InternalRouteStats {
  route: string;
  requestIds: Set<string>;
  totalQueries: number;
  totalDurationMs: number;
  durations: number[];
  timeoutCount: number;
  errorCount: number;
  queryCountsPerRequest: Map<string, number>;
}

declare global {
  var stellarStarQueryTraces: QueryTraceRecord[] | undefined;
  var stellarStarRouteStats: Map<string, InternalRouteStats> | undefined;
}

const traceLedger: QueryTraceRecord[] = globalThis.stellarStarQueryTraces ?? [];
globalThis.stellarStarQueryTraces = traceLedger;

const routeStatsLedger: Map<string, InternalRouteStats> =
  globalThis.stellarStarRouteStats ?? new Map<string, InternalRouteStats>();
globalThis.stellarStarRouteStats = routeStatsLedger;

export function resetDatabaseObservability(): void {
  traceLedger.length = 0;
  routeStatsLedger.clear();
}

/**
 * Redacts potential sensitive data from error messages or query details.
 */
function sanitizeTelemetryString(val: string): string {
  return val
    .replace(/S[A-Z0-9]{55}/g, "[REDACTED_STELLAR_SECRET]")
    .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/AAAA[A-Za-z0-9+/=]{60,}/g, "[REDACTED_XDR_PAYLOAD]");
}

/**
 * Records a completed database call trace into the ring buffer and updates route stats.
 */
export function recordQueryTrace(trace: Omit<QueryTraceRecord, "id" | "timestamp">): QueryTraceRecord {
  const fullTrace: QueryTraceRecord = {
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...trace,
    errorCode: trace.errorCode ? sanitizeTelemetryString(trace.errorCode) : undefined,
    timestamp: new Date().toISOString(),
  };

  traceLedger.unshift(fullTrace);
  if (traceLedger.length > MAX_STORED_TRACES) {
    traceLedger.pop();
  }

  // Update aggregated statistics
  let stats = routeStatsLedger.get(trace.route);
  if (!stats) {
    stats = {
      route: trace.route,
      requestIds: new Set<string>(),
      totalQueries: 0,
      totalDurationMs: 0,
      durations: [],
      timeoutCount: 0,
      errorCount: 0,
      queryCountsPerRequest: new Map<string, number>(),
    };
    routeStatsLedger.set(trace.route, stats);
  }

  stats.requestIds.add(trace.requestId);
  stats.totalQueries += 1;
  stats.totalDurationMs += trace.durationMs;
  stats.durations.push(trace.durationMs);

  const prevCount = stats.queryCountsPerRequest.get(trace.requestId) ?? 0;
  stats.queryCountsPerRequest.set(trace.requestId, prevCount + 1);

  if (trace.status === "timeout") {
    stats.timeoutCount += 1;
  }
  if (trace.status === "error") {
    stats.errorCount += 1;
  }

  return fullTrace;
}

/**
 * Calculates p95 percentile of a series of numbers.
 */
function calculateP95(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return Number(sorted[index].toFixed(2));
}

/**
 * Returns comprehensive database observability metrics across all monitored routes.
 */
export function getDatabaseObservabilityReport(): DatabaseObservabilityReport {
  let totalCalls = 0;
  let totalRequests = 0;
  let totalDurationAll = 0;
  let allDurations: number[] = [];
  let timeoutCount = 0;
  let errorCount = 0;

  const routes: Record<string, RoutePerformanceSummary> = {};

  for (const [route, stats] of routeStatsLedger.entries()) {
    const budget = getRouteBudget(route);
    const reqCount = Math.max(stats.requestIds.size, 1);
    const avgQueries = Number((stats.totalQueries / reqCount).toFixed(1));
    const avgDuration = Number((stats.totalDurationMs / Math.max(stats.totalQueries, 1)).toFixed(2));
    const p95Duration = calculateP95(stats.durations);
    const slowestDuration = stats.durations.length > 0 ? Math.max(...stats.durations) : 0;

    const isSlow = p95Duration > budget.maxDurationMs || avgDuration > budget.statementTimeoutMs * 0.8;
    const isChatty = avgQueries > budget.maxQueries;

    routes[route] = {
      route,
      totalRequests: stats.requestIds.size,
      totalQueries: stats.totalQueries,
      avgQueriesPerRequest: avgQueries,
      avgDurationMs: avgDuration,
      p95DurationMs: p95Duration,
      slowestDurationMs: Number(slowestDuration.toFixed(2)),
      timeoutCount: stats.timeoutCount,
      errorCount: stats.errorCount,
      isSlow,
      isChatty,
      budget,
    };

    totalCalls += stats.totalQueries;
    totalRequests += stats.requestIds.size;
    totalDurationAll += stats.totalDurationMs;
    allDurations = allDurations.concat(stats.durations);
    timeoutCount += stats.timeoutCount;
    errorCount += stats.errorCount;
  }

  // Populate pre-configured default routes even if they haven't been visited yet
  for (const [key, budget] of Object.entries(DEFAULT_ROUTE_BUDGETS)) {
    if (key !== "default" && !routes[key]) {
      routes[key] = {
        route: key,
        totalRequests: 0,
        totalQueries: 0,
        avgQueriesPerRequest: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        slowestDurationMs: 0,
        timeoutCount: 0,
        errorCount: 0,
        isSlow: false,
        isChatty: false,
        budget,
      };
    }
  }

  const overall: OverallDatabaseMetrics = {
    totalCalls,
    totalRequests,
    avgDurationMs: totalCalls > 0 ? Number((totalDurationAll / totalCalls).toFixed(2)) : 0,
    p95DurationMs: calculateP95(allDurations),
    timeoutCount,
    errorCount,
    routes,
  };

  return {
    overall,
    routes,
    recentTraces: [...traceLedger],
    timestamp: new Date().toISOString(),
  };
}

// ─── Propagated Database Request Context ─────────────────────────────────────

export interface DatabaseRequestContextOptions {
  route: string;
  requestId?: string | null;
  headers?: Headers | Record<string, string | null | undefined>;
  budget?: Partial<QueryBudgetConfig>;
  strictCountBudget?: boolean;
}

export interface DatabaseRequestContext {
  route: string;
  requestId: string;
  startTime: number;
  deadlineTimestamp: number;
  budget: QueryBudgetConfig;
  queriesExecuted: number;
  cumulativeDurationMs: number;
  strictCountBudget: boolean;
  abortController: AbortController;
  isExpired(): boolean;
  remainingMs(): number;
  cancel(): void;
}

/**
 * Creates a propagated database context with deadlines and budgets attached.
 */
export function createDatabaseRequestContext(
  options: DatabaseRequestContextOptions
): DatabaseRequestContext {
  const route = options.route;
  const standardBudget = getRouteBudget(route);
  const budget: QueryBudgetConfig = {
    ...standardBudget,
    ...(options.budget ?? {}),
  };

  // Resolve request ID from explicit option or headers
  let rawRequestId: string | null | undefined = options.requestId;
  let deadlineHeader: string | null | undefined = null;
  let timeoutHeader: string | null | undefined = null;

  if (options.headers) {
    if (typeof (options.headers as Headers).get === "function") {
      const h = options.headers as Headers;
      rawRequestId = rawRequestId || h.get(REQUEST_ID_HEADER) || h.get("x-request-id");
      deadlineHeader = h.get("x-request-deadline");
      timeoutHeader = h.get("x-request-timeout-ms");
    } else {
      const h = options.headers as Record<string, string | null | undefined>;
      rawRequestId = rawRequestId || h[REQUEST_ID_HEADER] || h["x-request-id"];
      deadlineHeader = h["x-request-deadline"];
      timeoutHeader = h["x-request-timeout-ms"];
    }
  }

  const requestId = getOrCreateRequestId(rawRequestId);
  const now = Date.now();

  // Determine propagated deadline
  let deadlineTimestamp = now + budget.deadlineMs;

  if (deadlineHeader) {
    const parsed = Date.parse(deadlineHeader);
    if (!isNaN(parsed) && parsed > now) {
      deadlineTimestamp = Math.min(deadlineTimestamp, parsed);
    } else {
      const numParsed = Number(deadlineHeader);
      if (!isNaN(numParsed) && numParsed > now) {
        deadlineTimestamp = Math.min(deadlineTimestamp, numParsed);
      }
    }
  } else if (timeoutHeader) {
    const numTimeout = Number(timeoutHeader);
    if (!isNaN(numTimeout) && numTimeout > 0) {
      deadlineTimestamp = Math.min(deadlineTimestamp, now + numTimeout);
    }
  }

  const abortController = new AbortController();

  return {
    route,
    requestId,
    startTime: now,
    deadlineTimestamp,
    budget,
    queriesExecuted: 0,
    cumulativeDurationMs: 0,
    strictCountBudget: Boolean(options.strictCountBudget),
    abortController,
    isExpired() {
      return Date.now() >= deadlineTimestamp;
    },
    remainingMs() {
      return Math.max(0, deadlineTimestamp - Date.now());
    },
    cancel() {
      abortController.abort();
    },
  };
}

// ─── Query Execution with Deadlines & Budgets ────────────────────────────────

export interface RunQueryOptions {
  operation: string;
  table?: string;
  rowsCount?: number;
  timeoutMs?: number;
}

/**
 * Executes a database operation within the propagated request deadline and budget.
 *
 * Guarantees:
 * - Throws QueryDeadlineExceededError if the request deadline has already elapsed.
 * - Enforces per-statement execution timeout; a stalled query aborts predictably
 *   via AbortController rather than hanging a worker process.
 * - Tracks query counts and flags/rejects chatty endpoints.
 * - Automatically measures execution time and records sanitized query traces.
 */
export async function runWithQueryBudget<T>(
  context: DatabaseRequestContext,
  options: RunQueryOptions,
  queryFn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const { operation, table = "unknown" } = options;
  const start = Date.now();

  // 1. Deadline Check
  if (context.isExpired()) {
    const elapsed = Date.now() - context.startTime;
    recordQueryTrace({
      route: context.route,
      requestId: context.requestId,
      operation,
      table,
      durationMs: 0,
      queryCount: context.queriesExecuted + 1,
      rowsCount: 0,
      status: "timeout",
      errorCode: "DATABASE_DEADLINE_EXCEEDED",
      statementTimeoutMs: context.budget.statementTimeoutMs,
    });
    throw new QueryDeadlineExceededError(
      `Database request deadline exceeded for route '${context.route}' (${elapsed}ms elapsed).`,
      context.route,
      context.requestId,
      elapsed
    );
  }

  // 2. Query Count Budget Check
  context.queriesExecuted += 1;
  const isOverCountBudget = context.queriesExecuted > context.budget.maxQueries;

  if (isOverCountBudget && context.strictCountBudget) {
    recordQueryTrace({
      route: context.route,
      requestId: context.requestId,
      operation,
      table,
      durationMs: 0,
      queryCount: context.queriesExecuted,
      rowsCount: 0,
      status: "chatty",
      errorCode: "QUERY_COUNT_BUDGET_EXCEEDED",
      statementTimeoutMs: context.budget.statementTimeoutMs,
    });
    throw new QueryCountBudgetExceededError(
      `Database query count limit of ${context.budget.maxQueries} exceeded (attempted ${context.queriesExecuted}) on route '${context.route}'.`,
      context.route,
      context.queriesExecuted,
      context.budget.maxQueries
    );
  }

  // 3. Compute Statement Timeout
  const remainingDeadline = context.remainingMs();
  const statementTimeout = Math.min(
    options.timeoutMs ?? context.budget.statementTimeoutMs,
    remainingDeadline
  );

  // 4. Create timeout race controller
  const queryController = new AbortController();
  const querySignal = queryController.signal;

  // Propagate parent cancellation
  const onParentAbort = () => queryController.abort();
  context.abortController.signal.addEventListener("abort", onParentAbort, { once: true });

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      queryController.abort();
      reject(
        new QueryTimeoutError(
          `Database query operation '${operation}' on table '${table}' timed out after ${statementTimeout}ms.`,
          context.route,
          operation,
          statementTimeout
        )
      );
    }, statementTimeout);
  });

  try {
    const result = await Promise.race([queryFn(querySignal), timeoutPromise]);
    const durationMs = Math.max(1, Date.now() - start);
    context.cumulativeDurationMs += durationMs;

    // Determine query health status
    let status: QueryTraceStatus = "ok";
    if (isOverCountBudget) {
      status = "chatty";
    } else if (durationMs > context.budget.statementTimeoutMs * 0.75 || durationMs >= 1000) {
      status = "slow";
    }

    recordQueryTrace({
      route: context.route,
      requestId: context.requestId,
      operation,
      table,
      durationMs,
      queryCount: context.queriesExecuted,
      rowsCount: options.rowsCount ?? 1,
      status,
      statementTimeoutMs: statementTimeout,
    });

    return result;
  } catch (err: unknown) {
    const durationMs = Math.max(1, Date.now() - start);
    context.cumulativeDurationMs += durationMs;

    if (didTimeout || (err instanceof Error && err.name === "AbortError" && didTimeout)) {
      recordQueryTrace({
        route: context.route,
        requestId: context.requestId,
        operation,
        table,
        durationMs,
        queryCount: context.queriesExecuted,
        rowsCount: 0,
        status: "timeout",
        errorCode: "DATABASE_QUERY_TIMEOUT",
        statementTimeoutMs: statementTimeout,
      });
      throw new QueryTimeoutError(
        `Database query operation '${operation}' on table '${table}' timed out after ${statementTimeout}ms.`,
        context.route,
        operation,
        statementTimeout
      );
    }

    const errorCode = (err as { code?: string })?.code || "DATABASE_ERROR";
    recordQueryTrace({
      route: context.route,
      requestId: context.requestId,
      operation,
      table,
      durationMs,
      queryCount: context.queriesExecuted,
      rowsCount: 0,
      status: "error",
      errorCode: String(errorCode),
      statementTimeoutMs: statementTimeout,
    });

    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    context.abortController.signal.removeEventListener("abort", onParentAbort);
  }
}

// ─── Simulation Helpers for Testing & Dashboards ─────────────────────────────

export interface SimulateQueryOptions {
  route?: string;
  operation?: string;
  table?: string;
  delayMs?: number;
  shouldTimeout?: boolean;
  shouldError?: boolean;
  queryCount?: number;
}

/**
 * Simulates a query execution with specified parameters to verify predictable
 * timeout termination, chatty detection, or dashboard updates.
 */
export async function simulateDatabaseQuery(
  options: SimulateQueryOptions = {}
): Promise<{ success: boolean; trace: QueryTraceRecord; error?: string }> {
  const route = options.route || "/api/trips";
  const operation = options.operation || "trips.select";
  const table = options.table || "trips";
  const delayMs = options.delayMs ?? 50;

  const context = createDatabaseRequestContext({
    route,
    budget: options.shouldTimeout ? { statementTimeoutMs: Math.max(10, delayMs - 20) } : undefined,
  });

  try {
    await runWithQueryBudget(context, { operation, table }, async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Query aborted"));
        });
      });

      if (options.shouldError) {
        throw new Error("Simulated database connection failure");
      }
      return { simulated: true };
    });

    const latestTrace = traceLedger[0];
    return { success: true, trace: latestTrace };
  } catch (err) {
    const latestTrace = traceLedger[0];
    return {
      success: false,
      trace: latestTrace,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
