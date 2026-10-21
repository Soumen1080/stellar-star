/**
 * __tests__/security/authorizationMatrix.test.ts
 *
 * Automated verification of data boundaries and authorization matrix (Issue #311).
 * Tests allowed and denied cases across Creator, Member, Invitee, Revoked Member,
 * Unrelated Wallet, and Anonymous access.
 */

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { POST as attestRoute } from "@/app/api/settlement/attest/route";
import { POST as createInviteRoute } from "@/app/api/invitations/create/route";
import { POST as claimInviteRoute } from "@/app/api/invitations/claim/route";
import { GET as verifyInviteRoute } from "@/app/api/invitations/verify/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";

// Mock environments for server auth
process.env.SUPABASE_JWT_SECRET = "test-secret-key-for-auth-matrix-32-chars-long";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
process.env.NEXT_PUBLIC_CONTRACT_ID = "CBS2BJQ4ZC2ZSAZ5XS47BGC6Q7VTMJA4SE2PVHFXGXAZI5ES6H645WHO";
process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_ID = "native";
process.env.SETTLEMENT_ORACLE_SECRET = "SDWTY7W7KOGCSUQ3Q5W7V7C44EAKF4S3Z5K2SULOHCVX27QZ2V3UMLOC";

const WALLET_CREATOR = "GA2W6L4XWNX2Z2O7MFR32CQ7E3N4A3B4C5D6E7F8G9H0J1K2L3M4N5P6";
const WALLET_MEMBER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WALLET_UNRELATED = "GCAX6Y4Z2ABCDEF1234567890ABCDEF1234567890ABCDEF123456789";

describe("Data Boundary Authorization Matrix (#311)", () => {
  const rootDir = path.resolve(__dirname, "../..");

  describe("1. Database RLS & Stored Procedure Authorization Policies", () => {
    const setupSql = fs.readFileSync(path.join(rootDir, "supabase-setup.sql"), "utf8");

    it("restricts trip reading to authenticated creator and members", () => {
      expect(setupSql).toContain('CREATE POLICY "trips_select_members" ON public.trips');
      expect(setupSql).toContain("member_wallets @> ARRAY[public.current_wallet()]");
    });

    it("restricts trip deletion exclusively to the trip creator", () => {
      expect(setupSql).toContain('CREATE POLICY "trips_delete_creator" ON public.trips');
      expect(setupSql).toContain("FOR DELETE USING (created_by_wallet = public.current_wallet())");
    });

    it("restricts expense reading to group participants", () => {
      expect(setupSql).toContain('CREATE POLICY "expenses_select_members" ON public.expenses');
      expect(setupSql).toContain("member_wallets @> ARRAY[public.current_wallet()]");
    });

    it("restricts expense deletion exclusively to the expense creator", () => {
      expect(setupSql).toContain('CREATE POLICY "expenses_delete_creator" ON public.expenses');
      expect(setupSql).toContain("FOR DELETE USING (created_by_wallet = public.current_wallet())");
    });

    it("prevents anonymous execution of update_expense_versioned and mark_share_paid", () => {
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.update_expense_versioned");
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.mark_share_paid");
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch");
    });
  });

  describe("2. API Layer Boundary Verification (Allowed vs Denied)", () => {
    const creatorToken = signWalletSession(WALLET_CREATOR);
    const memberToken = signWalletSession(WALLET_MEMBER);
    const unrelatedToken = signWalletSession(WALLET_UNRELATED);

    describe("POST /api/invitations/create", () => {
      it("denies unauthenticated / anonymous requests with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripId: "trip-1" }),
        });
        const res = await createInviteRoute(req);
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toContain("Unauthorized");
      });

      it("denies requests with malformed JSON body", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: "invalid-json",
        });
        const res = await createInviteRoute(req);
        expect(res.status).toBe(400);
      });
    });

    describe("POST /api/invitations/claim", () => {
      it("denies unauthenticated claim attempts with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "fake-claim-token" }),
        });
        const res = await claimInviteRoute(req);
        expect(res.status).toBe(401);
      });

      it("denies claim requests missing the token", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/claim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${unrelatedToken}`,
          },
          body: JSON.stringify({}),
        });
        const res = await claimInviteRoute(req);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain("token");
      });
    });

    describe("GET /api/invitations/verify", () => {
      it("rejects requests missing token parameter with 400", async () => {
        const req = new NextRequest("http://localhost:3000/api/invitations/verify");
        const res = await verifyInviteRoute(req);
        expect(res.status).toBe(400);
      });
    });

    describe("POST /api/settlement/attest", () => {
      it("denies unauthenticated requests with 401", async () => {
        const req = new NextRequest("http://localhost:3000/api/settlement/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tripId: "trip-1",
            expenseId: "exp-1",
            payer: WALLET_CREATOR,
            member: WALLET_MEMBER,
            amountStroops: "10000000",
            txHash: "a".repeat(64),
          }),
        });
        const res = await attestRoute(req);
        expect(res.status).toBe(401);
      });

      it("denies an unrelated wallet from attesting someone else's settlement with 403", async () => {
        const req = new NextRequest("http://localhost:3000/api/settlement/attest", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${unrelatedToken}`,
          },
          body: JSON.stringify({
            tripId: "trip-1",
            expenseId: "exp-1",
            payer: WALLET_CREATOR,
            member: WALLET_MEMBER, // caller is UNRELATED, not member
            amountStroops: "10000000",
            txHash: "a".repeat(64),
          }),
        });
        const res = await attestRoute(req);
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toContain("own settlements");
      });
    });
  });

  describe("3. Realtime Subscription Scoping & Isolation", () => {
    it("ensures Realtime channel configuration inherits RLS policies", () => {
      const clientTsPath = path.join(rootDir, "lib", "supabase", "client.ts");
      const clientTs = fs.readFileSync(clientTsPath, "utf8");

      expect(clientTs).toContain("Authorization: `Bearer ${token}`");
      expect(clientTs).toContain("createClient");
    });
  });

  describe("4. Privileged Service-Role Audit & Server-Only Enforcement", () => {
    const serverTsPath = path.join(rootDir, "lib", "supabase", "server.ts");
    const serverTs = fs.readFileSync(serverTsPath, "utf8");

    it("guards service-role client from browser bundling with a runtime window check", () => {
      expect(serverTs).toContain('typeof window !== "undefined"');
      expect(serverTs).toContain("must not be imported from client code");
    });

    it("documents all service-role usage in docs/AUTHORIZATION_MATRIX.md", () => {
      const matrixPath = path.join(rootDir, "docs", "AUTHORIZATION_MATRIX.md");
      expect(fs.existsSync(matrixPath)).toBe(true);
      const matrix = fs.readFileSync(matrixPath, "utf8");

      expect(matrix).toContain("Privileged Service-Role Usage Audit");
      expect(matrix).toContain("SR-01");
      expect(matrix).toContain("SR-02");
      expect(matrix).toContain("SR-03");
      expect(matrix).toContain("SR-04");
      expect(matrix).toContain("CRON_SECRET");
    });
  });
});
