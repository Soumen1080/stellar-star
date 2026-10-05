import { NextRequest } from "next/server";
import {
  parsePaginationParams,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "@/lib/supabase/queries";
import { GET as getTripsRoute, POST as postTripsRoute } from "@/app/api/trips/route";
import { GET as getExpensesRoute, POST as postExpensesRoute } from "@/app/api/expenses/route";
import { signWalletSession } from "@/lib/supabase/serverAuth";

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

describe("Server-side pagination and route validation", () => {
  describe("parsePaginationParams", () => {
    it("uses default page size when limit is not provided", () => {
      const parsed = parsePaginationParams({});
      expect(parsed.limit).toBe(DEFAULT_PAGE_SIZE);
      expect(parsed.cursor).toBeNull();
    });

    it("parses valid numeric string limit", () => {
      const parsed = parsePaginationParams({ limit: "15" });
      expect(parsed.limit).toBe(15);
    });

    it("caps limit to MAX_PAGE_SIZE (100)", () => {
      const parsed = parsePaginationParams({ limit: 500 });
      expect(parsed.limit).toBe(MAX_PAGE_SIZE);
    });

    it("throws error for negative or zero limit", () => {
      expect(() => parsePaginationParams({ limit: 0 })).toThrow(/positive integer/);
      expect(() => parsePaginationParams({ limit: -10 })).toThrow(/positive integer/);
      expect(() => parsePaginationParams({ limit: "abc" })).toThrow(/positive integer/);
    });

    it("validates and formats ISO cursor", () => {
      const date = "2026-09-29T12:00:00.000Z";
      const parsed = parsePaginationParams({ cursor: date });
      expect(parsed.cursor).toBe(date);
    });

    it("throws error for malformed cursor", () => {
      expect(() => parsePaginationParams({ cursor: "not-a-date" })).toThrow(/ISO 8601/);
    });

    it("parses non-negative offset", () => {
      const parsed = parsePaginationParams({ offset: "10" });
      expect(parsed.offset).toBe(10);
    });

    it("throws error for negative offset", () => {
      expect(() => parsePaginationParams({ offset: -5 })).toThrow(/non-negative integer/);
    });
  });

  describe("app/api/trips/route", () => {
    it("returns 401 Unauthorized when Authorization header is missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/trips?limit=10");
      const res = await getTripsRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toMatch(/Unauthorized/);
    });

    it("returns 400 Bad Request when limit is invalid", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/trips?limit=-5", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await getTripsRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/positive integer/);
    });

    it("returns 400 Bad Request when cursor is invalid", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/trips?cursor=invalid-cursor", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await getTripsRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/ISO 8601/);
    });

    it("validates trip creation payload in POST", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/trips", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "" }),
      });
      const res = await postTripsRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/Trip name is required/);
    });
  });

  describe("app/api/expenses/route", () => {
    it("returns 401 Unauthorized when Authorization header is missing", async () => {
      const req = new NextRequest("http://localhost:3000/api/expenses?limit=10");
      const res = await getExpensesRoute(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toMatch(/Unauthorized/);
    });

    it("returns 400 Bad Request when limit exceeds normal integer", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/expenses?limit=invalid", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await getExpensesRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/positive integer/);
    });

    it("returns 400 Bad Request when cursor is invalid", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/expenses?cursor=bad-cursor", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const res = await getExpensesRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/ISO 8601/);
    });

    it("validates expense creation payload in POST", async () => {
      const token = signWalletSession(WALLET);
      const req = new NextRequest("http://localhost:3000/api/expenses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: "" }),
      });
      const res = await postExpensesRoute(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toMatch(/Expense title is required/);
    });
  });
});
