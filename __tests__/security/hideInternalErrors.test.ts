/**
 * __tests__/security/hideInternalErrors.test.ts
 *
 * Issue #420: Hide internal errors from API clients.
 *
 * Verifies:
 *  1. Fault-injection: Simulated database failures (missing relations, missing columns,
 *     syntax errors, timeouts, connection drops, RLS blocks) reveal no internal
 *     table names, column names, schema structures, or database connection strings.
 *  2. Provider fault-injection: Upstream Stellar Horizon/Soroban 5xx faults, timeouts,
 *     circuit breaker trips, and bulkhead saturation map to stable codes and safe messages.
 *  3. Secret & token redaction: Stellar secret seeds (S...), JWTs, passwords, and stack traces
 *     are never disclosed in client responses.
 *  4. Telemetry correlation: Detailed unredacted errors are sent to reportError correlated
 *     with the support requestId.
 *  5. Envelope formats: Both the standard flat envelope ({ error, code, requestId }) and
 *     the developer v1 envelope ({ error: { code, message, status, requestId } }) are
 *     supported and include X-Request-Id and Cache-Control headers.
 *  6. Static audit: Scans all route handlers in app/api to assert no 5xx catch block leaks
 *     raw error.message.
 */

import fs from "fs";
import path from "path";
import {
  toPublicErrorResponse,
  classifyApiError,
  containsSensitiveData,
  PublicApiError,
  INTERNAL_ERROR_CODE,
  DATABASE_ERROR_CODE,
  DATABASE_TIMEOUT_CODE,
  DATABASE_UNAVAILABLE_CODE,
  ACCESS_DENIED_CODE,
  RESOURCE_CONFLICT_CODE,
  PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_TIMEOUT_CODE,
} from "@/lib/api/errors";
import { reportError } from "@/lib/observability/reportError";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";

jest.mock("@/lib/observability/reportError", () => ({
  reportError: jest.fn(),
}));

const mockedReportError = jest.mocked(reportError);

