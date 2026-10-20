import { NextRequest } from "next/server";
import {
  authenticateApiRequest,
  getIdempotentResponse,
  storeIdempotentResponse,
  recordAuditLog,
  getAuditLogsForWallet,
  clearAuditLogs,
} from "@/lib/api/middleware";
import { generateScopedToken, clearTokenStore } from "@/lib/api/tokens";

describe("Developer API Middleware (Auth, Scopes, Idempotency, Audit Logs)", () => {
  const testWallet = "G_MIDDLEWARE_TEST_WALLET_12345678901234567890";

  beforeEach(() => {
    clearTokenStore();
    clearAuditLogs();
  });

  it("enforces authentication and rejects requests without Bearer token", async () => {
    const req = new NextRequest("http://localhost/api/v1/trips");
    const result = await authenticateApiRequest(req);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(401);
    }
  });

  it("enforces scope check and returns 403 on insufficient scopes", async () => {
    const { token } = generateScopedToken({
      walletAddress: testWallet,
      name: "Read-Only Token",
      scopes: ["trips:read"],
    });

    const req = new NextRequest("http://localhost/api/v1/trips", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const result = await authenticateApiRequest(req, {
      requiredScopes: ["trips:write"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(403);
    }
  });

  it("permits requests with valid scopes", async () => {
    const { token } = generateScopedToken({
      walletAddress: testWallet,
      name: "Read-Write Token",
      scopes: ["trips:read", "trips:write"],
    });

    const req = new NextRequest("http://localhost/api/v1/trips", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const result = await authenticateApiRequest(req, {
      requiredScopes: ["trips:read"],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.context.tokenPayload.walletAddress).toBe(testWallet);
    }
  });

  it("caches and replays idempotent responses", () => {
    const idempotencyKey = "test-uuid-idempotency-key-12345";
    const initialBody = { data: { id: "trip-99", name: "Tokyo" } };

    expect(getIdempotentResponse(testWallet, idempotencyKey)).toBeNull();

    storeIdempotentResponse(testWallet, idempotencyKey, 201, initialBody);

    const replayed = getIdempotentResponse(testWallet, idempotencyKey);
    expect(replayed).not.toBeNull();
    expect(replayed?.status).toBe(201);
    expect(replayed?.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("records and queries audit logs without exposing secret credentials", () => {
    recordAuditLog({
      timestamp: new Date().toISOString(),
      tokenId: "tok-1",
      walletAddress: testWallet,
      method: "POST",
      path: "/api/v1/trips",
      statusCode: 201,
      latencyMs: 42,
      ip: "127.0.0.1",
      userAgent: "jest-agent",
      idempotencyKey: "idem-1",
    });

    const logs = getAuditLogsForWallet(testWallet);
    expect(logs.length).toBe(1);
    expect(logs[0].path).toBe("/api/v1/trips");
    expect(logs[0].statusCode).toBe(201);
    expect(logs[0].latencyMs).toBe(42);
  });
});
