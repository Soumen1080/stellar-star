/**
 * reminders.test.ts — reminders and payment-request delivery (#326).
 *
 * Runs the real policy and service against an in-memory repository that
 * emulates RLS, a recording transport, and a real in-memory rate limiter.
 */

import {
  buildExternalMessage,
  decideExternalChannels,
  nextScheduleRun,
  normalizeNote,
  paymentRequestPath,
  resolveReminderTarget,
} from "@/lib/reminders/policy";
import {
  applyReminderAction,
  createSchedule,
  loadRequestContext,
  runDueSchedules,
  sendReminder,
  unsubscribe,
  updatePreferences,
  type ReminderDeps,
} from "@/lib/reminders/service";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/reminders/unsubscribe";
import { defaultPreferences } from "@/lib/reminders/repository";
import { __resetRateLimitsForTests, checkRateLimit } from "@/lib/auth/rateLimiter";
import type { ReminderTransport } from "@/lib/reminders/delivery";
import type { Expense } from "@/types/expense";
import type { ExternalReminderChannel } from "@/types/reminder";
import { memoryDb, memoryRepository, type MemoryDb } from "./memoryRepository";

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => false,
  createServiceRoleClient: () => null,
}));

const ALICE = "GALICE"; // paid the expense
const BOB = "GBOB"; // owes a share
const CAROL = "GCAROL"; // owes a share
const MALLORY = "GMALLORY"; // not on the trip

function dinner(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "exp-1",
    title: "Secret birthday dinner",
    totalAmount: "30.0000000",
    currency: "XLM",
    settlementAsset: "native",
    splitMode: "equal",
    paidByMemberId: "alice",
    members: [
      { id: "alice", name: "Alice", walletAddress: ALICE },
      { id: "bob", name: "Bob", walletAddress: BOB },
      { id: "carol", name: "Carol", walletAddress: CAROL },
    ],
    shares: [
      { memberId: "alice", name: "Alice", walletAddress: ALICE, amount: "10.0000000", paid: true },
      { memberId: "bob", name: "Bob", walletAddress: BOB, amount: "10.0000000", paid: false },
      { memberId: "carol", name: "Carol", walletAddress: CAROL, amount: "10.0000000", paid: true, txHash: "a".repeat(64) },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
    ...overrides,
  };
}

interface Sent {
  channel: ExternalReminderChannel;
  to: string;
  subject: string;
  text: string;
  link: string;
}

let db: MemoryDb;
let sent: Sent[];
let configured: Set<ExternalReminderChannel>;
let now: Date;

const transport: ReminderTransport = {
  isConfigured: (channel) => configured.has(channel),
  async send(channel, to, message) {
    sent.push({ channel, to, ...message });
  },
};

function depsFor(viewer: string | null): ReminderDeps {
  return {
    repo: memoryRepository(db, viewer),
    transport,
    rateLimit: (key, limit, windowMs) => checkRateLimit(key, limit, windowMs, now.getTime()),
    origin: "https://app.example",
    unsubscribeLink: (wallet, channel) => `https://app.example/api/reminders/unsubscribe?token=${createUnsubscribeToken(wallet, channel)}`,
    now: () => now,
  };
}

const remindBob = (viewer = ALICE, note: string | null = null) =>
  sendReminder(depsFor(viewer), {
    senderWallet: viewer,
    tripId: "trip-1",
    expenseId: "exp-1",
    memberId: "bob",
    note,
    trigger: "manual",
  });

beforeEach(() => {
  __resetRateLimitsForTests();
  db = memoryDb();
  sent = [];
  configured = new Set(["email", "push"]);
  now = new Date("2026-03-01T12:00:00.000Z");
  db.expenses.set("exp-1", dinner());
  db.trips.set("trip-1", { name: "Lisbon surprise trip", expenseIds: ["exp-1"], memberWallets: [ALICE, BOB, CAROL] });
});

describe("who may ask for what", () => {
  it("only lets the payer request an unpaid share from someone else", () => {
    expect(resolveReminderTarget(dinner(), "bob", ALICE)).toMatchObject({ ok: true, recipientWallet: BOB, amount: "10.0000000" });
    expect(resolveReminderTarget(dinner(), "bob", CAROL)).toMatchObject({ ok: false, status: 403 });
    expect(resolveReminderTarget(dinner(), "carol", ALICE)).toMatchObject({ ok: false, status: 409 });
    expect(resolveReminderTarget(dinner(), "alice", ALICE)).toMatchObject({ ok: false, status: 400 });
    expect(resolveReminderTarget(null, "bob", ALICE)).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a sender who cannot see the trip, without revealing it", async () => {
    const result = await remindBob(MALLORY);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(db.reminders.size).toBe(0);
  });

  it("bounds and cleans notes", () => {
    expect(normalizeNote("  thanks!\u0007 ")).toBe("thanks!");
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("x".repeat(281))).toBe("invalid");
    expect(normalizeNote(42)).toBe("invalid");
  });
});

