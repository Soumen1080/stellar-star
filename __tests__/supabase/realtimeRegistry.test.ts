/**
 * __tests__/supabase/realtimeRegistry.test.ts
 *
 * Shared, ref-counted realtime channels (#448): navigation cannot increase
 * live channels, teardown is reliable, reconnects use jittered backoff and
 * resync consumers, filters are narrow, and telemetry reports channel and
 * event rates.
 */

import {
  acquireRealtimeChannel,
  configureRealtimeRegistry,
  getRealtimeTelemetry,
  onRealtimeTelemetry,
  reconnectDelay,
  resetRealtimeChannels,
  type RealtimeClientLike,
  type RealtimeConsumer,
} from "@/lib/supabase/realtimeRegistry";

const WALLET = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "GBBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TRIP = "c0a80101-0000-4000-8000-000000000001";

interface FakeChannel {
  name: string;
  bindings: Array<{ spec: Record<string, string>; cb: (payload: any) => void }>;
  statusCb: ((status: string) => void) | null;
  removed: boolean;
  on: jest.Mock;
  subscribe: jest.Mock;
  emit(event: string, payload: any): void;
  status(s: string): void;
}

function fakeClient() {
  const channels: FakeChannel[] = [];
  const client = {
    channel: jest.fn((name: string) => {
      const ch: FakeChannel = {
        name,
        bindings: [],
        statusCb: null,
        removed: false,
        on: jest.fn((_type: string, spec: Record<string, string>, cb: (p: any) => void) => {
          ch.bindings.push({ spec, cb });
          return ch;
        }),
        subscribe: jest.fn((cb: (s: string) => void) => {
          ch.statusCb = cb;
          return ch;
        }),
        emit(event, payload) {
          for (const b of ch.bindings) if (b.spec.event === event) b.cb(payload);
        },
        status(s) {
          ch.statusCb?.(s);
        },
      };
      channels.push(ch);
      return ch;
    }),
    removeChannel: jest.fn((ch: FakeChannel) => {
      ch.removed = true;
      return Promise.resolve("ok");
    }),
  };
  const live = () => channels.filter((c) => !c.removed);
  return { client: client as unknown as RealtimeClientLike, raw: client, channels, live };
}

function consumer(overrides: Partial<RealtimeConsumer> = {}): RealtimeConsumer & { onChange: jest.Mock } {
  return { onChange: jest.fn(), onResync: jest.fn(), onStatus: jest.fn(), ...overrides } as any;
}

let clock = 0;

beforeEach(() => {
  jest.useFakeTimers();
  clock = 0;
  configureRealtimeRegistry({
    teardownGraceMs: 1_000,
    reconnectBaseMs: 1_000,
    reconnectMaxMs: 8_000,
    rateWindowMs: 60_000,
    maxLiveChannels: 2,
    random: () => 0.5,
    now: () => clock,
  });
});

afterEach(() => {
  resetRealtimeChannels();
  jest.useRealTimers();
});

