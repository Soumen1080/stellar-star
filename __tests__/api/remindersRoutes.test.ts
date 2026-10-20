/**
 * #326 — the /api/reminders routes require a wallet session, and the payment
 * request deep link shows private context only to its sender and recipient.
 */

import { NextRequest } from "next/server";
import { signWalletSession, verifyWalletSession } from "@/lib/supabase/serverAuth";
import { __resetRateLimitsForTests } from "@/lib/auth/rateLimiter";
import type { Expense } from "@/types/expense";
import { memoryDb, memoryRepository, type MemoryDb } from "../reminders/memoryRepository";

const ALICE = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const BOB = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
const MALLORY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

let db: MemoryDb;

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServerClientForToken: (token: string) => ({ token }),
  createServiceRoleClient: () => null,
}));
jest.mock("@/lib/reminders/repository", () => {
  const actual = jest.requireActual("@/lib/reminders/repository");
  return {
    ...actual,
    // Stand-in for RLS: the session's wallet is the only viewer.
    supabaseReminderRepository: ({ user }: { user: { token: string } | null }) =>
      memoryRepository(db, user ? verifyWalletSession(user.token)!.wallet_address : null),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const remindersRoute = require("@/app/api/reminders/route") as typeof import("@/app/api/reminders/route");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const requestRoute = require("@/app/api/reminders/[id]/route") as typeof import("@/app/api/reminders/[id]/route");

function req(url: string, init: { method?: string; wallet?: string | null; body?: unknown } = {}) {
  const token = init.wallet ? signWalletSession(init.wallet) : null;
  return new NextRequest(`http://localhost:3000${url}`, {
    method: init.method ?? "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  __resetRateLimitsForTests();
  db = memoryDb();
  const expense: Expense = {
    id: "exp-1",
    title: "Dinner",
    totalAmount: "20",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "alice",
    members: [
      { id: "alice", name: "Alice", walletAddress: ALICE },
      { id: "bob", name: "Bob", walletAddress: BOB },
    ],
    shares: [
      { memberId: "alice", name: "Alice", walletAddress: ALICE, amount: "10", paid: true },
      { memberId: "bob", name: "Bob", walletAddress: BOB, amount: "10", paid: false },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    settled: false,
  };
  db.expenses.set("exp-1", expense);
  db.trips.set("trip-1", { name: "Porto", expenseIds: ["exp-1"], memberWallets: [ALICE, BOB] });
});

async function sendAsAlice() {
  const res = await remindersRoute.POST(
    req("/api/reminders", { method: "POST", wallet: ALICE, body: { tripId: "trip-1", expenseId: "exp-1", memberId: "bob" } }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.reminder.id as string;
}

describe("/api/reminders", () => {
  it("requires a wallet session to send or list", async () => {
    const send = await remindersRoute.POST(
      req("/api/reminders", { method: "POST", body: { tripId: "trip-1", expenseId: "exp-1", memberId: "bob" } }),
    );
    expect(send.status).toBe(401);
    expect((await remindersRoute.GET(req("/api/reminders"))).status).toBe(401);
    expect(db.reminders.size).toBe(0);
  });

  it("rejects malformed bodies and over-long notes", async () => {
    const bad = await remindersRoute.POST(req("/api/reminders", { method: "POST", wallet: ALICE, body: { tripId: "trip-1" } }));
    expect(bad.status).toBe(400);
    const long = await remindersRoute.POST(
      req("/api/reminders", {
        method: "POST",
        wallet: ALICE,
        body: { tripId: "trip-1", expenseId: "exp-1", memberId: "bob", note: "x".repeat(281) },
      }),
    );
    expect(long.status).toBe(400);
  });

  it("rate-limits a second reminder for the same share", async () => {
    await sendAsAlice();
    const again = await remindersRoute.POST(
      req("/api/reminders", { method: "POST", wallet: ALICE, body: { tripId: "trip-1", expenseId: "exp-1", memberId: "bob" } }),
    );
    expect(again.status).toBe(429);
    expect(again.headers.get("Retry-After")).toBeTruthy();
  });

  it("lists the recipient's inbox without muted reminders", async () => {
    const id = await sendAsAlice();
    db.reminders.set("muted-one", { ...db.reminders.get(id)!, id: "muted-one", state: "muted" });
    const res = await remindersRoute.GET(req("/api/reminders?role=recipient", { wallet: BOB }));
    const { data } = await res.json();
    expect(data.map((r: { id: string }) => r.id)).toEqual([id]);
  });
});

describe("/api/reminders/[id] — the deep link", () => {
  it("returns nothing without a session", async () => {
    const id = await sendAsAlice();
    const res = await requestRoute.GET(req(`/api/reminders/${id}`), params(id));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/Porto|Dinner|10\.0000000/);
  });

  it("returns 404 to a signed-in wallet that is not party to the request", async () => {
    const id = await sendAsAlice();
    const res = await requestRoute.GET(req(`/api/reminders/${id}`, { wallet: MALLORY }), params(id));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/Porto|Dinner/);
  });

  it("returns 404 for malformed ids", async () => {
    const res = await requestRoute.GET(req("/api/reminders/not-a-uuid", { wallet: BOB }), params("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("shows the recipient the requested share and private context once signed in", async () => {
    const id = await sendAsAlice();
    const res = await requestRoute.GET(req(`/api/reminders/${id}`, { wallet: BOB }), params(id));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      viewerRole: "recipient",
      tripName: "Porto",
      expenseTitle: "Dinner",
      reminder: { id, memberId: "bob", recipientWallet: BOB, senderWallet: ALICE, amount: "10.0000000", state: "read" },
    });
    expect(data.history.map((e: { kind: string }) => e.kind)).toEqual(["sent", "read"]);
  });

  it("records the recipient's mute choice", async () => {
    const id = await sendAsAlice();
    const res = await requestRoute.PATCH(
      req(`/api/reminders/${id}`, { method: "PATCH", wallet: BOB, body: { action: "mute_trip" } }),
      params(id),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.preferences.mutedTripIds).toEqual(["trip-1"]);
    const bogus = await requestRoute.PATCH(
      req(`/api/reminders/${id}`, { method: "PATCH", wallet: BOB, body: { action: "delete_everything" } }),
      params(id),
    );
    expect(bogus.status).toBe(400);
  });
});