describe("Issue #420: Hide internal errors from API clients", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Sensitive data detection (containsSensitiveData)", () => {
    it("detects Stellar secret keys (S... 56 chars)", () => {
      const secretKey = "SBAMZ34DDFXN6265KMYMUGZJEUQZGFY6JOUC3TWR7RZZN5U6OOU7U24X";
      expect(containsSensitiveData(`Failed with key ${secretKey}`)).toBe(true);
    });

    it("detects JWT session tokens", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozGz6b_k_";
      expect(containsSensitiveData(`Bearer ${jwt}`)).toBe(true);
    });

    it("detects database relation leaks", () => {
      expect(containsSensitiveData('relation "trips" does not exist')).toBe(true);
      expect(containsSensitiveData("relation 'expenses' does not exist")).toBe(true);
    });

    it("detects database column leaks", () => {
      expect(containsSensitiveData('column "secret_token" does not exist')).toBe(true);
      expect(containsSensitiveData('column "wallet" of relation "trips" does not exist')).toBe(true);
    });

    it("detects database connection strings and passwords", () => {
      expect(containsSensitiveData("postgres://postgres:mysecretpass@db.local:5432/main")).toBe(true);
      expect(containsSensitiveData("password authentication failed for user postgres")).toBe(true);
    });

    it("detects internal network addresses and connection drops", () => {
      expect(containsSensitiveData("connect ECONNREFUSED 127.0.0.1:5432")).toBe(true);
      expect(containsSensitiveData("connect ETIMEDOUT 10.0.1.42:5432")).toBe(true);
    });

    it("detects stack trace lines", () => {
      expect(containsSensitiveData("Error: boom\n    at Query.run (/app/node_modules/pg/lib/query.js:12:3)")).toBe(true);
    });

    it("returns false for safe public domain messages", () => {
      expect(containsSensitiveData("Expense not found.")).toBe(false);
      expect(containsSensitiveData("A valid audit reason is required.")).toBe(false);
      expect(containsSensitiveData("Unauthorized: Sign in with your wallet.")).toBe(false);
    });
  });

  describe("Fault-Injection: Database Failures", () => {
    it("hides missing relation details and returns DATABASE_UNAVAILABLE (503)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "PGRST205",
        message: 'Could not find the table "secret_ledger" in the schema cache',
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(503);
      expect(classified.code).toBe(DATABASE_UNAVAILABLE_CODE);
      expect(classified.message).not.toContain("secret_ledger");
      expect(classified.message).not.toContain("schema cache");
      expect(classified.message).toBe("Database service is temporarily unavailable.");
    });

    it("hides missing column details and returns DATABASE_ERROR (500)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "42703",
        message: 'column "internal_signing_key" does not exist',
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(500);
      expect(classified.code).toBe(DATABASE_ERROR_CODE);
      expect(classified.message).not.toContain("internal_signing_key");
      expect(classified.message).not.toContain("column");
      expect(classified.message).toBe("A database error occurred while processing your request.");
    });

    it("maps statement timeouts (57014) to DATABASE_TIMEOUT (504)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "57014",
        message: "canceling statement due to statement timeout",
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(504);
      expect(classified.code).toBe(DATABASE_TIMEOUT_CODE);
      expect(classified.message).toBe("Database operation timed out. Please retry with a narrower query.");
    });

    it("maps database lock timeouts (55P03) to DATABASE_TIMEOUT (504)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "55P03",
        message: "canceling statement due to lock timeout",
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(504);
      expect(classified.code).toBe(DATABASE_TIMEOUT_CODE);
    });

    it("maps connection refused to DATABASE_UNAVAILABLE (503)", () => {
      const dbErr = new Error("connect ECONNREFUSED 127.0.0.1:5432");

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(503);
      expect(classified.code).toBe(DATABASE_UNAVAILABLE_CODE);
      expect(classified.message).not.toContain("127.0.0.1");
    });

    it("maps permission denied (42501) to ACCESS_DENIED (403)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "42501",
        message: 'permission denied for table "private_audit"',
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(403);
      expect(classified.code).toBe(ACCESS_DENIED_CODE);
      expect(classified.message).not.toContain("private_audit");
      expect(classified.message).toBe("You do not have permission to perform this action.");
    });

    it("maps unique violation (23505) to RESOURCE_CONFLICT (409)", () => {
      const dbErr = {
        name: "DatabaseError",
        code: "23505",
        message: 'duplicate key value violates unique constraint "trips_pkey"',
      };

      const classified = classifyApiError(dbErr);
      expect(classified.status).toBe(409);
      expect(classified.code).toBe(RESOURCE_CONFLICT_CODE);
      expect(classified.message).not.toContain("trips_pkey");
      expect(classified.message).toBe("A conflict occurred with an existing record.");
    });
  });

  describe("Fault-Injection: Provider & Stellar Failures", () => {
    it("maps Horizon 503 errors to PROVIDER_UNAVAILABLE (503)", () => {
      const err = new Error("Upstream horizon RPC returned 503 Bad Gateway: upstream connect error");

      const classified = classifyApiError(err);
      expect(classified.status).toBe(503);
      expect(classified.code).toBe(PROVIDER_UNAVAILABLE_CODE);
      expect(classified.message).toBe("An upstream service is temporarily unavailable. Please retry shortly.");
    });

    it("maps Stellar circuit breaker open to STELLAR_CIRCUIT_OPEN (503) with Retry-After", () => {
      const circuitErr = {
        code: "STELLAR_CIRCUIT_OPEN",
        message: "Circuit breaker is open for Horizon RPC (5 consecutive failures)",
        retryAfterSeconds: 30,
      };

      const classified = classifyApiError(circuitErr);
      expect(classified.status).toBe(503);
      expect(classified.code).toBe("STELLAR_CIRCUIT_OPEN");
      expect(classified.headers?.["Retry-After"]).toBe("30");
      expect(classified.message).toBe("Upstream Stellar service is temporarily unavailable. Please retry shortly.");
    });

    it("maps Stellar bulkhead rejection to STELLAR_BULKHEAD_REJECTED (503)", () => {
      const bulkheadErr = {
        code: "STELLAR_BULKHEAD_REJECTED",
        message: "Bulkhead limit of 20 concurrent operations exceeded",
      };

      const classified = classifyApiError(bulkheadErr);
      expect(classified.status).toBe(503);
      expect(classified.code).toBe("STELLAR_BULKHEAD_REJECTED");
      expect(classified.message).toBe("Service concurrency limit reached. Please try again shortly.");
    });

    it("maps Stellar timeout to PROVIDER_TIMEOUT (504)", () => {
      const timeoutErr = {
        code: "STELLAR_TIMEOUT",
        message: "Stellar Horizon operation timed out after 10000ms",
      };

      const classified = classifyApiError(timeoutErr);
      expect(classified.status).toBe(504);
      expect(classified.code).toBe(PROVIDER_TIMEOUT_CODE);
      expect(classified.message).toBe("Upstream Stellar provider timed out. Please try again.");
    });
  });

  describe("Response formatting and telemetry logging (toPublicErrorResponse)", () => {
    it("returns standard flat envelope with requestId, code, and safe error message", async () => {
      const secret = "SBAMZ34DDFXN6265KMYMUGZJEUQZGFY6JOUC3TWR7RZZN5U6OOU7U24X";
      const err = new Error(`Failed to decrypt using secret seed ${secret} at line 42`);

      const res = toPublicErrorResponse(err, {
        requestId: "req_test_12345",
        route: "/api/test",
        method: "POST",
      });

      expect(res.status).toBe(500);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req_test_12345");

      const body = await res.json();
      expect(body).toEqual({
        error: "An unexpected internal error occurred.",
        code: INTERNAL_ERROR_CODE,
        requestId: "req_test_12345",
      });
      expect(JSON.stringify(body)).not.toContain(secret);

      // Asserts detailed error telemetry was dispatched correlated by requestId
      expect(mockedReportError).toHaveBeenCalledWith(
        "api.error:/api/test",
        err,
        expect.objectContaining({
          route: "/api/test",
          method: "POST",
          code: INTERNAL_ERROR_CODE,
          status: 500,
        }),
        "error",
        "req_test_12345"
      );
    });

    it("returns developer v1 envelope when format: 'v1' is specified", async () => {
      const dbErr = {
        name: "DatabaseError",
        code: "42P01",
        message: 'relation "developer_api_tokens" does not exist',
      };

      const res = toPublicErrorResponse(dbErr, {
        format: "v1",
        requestId: "req_v1_999",
        route: "/api/v1/trips",
        method: "GET",
      });

      expect(res.status).toBe(500);
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe("req_v1_999");

      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: DATABASE_ERROR_CODE,
          message: "A database error occurred while processing your request.",
          status: 500,
          requestId: "req_v1_999",
        },
      });
      expect(JSON.stringify(body)).not.toContain("developer_api_tokens");
    });

    it("generates a new requestId if none is provided", async () => {
      const res = toPublicErrorResponse(new Error("unexpected crash"));
      const body = await res.json();
      expect(body.requestId).toMatch(/^req_[a-zA-Z0-9_-]+$/);
      expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.requestId);
    });

    it("does not crash if telemetry reporting fails", async () => {
      mockedReportError.mockImplementationOnce(() => {
        throw new Error("telemetry service dead");
      });

      const res = toPublicErrorResponse(new Error("internal error"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe(INTERNAL_ERROR_CODE);
    });
  });

  describe("PublicApiError domain class", () => {
    it("allows safe domain errors to pass through with explicit code and status", async () => {
      const domainErr = new PublicApiError("Invalid coupon code provided.", "INVALID_COUPON", 400);

      const res = toPublicErrorResponse(domainErr, { requestId: "req_coupon_1" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({
        error: "Invalid coupon code provided.",
        code: "INVALID_COUPON",
        requestId: "req_coupon_1",
      });
    });

    it("sanitizes PublicApiError if sensitive data is accidentally included", async () => {
      const secretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoxfQ.mock";
      const domainErr = new PublicApiError(`Invalid credentials: token=${secretToken}`, "AUTH_ERROR", 401);

      const res = toPublicErrorResponse(domainErr, { requestId: "req_sanitized" });
      const body = await res.json();
      expect(body.error).toBe("An unexpected internal error occurred.");
      expect(JSON.stringify(body)).not.toContain(secretToken);
    });
  });

  describe("Static Route Security Audit", () => {
    it("ensures no route in app/api leaks raw error.message in 5xx responses", () => {
      const appApiDir = path.resolve(__dirname, "../../app/api");

      function findRouteFiles(dir: string): string[] {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        for (const file of list) {
          if (file.startsWith(".")) continue;
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            results = results.concat(findRouteFiles(fullPath));
          } else if (file === "route.ts" || file === "route.js") {
            results.push(fullPath);
          }
        }
        return results;
      }

      const routeFiles = findRouteFiles(appApiDir);
      expect(routeFiles.length).toBeGreaterThan(15);

      const violations: Array<{ file: string; line: number; snippet: string }> = [];

      // Regex searching for unsafe patterns returning err.message with status 500
      const unsafePatterns = [
        /return\s+NextResponse\.json\(\s*\{\s*error:\s*(?:err|error|e)\.message\s*\}\s*,\s*\{\s*status:\s*500/g,
        /return\s+NextResponse\.json\(\s*\{\s*error:\s*(?:err|error|e)\s+instanceof\s+Error\s*\?\s*(?:err|error|e)\.message\s*:\s*["'][^"']*["']\s*\}\s*,\s*\{\s*status:\s*500/g,
      ];

      for (const filePath of routeFiles) {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Check for err instanceof Error ? err.message returned with status 500 in consecutive lines
          const nextLines = lines.slice(i, i + 4).join(" ");
          for (const pattern of unsafePatterns) {
            if (pattern.test(nextLines)) {
              violations.push({
                file: path.relative(path.resolve(__dirname, "../.."), filePath),
                line: i + 1,
                snippet: line.trim(),
              });
            }
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