describe("channel sharing and ref counting", () => {
  it("consumers of the same wallet and table share one channel", () => {
    const { client, raw, channels } = fakeClient();
    const a = consumer();
    const b = consumer();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], a);
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], b);

    expect(raw.channel).toHaveBeenCalledTimes(1);
    channels[0].emit("UPDATE", { new: { id: "t1" } });
    expect(a.onChange).toHaveBeenCalledTimes(1);
    expect(b.onChange).toHaveBeenCalledTimes(1);
    expect(a.onChange.mock.calls[0][0]).toEqual(
      expect.objectContaining({ eventType: "UPDATE", table: "trips", new: { id: "t1" }, old: null }),
    );
  });

  it("separates channels by wallet, table and trip", () => {
    const { client, raw } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "expenses" }], consumer());
    acquireRealtimeChannel(client, { kind: "wallet", wallet: OTHER }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(client, { kind: "trip", tripId: TRIP, wallet: WALLET }, [{ table: "household_chores" }], consumer());
    expect(raw.channel).toHaveBeenCalledTimes(4);
  });

  it("binding order and duplicate events do not create distinct channels", () => {
    const { client, raw } = fakeClient();
    const scope = { kind: "trip" as const, tripId: TRIP, wallet: WALLET };
    acquireRealtimeChannel(client, scope, [{ table: "a_table" }, { table: "b_table" }], consumer());
    acquireRealtimeChannel(client, scope, [{ table: "b_table" }, { table: "a_table", events: ["UPDATE", "INSERT", "DELETE", "UPDATE"] }], consumer());
    expect(raw.channel).toHaveBeenCalledTimes(1);
  });

  it("navigation (repeated unmount → mount) never increases live channels", () => {
    const { client, raw, live } = fakeClient();
    let release = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    for (let i = 0; i < 25; i++) {
      release();
      jest.advanceTimersByTime(100); // next route mounts well inside the grace period
      release = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
      expect(live()).toHaveLength(1);
    }
    expect(raw.channel).toHaveBeenCalledTimes(1);
    expect(getRealtimeTelemetry().peakLiveChannels).toBe(1);
  });

  it("tears down exactly once after the last consumer leaves the grace period", () => {
    const { client, raw, live } = fakeClient();
    const r1 = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    const r2 = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());

    r1();
    r1(); // idempotent: a double release must not steal r2's reference
    jest.advanceTimersByTime(5_000);
    expect(live()).toHaveLength(1);

    r2();
    jest.advanceTimersByTime(999);
    expect(live()).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(live()).toHaveLength(0);
    expect(raw.removeChannel).toHaveBeenCalledTimes(1);

    const t = getRealtimeTelemetry();
    expect(t.liveChannels).toBe(0);
    expect(t.channelsOpened).toBe(1);
    expect(t.channelsClosed).toBe(1);
  });

  it("a release that happens after teardown does not affect a newer channel", () => {
    const { client, live } = fakeClient();
    const r1 = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    r1();
    jest.advanceTimersByTime(1_000);
    const r2 = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    r1();
    jest.advanceTimersByTime(5_000);
    expect(live()).toHaveLength(1);
    r2();
  });

  it("isolates channels per client instance", () => {
    const one = fakeClient();
    const two = fakeClient();
    acquireRealtimeChannel(one.client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(two.client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    expect(one.raw.channel).toHaveBeenCalledTimes(1);
    expect(two.raw.channel).toHaveBeenCalledTimes(1);
  });

  it("reset tears everything down immediately and cancels pending reconnects", () => {
    const { client, channels, raw, live } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "expenses" }], consumer());
    channels[1].status("CHANNEL_ERROR"); // schedules a reconnect

    resetRealtimeChannels();
    jest.advanceTimersByTime(60_000);
    expect(live()).toHaveLength(0);
    expect(raw.channel).toHaveBeenCalledTimes(2);
    expect(getRealtimeTelemetry().liveChannels).toBe(0);
  });

  it("a consumer that throws does not stop delivery to the others", () => {
    const { client, channels } = fakeClient();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const bad = consumer({ onChange: jest.fn(() => { throw new Error("boom"); }) });
    const good = consumer();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], bad);
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], good);
    channels[0].emit("INSERT", { new: { id: "x" } });
    expect(good.onChange).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("narrow filters", () => {
  it("trip scopes filter every binding to the trip id", () => {
    const { client, channels } = fakeClient();
    acquireRealtimeChannel(
      client,
      { kind: "trip", tripId: TRIP.toUpperCase(), wallet: WALLET },
      [{ table: "household_chores" }, { table: "household_chore_completions", events: ["INSERT"] }],
      consumer(),
    );
    const specs = channels[0].bindings.map((b) => b.spec);
    expect(specs).toHaveLength(4);
    for (const spec of specs) expect(spec.filter).toBe(`trip_id=eq.${TRIP}`);
    expect(specs.filter((s) => s.table === "household_chore_completions").map((s) => s.event)).toEqual(["INSERT"]);
  });

  it("wallet scopes subscribe to exactly the requested table", () => {
    const { client, channels } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "expenses" }], consumer());
    expect(channels[0].bindings.map((b) => b.spec)).toEqual([
      { event: "DELETE", schema: "public", table: "expenses" },
      { event: "INSERT", schema: "public", table: "expenses" },
      { event: "UPDATE", schema: "public", table: "expenses" },
    ]);
  });

  it.each([
    ["non-UUID trip id", { kind: "trip", tripId: "x,trip_id=neq.0", wallet: WALLET }, [{ table: "t" }]],
    ["invalid wallet", { kind: "wallet", wallet: "not a wallet" }, [{ table: "t" }]],
    ["invalid table", { kind: "wallet", wallet: WALLET }, [{ table: "trips;drop" }]],
    ["no bindings", { kind: "wallet", wallet: WALLET }, []],
  ])("rejects %s without opening a channel", (_label, scope, bindings) => {
    const { client, raw } = fakeClient();
    expect(() => acquireRealtimeChannel(client, scope as any, bindings as any, consumer())).toThrow();
    expect(raw.channel).not.toHaveBeenCalled();
  });
});