describe("delivery", () => {
  it("delivers in-app only by default and records the send", async () => {
    const result = await remindBob();
    expect(result).toMatchObject({ ok: true, channels: ["in_app"] });
    expect(sent).toHaveLength(0);

    const [reminder] = db.reminders.values();
    expect(reminder).toMatchObject({ senderWallet: ALICE, recipientWallet: BOB, amount: "10.0000000", state: "delivered", trigger: "manual" });
    expect(db.events).toEqual([
      expect.objectContaining({ reminderId: reminder.id, actorWallet: ALICE, kind: "sent", channel: "in_app", detail: "manual" }),
    ]);
  });

  it("sends email/push only to opted-in recipients, with no trip details in the message", async () => {
    db.preferences.set(BOB, {
      ...defaultPreferences(BOB),
      emailOptIn: true,
      emailAddress: "bob@example.com",
      pushOptIn: true,
      pushEndpoint: "https://push.example/bob",
    });

    const result = await remindBob(ALICE, "Thanks for the lovely evening");
    expect(result).toMatchObject({ ok: true, channels: ["in_app", "email", "push"] });
    expect(sent.map((s) => [s.channel, s.to])).toEqual([
      ["email", "bob@example.com"],
      ["push", "https://push.example/bob"],
    ]);

    const [reminder] = db.reminders.values();
    for (const message of sent) {
      expect(message.link).toBe(`https://app.example${paymentRequestPath(reminder.id)}`);
      const everything = JSON.stringify(message);
      for (const secret of ["Lisbon", "birthday", "10.0000000", "10 XLM", ALICE, "Alice", "lovely evening", "trip-1", "exp-1"]) {
        expect(everything).not.toContain(secret);
      }
      expect(message.text).toContain("/api/reminders/unsubscribe?token=");
    }
    expect(db.events.filter((e) => e.kind === "delivered").map((e) => e.channel)).toEqual(["email", "push"]);
  });

  it("records why an opted-in channel was skipped", async () => {
    configured = new Set(["email"]);
    db.preferences.set(BOB, { ...defaultPreferences(BOB), emailOptIn: true, emailAddress: null, pushOptIn: true, pushEndpoint: "https://push.example/bob" });

    await remindBob();
    expect(sent).toHaveLength(0);
    expect(db.events.filter((e) => e.kind === "skipped").map((e) => [e.channel, e.detail])).toEqual([
      ["email", "no_address"],
      ["push", "unconfigured"],
    ]);
  });

  it("decides channels in a fixed order of reasons", () => {
    const prefs = { ...defaultPreferences(BOB), emailOptIn: true, emailAddress: "b@x.io" };
    const yes = () => true;
    expect(decideExternalChannels(null, false, yes, yes).every((d) => !d.send)).toBe(true);
    expect(decideExternalChannels(prefs, true, yes, yes)[0]).toMatchObject({ send: false, reason: "muted" });
    expect(decideExternalChannels(prefs, false, () => false, yes)[0]).toMatchObject({ send: false, reason: "unconfigured" });
    expect(decideExternalChannels(prefs, false, yes, () => false)[0]).toMatchObject({ send: false, reason: "rate_limited" });
    expect(decideExternalChannels(prefs, false, yes, yes)[0]).toMatchObject({ send: true, address: "b@x.io" });
  });

  it("keeps the external message generic", () => {
    const message = buildExternalMessage("https://app.example/requests/abc", "https://app.example/unsub");
    expect(message.subject).toBe("You have a payment request on StellarStar");
    expect(message.text).toContain("Sign in with your wallet");
  });
});

describe("rate limits", () => {
  it("allows one reminder per share per day", async () => {
    expect(await remindBob()).toMatchObject({ ok: true });
    expect(await remindBob()).toMatchObject({ ok: false, status: 429 });

    now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(await remindBob()).toMatchObject({ ok: true });
    expect(db.reminders.size).toBe(2);
  });

  it("caps external messages per recipient per channel, while in-app still arrives", async () => {
    db.preferences.set(BOB, { ...defaultPreferences(BOB), emailOptIn: true, emailAddress: "bob@example.com" });
    for (let i = 2; i <= 5; i++) {
      const id = `exp-${i}`;
      db.expenses.set(id, dinner({ id }));
      db.trips.get("trip-1")!.expenseIds.push(id);
    }

    const results = [];
    for (const expenseId of ["exp-1", "exp-2", "exp-3", "exp-4", "exp-5"]) {
      results.push(
        await sendReminder(depsFor(ALICE), { senderWallet: ALICE, tripId: "trip-1", expenseId, memberId: "bob", note: null, trigger: "manual" }),
      );
    }

    expect(results.every((r) => r.ok)).toBe(true);
    expect(sent).toHaveLength(3);
    expect(db.events.filter((e) => e.kind === "skipped" && e.detail === "rate_limited")).toHaveLength(2);
    expect([...db.reminders.values()].every((r) => r.channels.includes("in_app"))).toBe(true);
  });
});

