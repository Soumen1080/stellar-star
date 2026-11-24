/**
 * __tests__/auth/authorizationMatrixExecution.test.ts
 *
 * Issue #456: Execution test of protected endpoints against anonymous,
 * wrong-wallet, expired, and authorized tokens.
 */

import { NextRequest } from "next/server";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import { POST as createInviteRoute } from "@/app/api/invitations/create/route";
import { POST as claimInviteRoute } from "@/app/api/invitations/claim/route";
import { POST as revokeInviteRoute } from "@/app/api/invitations/revoke/route";
import { POST as attestSettlementRoute } from "@/app/api/settlement/attest/route";
import { POST as outboxWorkerRoute } from "@/app/api/outbox/worker/route";
import { POST as idempotencyCleanupRoute } from "@/app/api/idempotency/cleanup/route";
import { GET as getTripsV1Route } from "@/app/api/v1/trips/route";
import { checkStaffAuthorization } from "@/lib/support/service";
import { generateScopedToken } from "@/lib/api/tokens";

process.env.SUPABASE_JWT_SECRET = "test-secret-key-for-auth-contract-tests-32-chars";
process.env.CRON_SECRET = "test-cron-secret-1234567890";
process.env.SUPPORT_STAFF_SECRET = "test-support-secret-32-chars-long";
process.env.SUPPORT_STAFF_WALLETS = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
process.env.NODE_ENV = "production";

const WALLET_PRIMARY = "GA2W6L4XWNX2Z2O7MFR32CQ7E3N4A3B4C5D6E7F8G9H0J1K2L3M4N5P6";
const WALLET_UNRELATED = "GCAX6Y4Z2ABCDEF1234567890ABCDEF1234567890ABCDEF123456789";

describe("Protected Endpoint Matrix Execution (#456)", () => {
  const validToken = signWalletSession(WALLET_PRIMARY, WALLET_PRIMARY, 3600);
  const expiredToken = signWalletSession(WALLET_PRIMARY, WALLET_PRIMARY, -3600);
  const malformedToken = "invalid.malformed.jwt.token";

  afterAll(() => {
    process.env.NODE_ENV = "test";
  });

  describe("Wallet Protected Routes", () => {
    describe("POST /api/invitations/create", () => {
      it("rejects anonymous callers with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripId: "trip-1" }),
        });
        const res = await createInviteRoute(req);
        expect(res.status).toBe(401);
      });

      it("rejects expired token with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${expiredToken}`,
          },
          body: JSON.stringify({ tripId: "trip-1" }),
        });
        const res = await createInviteRoute(req);
        expect(res.status).toBe(401);
      });

      it("rejects malformed token with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${malformedToken}`,
          },
          body: JSON.stringify({ tripId: "trip-1" }),
        });
        const res = await createInviteRoute(req);
        expect(res.status).toBe(401);
      });
    });

    describe("POST /api/settlement/attest", () => {
      it("rejects anonymous caller with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/settlement/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intentId: "intent-1" }),
        });
        const res = await attestSettlementRoute(req);
        expect(res.status).toBe(401);
      });
    });
  });

  describe("Staff Protected Contracts", () => {
    it("rejects anonymous callers with not authorized", () => {
      const req = new NextRequest("http://localhost:3000/api/support/lookup", {
        method: "GET",
      });
      const auth = checkStaffAuthorization(req);
      expect(auth.authorized).toBe(false);
    });

    it("rejects regular non-staff wallet sessions", () => {
      const req = new NextRequest("http://localhost:3000/api/support/lookup", {
        method: "GET",
        headers: { Authorization: `Bearer ${validToken}` },
      });
      const auth = checkStaffAuthorization(req);
      expect(auth.authorized).toBe(false);
    });

    it("accepts authorized staff secret credentials", () => {
      const req = new NextRequest("http://localhost:3000/api/support/lookup", {
        method: "GET",
        headers: { "x-staff-secret": "test-support-secret-32-chars-long" },
      });
      const auth = checkStaffAuthorization(req);
      expect(auth.authorized).toBe(true);
    });
  });

  describe("Cron Protected Routes", () => {
    describe("POST /api/outbox/worker", () => {
      it("rejects anonymous callers with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/outbox/worker", {
          method: "POST",
        });
        const res = await outboxWorkerRoute(req);
        expect(res.status).toBe(401);
      });

      it("rejects wallet bearer token with 401 (requires CRON_SECRET)", async () => {
        const req = new NextRequest("http://localhost:3000/api/outbox/worker", {
          method: "POST",
          headers: { Authorization: `Bearer ${validToken}` },
        });
        const res = await outboxWorkerRoute(req);
        expect(res.status).toBe(401);
      });

      it("accepts valid CRON_SECRET bearer", async () => {
        const req = new NextRequest("http://localhost:3000/api/outbox/worker", {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
        });
        const res = await outboxWorkerRoute(req);
        expect([200, 202, 503]).toContain(res.status);
      });
    });
  });

  describe("Developer Scoped API Token Routes", () => {
    describe("GET /api/v1/trips", () => {
      it("rejects anonymous caller without token with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/v1/trips", {
          method: "GET",
        });
        const res = await getTripsV1Route(req);
        expect(res.status).toBe(401);
      });

      it("accepts valid scoped developer API token", async () => {
        const { token } = generateScopedToken({
          walletAddress: WALLET_PRIMARY,
          name: "test-token",
          scopes: ["trips:read"],
        });
        const req = new NextRequest("http://localhost:3000/api/v1/trips", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const res = await getTripsV1Route(req);
        // Authentication succeeds (not 401/403); downstream mock DB may return 200/201 or 503 service unavailable
        expect([200, 201, 503]).toContain(res.status);
      });
    });
  });
});