describe("jittered reconnect", () => {
  it("computes full-jitter exponential backoff with a cap", () => {
    const cfg = { reconnectBaseMs: 1_000, reconnectMaxMs: 8_000 };
    expect(reconnectDelay(0, { ...cfg, random: () => 0.999 })).toBe(999);
    expect(reconnectDelay(2, { ...cfg, random: () => 0.5 })).toBe(2_000);
    expect(reconnectDelay(10, { ...cfg, random: () => 0.5 })).toBe(4_000);
    expect(reconnectDelay(3, { ...cfg, random: () => 0 })).toBe(0);
  });

  it("replaces a failed channel after a jittered delay and resyncs consumers", () => {
    const { client, raw, channels, live } = fakeClient();
    const c = consumer();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], c);
    channels[0].status("SUBSCRIBED");
    channels[0].status("CHANNEL_ERROR");

    expect(channels[0].removed).toBe(true);
    expect(live()).toHaveLength(0);
    jest.advanceTimersByTime(499); // 0.5 * 1000 * 2^0
    expect(raw.channel).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(raw.channel).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);

    expect(c.onResync).not.toHaveBeenCalled();
    channels[1].status("SUBSCRIBED");
    expect(c.onResync).toHaveBeenCalledTimes(1);
    expect(getRealtimeTelemetry().reconnects).toBe(1);
  });

  it("backs off exponentially across consecutive failures and resets after success", () => {
    const { client, raw, channels } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());

    const delays = [500, 1_000, 2_000, 4_000, 4_000];
    delays.forEach((delay, i) => {
      channels[i].status("TIMED_OUT");
      jest.advanceTimersByTime(delay - 1);
      expect(raw.channel).toHaveBeenCalledTimes(i + 1);
      jest.advanceTimersByTime(1);
      expect(raw.channel).toHaveBeenCalledTimes(i + 2);
    });

    channels[5].status("SUBSCRIBED");
    channels[5].status("CHANNEL_ERROR");
    jest.advanceTimersByTime(500);
    expect(raw.channel).toHaveBeenCalledTimes(7);
  });

  it("late status reports from a superseded channel are ignored", () => {
    const { client, raw, channels } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    channels[0].status("CHANNEL_ERROR");
    channels[0].status("CHANNEL_ERROR");
    channels[0].status("CLOSED");
    jest.advanceTimersByTime(10_000);
    expect(raw.channel).toHaveBeenCalledTimes(2);
  });

  it("our own teardown (CLOSED after removeChannel) does not trigger a reconnect", () => {
    const { client, raw, channels } = fakeClient();
    const release = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    release();
    jest.advanceTimersByTime(1_000);
    channels[0].status("CLOSED");
    jest.advanceTimersByTime(60_000);
    expect(raw.channel).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect once every consumer has released", () => {
    const { client, raw, channels } = fakeClient();
    const release = acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    channels[0].status("CHANNEL_ERROR");
    release();
    jest.advanceTimersByTime(60_000);
    expect(raw.channel).toHaveBeenCalledTimes(1);
    expect(getRealtimeTelemetry().liveChannels).toBe(0);
  });

  it("events from a replaced channel are not delivered", () => {
    const { client, channels } = fakeClient();
    const c = consumer();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], c);
    channels[0].status("CHANNEL_ERROR");
    jest.advanceTimersByTime(500);
    channels[0].emit("INSERT", { new: { id: "stale" } });
    channels[1].emit("INSERT", { new: { id: "fresh" } });
    expect(c.onChange.mock.calls.map((call: any[]) => call[0].new.id)).toEqual(["fresh"]);
  });
});

describe("telemetry", () => {
  it("reports channels, consumers and event rates without wallet addresses", () => {
    const { client, channels } = fakeClient();
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table: "trips" }], consumer());
    acquireRealtimeChannel(client, { kind: "trip", tripId: TRIP, wallet: WALLET }, [{ table: "household_chores" }], consumer());

    for (let i = 0; i < 6; i++) {
      clock += 1_000;
      channels[0].emit("UPDATE", { new: { id: `t${i}` } });
    }
    channels[1].emit("INSERT", { new: { id: "c" } });

    const t = getRealtimeTelemetry();
    expect(t.liveChannels).toBe(2);
    expect(t.consumers).toBe(3);
    expect(t.totalEvents).toBe(7);
    expect(t.eventsPerMinute).toBe(7);
    expect(t.channels.map((c) => ({ scope: c.scope, tables: c.tables, consumers: c.consumers, events: c.events }))).toEqual([
      { scope: "wallet", tables: ["trips"], consumers: 2, events: 6 },
      { scope: "trip", tables: ["household_chores"], consumers: 1, events: 1 },
    ]);
    expect(JSON.stringify(t)).not.toContain(WALLET);

    clock += 61_000; // the window slides past every event
    const later = getRealtimeTelemetry();
    expect(later.eventsPerMinute).toBe(0);
    expect(later.totalEvents).toBe(7);
  });

  it("periodically reports snapshots and flags live channels over budget", () => {
    const { client } = fakeClient();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const listener = jest.fn();
    const stop = onRealtimeTelemetry(listener, 10_000);

    for (const table of ["trips", "expenses", "contacts"]) {
      acquireRealtimeChannel(client, { kind: "wallet", wallet: WALLET }, [{ table }], consumer());
    }
    jest.advanceTimersByTime(10_000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual(expect.objectContaining({ liveChannels: 3, overBudget: true }));
    expect(warn).toHaveBeenCalled();

    stop();
    jest.advanceTimersByTime(30_000);
    expect(listener).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