describe("the payment-request deep link", () => {
  it("shows nothing to anyone but the sender and recipient", async () => {
    await remindBob();
    const [reminder] = db.reminders.values();

    expect(await loadRequestContext(depsFor(MALLORY), MALLORY, reminder.id)).toMatchObject({ ok: false, status: 404 });
    // Even a trip member who is not party to this request gets the same 404.
    expect(await loadRequestContext(depsFor(CAROL), CAROL, reminder.id)).toMatchObject({ ok: false, status: 404 });
    expect(await loadRequestContext(depsFor(BOB), BOB, "00000000-0000-4000-8000-ffffffffffff")).toMatchObject({ ok: false, status: 404 });
  });

  it("identifies the recipient and share, and marks it read only for the recipient", async () => {
    await remindBob();
    const [reminder] = db.reminders.values();

    const asSender = await loadRequestContext(depsFor(ALICE), ALICE, reminder.id);
    expect(asSender).toMatchObject({ ok: true, context: { viewerRole: "sender" } });
    expect(db.reminders.get(reminder.id)!.state).toBe("delivered");

    const asRecipient = await loadRequestContext(depsFor(BOB), BOB, reminder.id);
    expect(asRecipient).toMatchObject({
      ok: true,
      context: {
        viewerRole: "recipient",
        tripName: "Lisbon surprise trip",
        expenseTitle: "Secret birthday dinner",
        outstanding: "10.0000000",
        alreadyPaid: false,
        reminder: { memberId: "bob", recipientWallet: BOB, state: "read" },
      },
    });
    expect(db.events.map((e) => e.kind)).toEqual(["sent", "read"]);
  });
});

