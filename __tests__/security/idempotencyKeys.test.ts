/**
 * __tests__/security/idempotencyKeys.test.ts
 *
 * Test suite for Issue #312: Introduce idempotency keys for money-adjacent mutations.
 *
 * Verifies:
 * 1. Extraction of idempotency key from headers and request bodies.
 * 2. Deterministic request fingerprinting tied to authenticated wallet and payload.
 * 3. Exact replay of cached results on retry without re-executing mutations.
 * 4. Conflict detection (409) when reusing key with mismatched payload.
 * 5. Database schema migration with UNIQUE(wallet_address, key) and RLS.
 */

import fs from "fs";
import path from "path";
import {
  extractIdempotencyKey,
  computeRequestFingerprint,
  withIdempotency,
  IdempotencyConflictError,
  IdempotencyLockedError,
} from "@/lib/idempotency/store";

describe("Idempotency Keys for Money-Adjacent Mutations (#312)", () => {
  const TEST_WALLET = "GBZXN7PIRZGNMHGA728RGRTDGBLRYSPI7IRNVAXQIUI46G2XST4KSDUP";

  describe("extractIdempotencyKey", () => {
    it("extracts idempotency key from standard Idempotency-Key header", () => {
      const mockReq = {
        headers: new Headers({ "idempotency-key": "req-idem-12345" }),
      } as any;
      expect(extractIdempotencyKey(mockReq)).toBe("req-idem-12345");
    });

    it("extracts idempotency key from X-Idempotency-Key header", () => {
      const mockReq = {
        headers: new Headers({ "x-idempotency-key": "alt-key-67890" }),
      } as any;
      expect(extractIdempotencyKey(mockReq)).toBe("alt-key-67890");
    });

    it("falls back to body.idempotencyKey if header is omitted", () => {
      const mockReq = {
        headers: new Headers(),
      } as any;
      const body = { title: "Lunch", amount: "50", idempotencyKey: "body-key-abc" };
      expect(extractIdempotencyKey(mockReq, body)).toBe("body-key-abc");
    });

    it("returns null if no idempotency key is present", () => {
      const mockReq = {
        headers: new Headers(),
      } as any;
      expect(extractIdempotencyKey(mockReq, {})).toBeNull();
    });
  });

  describe("computeRequestFingerprint", () => {
    it("generates deterministic SHA-256 fingerprint regardless of key ordering", () => {
      const payload1 = { title: "Dinner", amount: "100.00", currency: "XLM" };
      const payload2 = { currency: "XLM", amount: "100.00", title: "Dinner" };

      const fp1 = computeRequestFingerprint(TEST_WALLET, "/api/expenses", payload1);
      const fp2 = computeRequestFingerprint(TEST_WALLET, "/api/expenses", payload2);

      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates different fingerprints for different endpoints or payloads", () => {
      const payload = { amount: "100.00" };
      const fpA = computeRequestFingerprint(TEST_WALLET, "/api/expenses", payload);
      const fpB = computeRequestFingerprint(TEST_WALLET, "/api/trips", payload);
      const fpC = computeRequestFingerprint("GDIFFERENTWALLET...", "/api/expenses", payload);

      expect(fpA).not.toBe(fpB);
      expect(fpA).not.toBe(fpC);
    });
  });

  describe("withIdempotency Execution and Replay", () => {
    it("executes mutation on first call and replays cached result on duplicate call", async () => {
      let callCount = 0;
      const key = `test-key-${Date.now()}-replay`;
      const payload = { tripId: "trip-alpha", amount: "250.00" };

      const executeFn = async () => {
        callCount++;
        return { data: { id: "record-1", callCount }, status: 201 };
      };

      // First call
      const res1 = await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: "/api/expenses",
        payload,
        execute: executeFn,
      });

      expect(callCount).toBe(1);
      expect(res1.replayed).toBe(false);
      expect(res1.status).toBe(201);
      expect(res1.data.id).toBe("record-1");

      // Duplicate call (network retry)
      const res2 = await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: "/api/expenses",
        payload,
        execute: executeFn,
      });

      // Mutation must NOT execute again
      expect(callCount).toBe(1);
      expect(res2.replayed).toBe(true);
      expect(res2.status).toBe(201);
      expect(res2.data.id).toBe("record-1");
    });

    it("rejects conflicting reuse of idempotency key with different payload with 409 error", async () => {
      const key = `test-key-${Date.now()}-conflict`;
      const payloadOriginal = { tripId: "trip-1", amount: "100.00" };
      const payloadTampered = { tripId: "trip-1", amount: "999.00" };

      // First call succeeds
      await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: "/api/expenses",
        payload: payloadOriginal,
        execute: async () => ({ data: { id: "exp-1" }, status: 201 }),
      });

      // Second call with same key but different payload must throw IdempotencyConflictError
      await expect(
        withIdempotency({
          key,
          walletAddress: TEST_WALLET,
          endpoint: "/api/expenses",
          payload: payloadTampered,
          execute: async () => ({ data: { id: "exp-2" }, status: 201 }),
        }),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it("clears lock on mutation failure so subsequent retries can succeed", async () => {
      const key = `test-key-${Date.now()}-retry-fail`;
      const payload = { tripId: "trip-fail" };

      let attempt = 0;
      const flakymutation = async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("Temporary network glitch");
        }
        return { data: { success: true }, status: 200 };
      };

      // First attempt fails
      await expect(
        withIdempotency({
          key,
          walletAddress: TEST_WALLET,
          endpoint: "/api/invitations/create",
          payload,
          execute: flakymutation,
        }),
      ).rejects.toThrow("Temporary network glitch");

      // Second attempt succeeds because lock was released on failure
      const res = await withIdempotency({
        key,
        walletAddress: TEST_WALLET,
        endpoint: "/api/invitations/create",
        payload,
        execute: flakymutation,
      });

      expect(res.data.success).toBe(true);
      expect(res.replayed).toBe(false);
    });
  });

  describe("Database Constraints and Schema Verification", () => {
    it("verifies migration 0014_idempotency_records.sql exists with UNIQUE constraint and RLS", () => {
      const migrationPath = path.join(process.cwd(), "migrations", "0014_idempotency_records.sql");
      expect(fs.existsSync(migrationPath)).toBe(true);

      const migrationSql = fs.readFileSync(migrationPath, "utf8");
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.idempotency_records");
      expect(migrationSql).toContain("CONSTRAINT idempotency_records_wallet_key_unique UNIQUE (wallet_address, key)");
      expect(migrationSql).toContain("ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;");
      expect(migrationSql).toContain("public.current_wallet()");
      expect(migrationSql).toContain("'0014'");
    });

    it("verifies supabase-setup.sql defines idempotency_records table and registers migration 0014", () => {
      const setupPath = path.join(process.cwd(), "supabase-setup.sql");
      const setupSql = fs.readFileSync(setupPath, "utf8");

      expect(setupSql).toContain("CREATE TABLE IF NOT EXISTS public.idempotency_records");
      expect(setupSql).toContain("CONSTRAINT idempotency_records_wallet_key_unique UNIQUE (wallet_address, key)");
      expect(setupSql).toContain("('0014', '0014_idempotency_records', 'idempotency_records_312_v1')");
    });

    it("verifies types/supabase.ts includes idempotency_records schema definitions", () => {
      const typesPath = path.join(process.cwd(), "types", "supabase.ts");
      const typesTs = fs.readFileSync(typesPath, "utf8");

      expect(typesTs).toContain("idempotency_records:");
      expect(typesTs).toContain("IdempotencyRecordRow");
    });
  });

  describe("API Route Integration Verification", () => {
    it("confirms mutating routes integrate idempotency handling", () => {
      const expenseRoute = fs.readFileSync(path.join(process.cwd(), "app/api/expenses/route.ts"), "utf8");
      const tripRoute = fs.readFileSync(path.join(process.cwd(), "app/api/trips/route.ts"), "utf8");
      const inviteRoute = fs.readFileSync(path.join(process.cwd(), "app/api/invitations/create/route.ts"), "utf8");
      const claimRoute = fs.readFileSync(path.join(process.cwd(), "app/api/invitations/claim/route.ts"), "utf8");

      for (const route of [expenseRoute, tripRoute, inviteRoute, claimRoute]) {
        expect(route).toContain("extractIdempotencyKey");
        expect(route).toContain("withIdempotency");
        expect(route).toContain("idempotentJsonResponse");
        expect(route).toContain("IdempotencyConflictError");
      }
    });
  });
});