describe("history: sender, time, state, and mute/unsubscribe choices", () => {
  it("records dismiss, mute and unmute, and applies mutes to later reminders", async () => {
    await remindBob();
    const [first] = db.reminders.values();

    expect(await applyReminderAction(depsFor(BOB), BOB, first.id, "dismiss")).toMatchObject({ ok: true, reminder: { state: "dismissed" } });
    const muted = await applyReminderAction(depsFor(BOB), BOB, first.id, "mute_sender");
    expect(muted).toMatchObject({ ok: true, preferences: { mutedSenderWallets: [ALICE] } });

    db.preferences.set(BOB, { ...db.preferences.get(BOB)!, emailOptIn: true, emailAddress: "bob@example.com" });
    now = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    await remindBob();
    const second = [...db.reminders.values()][1];
    expect(second.state).toBe("muted");
    expect(sent).toHaveLength(0);

    await applyReminderAction(depsFor(BOB), BOB, first.id, "unmute_sender");
    expect(db.preferences.get(BOB)!.mutedSenderWallets).toEqual([]);

    const kinds = db.events.map((e) => [e.kind, e.actorWallet]);
    expect(kinds).toEqual([
      ["sent", ALICE],
      ["dismissed", BOB],
      ["muted_sender", BOB],
      ["sent", ALICE],
      ["skipped", ALICE],
      ["skipped", ALICE],
      ["unmuted_sender", BOB],
    ]);
    expect(db.events.filter((e) => e.kind === "skipped").map((e) => [e.channel, e.detail])).toEqual([
      ["in_app", "muted"],
      ["email", "muted"],
    ]);
    expect(db.events.every((e) => typeof e.createdAt === "string")).toBe(true);
  });

  it("lets only the sender cancel, and only the recipient mute", async () => {
    await remindBob();
    const [reminder] = db.reminders.values();
    expect(await applyReminderAction(depsFor(BOB), BOB, reminder.id, "cancel")).toMatchObject({ ok: false, status: 403 });
    expect(await applyReminderAction(depsFor(ALICE), ALICE, reminder.id, "mute_trip")).toMatchObject({ ok: false, status: 403 });
    expect(await applyReminderAction(depsFor(ALICE), ALICE, reminder.id, "cancel")).toMatchObject({ ok: true, reminder: { state: "cancelled" } });
  });

  it("requires an address to opt in and records opt-in/out", async () => {
    expect(await updatePreferences(depsFor(BOB), BOB, { emailOptIn: true })).toMatchObject({ ok: false, status: 400 });
    expect(await updatePreferences(depsFor(BOB), BOB, { emailOptIn: true, emailAddress: "not-an-email" })).toMatchObject({ ok: false, status: 400 });
    expect(await updatePreferences(depsFor(BOB), BOB, { emailOptIn: true, emailAddress: "bob@example.com" })).toMatchObject({
      ok: true,
      preferences: { emailOptIn: true },
    });
    await updatePreferences(depsFor(BOB), BOB, { emailOptIn: false });
    expect(db.events.map((e) => [e.kind, e.channel])).toEqual([
      ["opted_in", "email"],
      ["opted_out", "email"],
    ]);
  });

  it("unsubscribes from a signed link and rejects tampered ones", async () => {
    db.preferences.set(BOB, { ...defaultPreferences(BOB), emailOptIn: true, emailAddress: "bob@example.com" });
    const token = createUnsubscribeToken(BOB, "email");
    const claims = verifyUnsubscribeToken(token);
    expect(claims).toEqual({ wallet: BOB, channel: "email" });

    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ w: CAROL, c: "email", e: 9_999_999_999 })).toString("base64url");
    expect(verifyUnsubscribeToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.${signature}x`)).toBeNull();
    expect(verifyUnsubscribeToken(token, Math.floor(Date.now() / 1000) + 91 * 24 * 60 * 60)).toBeNull();

    await unsubscribe(depsFor(null), claims!);
    expect(db.preferences.get(BOB)!.emailOptIn).toBe(false);
    expect(db.events).toEqual([expect.objectContaining({ kind: "unsubscribed", actorWallet: BOB, channel: "email" })]);

    await remindBob();
    expect(sent).toHaveLength(0);
  });
});

describe("nothing is sent without a click or a configured schedule", () => {
  it("does nothing when no member has created a schedule", async () => {
    const result = await runDueSchedules(depsFor(null));
    expect(result).toEqual({ schedules: 0, sent: 0, skipped: 0 });
    expect(db.reminders.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("opening the request page or inbox never sends anything", async () => {
    await remindBob();
    const sentBefore = db.reminders.size;
    const [reminder] = db.reminders.values();
    await loadRequestContext(depsFor(BOB), BOB, reminder.id);
    await depsFor(BOB).repo.listReminders(BOB, "recipient", 50);
    expect(db.reminders.size).toBe(sentBefore);
    expect(sent).toHaveLength(0);
  });

  it("runs a member's schedule only when due, for their own receivables only", async () => {
    db.expenses.set(
      "exp-2",
      dinner({
        id: "exp-2",
        paidByMemberId: "carol",
        shares: [
          { memberId: "alice", name: "Alice", walletAddress: ALICE, amount: "5.0000000", paid: false },
          { memberId: "carol", name: "Carol", walletAddress: CAROL, amount: "5.0000000", paid: true },
        ],
      }),
    );
    db.trips.get("trip-1")!.expenseIds.push("exp-2");

    const created = await createSchedule(depsFor(ALICE), ALICE, "trip-1", 7);
    expect(created).toMatchObject({ ok: true, schedule: { intervalDays: 7, nextRunAt: "2026-03-08T12:00:00.000Z" } });

    expect(await runDueSchedules(depsFor(null))).toMatchObject({ schedules: 0, sent: 0 });

    now = new Date("2026-03-08T13:00:00.000Z");
    expect(await runDueSchedules(depsFor(null))).toEqual({ schedules: 1, sent: 1, skipped: 0 });
    const [reminder] = db.reminders.values();
    expect(reminder).toMatchObject({ senderWallet: ALICE, recipientWallet: BOB, trigger: "schedule" });
    expect(db.schedules.get(created.ok ? created.schedule.id : "")!.nextRunAt).toBe("2026-03-15T12:00:00.000Z");

    // An overlapping run in the same window finds nothing due.
    expect(await runDueSchedules(depsFor(null))).toMatchObject({ schedules: 0, sent: 0 });
  });

  it("rejects schedules for unknown trips and out-of-range intervals", async () => {
    expect(await createSchedule(depsFor(MALLORY), MALLORY, "trip-1", 7)).toMatchObject({ ok: false, status: 404 });
    expect(await createSchedule(depsFor(ALICE), ALICE, "trip-1", 0)).toMatchObject({ ok: false, status: 400 });
    expect(await createSchedule(depsFor(ALICE), ALICE, "trip-1", 31)).toMatchObject({ ok: false, status: 400 });
  });

  it("schedules the next run strictly in the future, even after missed runs", () => {
    const next = nextScheduleRun(new Date("2026-03-01T00:00:00Z"), 3, new Date("2026-03-10T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-03-13T00:00:00.000Z");
  });
});
