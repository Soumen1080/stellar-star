/**
 * lib/supabase/realtimeRegistry.ts
 *
 * One Realtime channel per (client, scope, bindings), shared by every consumer
 * (#448).
 *
 * Before this, each mounted hook opened its own channel and tore it down
 * asynchronously on unmount. Navigation, React re-renders that changed a
 * callback identity, and Strict Mode double-mounts all re-ran that effect, so
 * live channels could pile up for the same wallet/table.
 *
 * Invariants:
 *   1. Consumers with the same scope and bindings share one channel. The
 *      channel is ref-counted. Releasing the last consumer tears it down after
 *      a short grace period. Re-acquiring within the grace period reuses it, so
 *      unmount→mount during navigation never opens a second channel.
 *   2. Teardown is idempotent: removeChannel runs exactly once per channel, and
 *      every pending reconnect or teardown timer is cancelled.
 *   3. A channel that errors, times out or closes unexpectedly is removed and
 *      reopened with exponential backoff and full jitter. A whole fleet of
 *      tabs therefore does not reconnect at the same instant after an outage.
 *      After a reconnect, consumers get `onResync` so they can re-read
 *      anything they missed.
 *   4. Filters are narrow and validated. Trip-scoped channels filter on
 *      `trip_id=eq.<uuid>` and never accept a caller-built filter string.
 *   5. Telemetry reports live channels, consumers, opens/closes, reconnects and
 *      per-channel event rates, without wallet addresses.
 */

export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE";

export type RealtimeScope =
  | { kind: "wallet"; wallet: string }
  | { kind: "trip"; tripId: string; wallet: string };

export interface RealtimeBinding {
  table: string;
  /** Events to receive; defaults to INSERT, UPDATE and DELETE. */
  events?: RealtimeEvent[];
}

export interface RealtimePayload {
  eventType: RealtimeEvent;
  table: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface RealtimeConsumer {
  onChange: (payload: RealtimePayload) => void;
  /** Called after the channel recovers from an error: events may have been missed. */
  onResync?: () => void;
  /** Called on every channel status change (SUBSCRIBED, CHANNEL_ERROR, …). */
  onStatus?: (status: string) => void;
}

/** The subset of the Supabase client and channel API the registry needs. */
export interface RealtimeChannelLike {
  on(type: "postgres_changes", filter: Record<string, string>, callback: (payload: any) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string, err?: unknown) => void): RealtimeChannelLike;
}

export interface RealtimeClientLike {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): unknown;
}

export interface RealtimeRegistryConfig {
  /** Delay before an unreferenced channel is torn down. */
  teardownGraceMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** Sliding window used for event-rate telemetry. */
  rateWindowMs: number;
  /** Live-channel count above which telemetry flags a leak. */
  maxLiveChannels: number;
  random: () => number;
  now: () => number;
}

const DEFAULT_CONFIG: RealtimeRegistryConfig = {
  teardownGraceMs: 1_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  rateWindowMs: 60_000,
  maxLiveChannels: 8,
  random: Math.random,
  now: () => Date.now(),
};

let config: RealtimeRegistryConfig = { ...DEFAULT_CONFIG };

const ALL_EVENTS: RealtimeEvent[] = ["INSERT", "UPDATE", "DELETE"];
const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALLET_RE = /^[A-Z0-9]{1,69}$/;

interface Entry {
  id: number;
  key: string;
  topic: string;
  client: RealtimeClientLike;
  scope: RealtimeScope;
  bindings: Array<Required<RealtimeBinding>>;
  consumers: Set<RealtimeConsumer>;
  channel: RealtimeChannelLike | null;
  status: string;
  reconnectAttempts: number;
  reconnects: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the channel was reopened after a failure; cleared on SUBSCRIBED. */
  recovering: boolean;
  events: number;
  eventTimes: number[];
}

const registries = new WeakMap<RealtimeClientLike, Map<string, Entry>>();
/** Strong set of live entries, for telemetry and reset (WeakMap is not iterable). */
const liveEntries = new Set<Entry>();
let nextId = 1;

const counters = {
  opened: 0,
  closed: 0,
  reconnects: 0,
  peakLiveChannels: 0,
};

// ─── Keys & validation ───────────────────────────────────────────────────────

function validateScope(scope: RealtimeScope): void {
  if (!WALLET_RE.test(scope.wallet)) throw new Error("Realtime scope requires a valid wallet address.");
  if (scope.kind === "trip" && !UUID_RE.test(scope.tripId)) {
    throw new Error("Realtime trip scope requires a UUID trip id.");
  }
}

function normalizeBindings(bindings: RealtimeBinding[]): Array<Required<RealtimeBinding>> {
  if (bindings.length === 0) throw new Error("Realtime channel needs at least one table binding.");
  return bindings
    .map((b) => {
      if (!TABLE_RE.test(b.table)) throw new Error(`Invalid realtime table '${b.table}'.`);
      const events = [...new Set(b.events && b.events.length > 0 ? b.events : ALL_EVENTS)].sort() as RealtimeEvent[];
      return { table: b.table, events };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
}

function scopeKey(scope: RealtimeScope): string {
  return scope.kind === "wallet" ? `wallet:${scope.wallet}` : `trip:${scope.tripId}:${scope.wallet}`;
}

/** Row filter for a binding: trip scopes are narrowed server-side to one trip. */
export function realtimeFilterFor(scope: RealtimeScope): string | undefined {
  return scope.kind === "trip" ? `trip_id=eq.${scope.tripId.toLowerCase()}` : undefined;
}

// ─── Channel lifecycle ───────────────────────────────────────────────────────

function dispatch(entry: Entry, table: string, event: RealtimeEvent, payload: any): void {
  entry.events++;
  const now = config.now();
  entry.eventTimes.push(now);
  pruneRates(entry, now);
  const normalized: RealtimePayload = {
    ...(payload ?? {}),
    eventType: (payload?.eventType as RealtimeEvent) ?? event,
    table: payload?.table ?? table,
    new: payload?.new ?? null,
    old: payload?.old ?? null,
  };
  // Snapshot: a consumer may release itself from inside its callback.
  for (const consumer of [...entry.consumers]) {
    try {
      consumer.onChange(normalized);
    } catch (err) {
      console.warn("[StellarStar] Realtime consumer threw:", err);
    }
  }
}

function pruneRates(entry: Entry, now: number): void {
  const cutoff = now - config.rateWindowMs;
  let drop = 0;
  while (drop < entry.eventTimes.length && entry.eventTimes[drop] < cutoff) drop++;
  if (drop > 0) entry.eventTimes.splice(0, drop);
}

function open(entry: Entry): void {
  const filter = realtimeFilterFor(entry.scope);
  let channel = entry.client.channel(entry.topic);
  for (const binding of entry.bindings) {
    for (const event of binding.events) {
      const spec: Record<string, string> = { event, schema: "public", table: binding.table };
      if (filter) spec.filter = filter;
      channel = channel.on("postgres_changes", spec, (payload) => {
        if (entry.channel === channel) dispatch(entry, binding.table, event, payload);
      });
    }
  }
  entry.channel = channel;
  entry.status = "JOINING";
  counters.opened++;
  liveEntries.add(entry);
  counters.peakLiveChannels = Math.max(counters.peakLiveChannels, liveChannelCount());

  channel.subscribe((status) => {
    if (entry.channel !== channel) return; // a superseded channel reporting late
    entry.status = status;
    for (const consumer of [...entry.consumers]) consumer.onStatus?.(status);

    if (status === "SUBSCRIBED") {
      entry.reconnectAttempts = 0;
      if (entry.recovering) {
        entry.recovering = false;
        for (const consumer of [...entry.consumers]) consumer.onResync?.();
      }
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      scheduleReconnect(entry);
    }
  });
}

function closeChannel(entry: Entry): void {
  const channel = entry.channel;
  if (!channel) return;
  entry.channel = null;
  counters.closed++;
  try {
    void entry.client.removeChannel(channel);
  } catch (err) {
    console.warn("[StellarStar] Could not remove realtime channel:", err);
  }
}

/** Full-jitter exponential backoff: uniform in [0, min(max, base·2^attempt)]. */
export function reconnectDelay(attempt: number, cfg: Pick<RealtimeRegistryConfig, "reconnectBaseMs" | "reconnectMaxMs" | "random"> = config): number {
  const ceiling = Math.min(cfg.reconnectMaxMs, cfg.reconnectBaseMs * 2 ** Math.max(0, attempt));
  return Math.floor(cfg.random() * ceiling);
}

function scheduleReconnect(entry: Entry): void {
  if (entry.reconnectTimer || entry.consumers.size === 0) return;
  closeChannel(entry);
  const delay = reconnectDelay(entry.reconnectAttempts);
  entry.reconnectAttempts++;
  entry.status = "RECONNECTING";
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (entry.consumers.size === 0 || !isRegistered(entry)) return;
    entry.recovering = true;
    entry.reconnects++;
    counters.reconnects++;
    open(entry);
  }, delay);
}

function isRegistered(entry: Entry): boolean {
  return registries.get(entry.client)?.get(entry.key) === entry;
}

function destroy(entry: Entry): void {
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
  entry.reconnectTimer = null;
  entry.teardownTimer = null;
  closeChannel(entry);
  entry.consumers.clear();
  entry.status = "CLOSED";
  liveEntries.delete(entry);
  const map = registries.get(entry.client);
  if (map?.get(entry.key) === entry) map.delete(entry.key);
}

/**
 * Subscribes `consumer` to changes on `bindings` within `scope`, sharing a
 * channel with every other consumer of the same scope and bindings. Returns
 * an idempotent release function.
 */
export function acquireRealtimeChannel(
  client: RealtimeClientLike,
  scope: RealtimeScope,
  bindings: RealtimeBinding[],
  consumer: RealtimeConsumer,
): () => void {
  validateScope(scope);
  const normalized = normalizeBindings(bindings);
  const bindingKey = normalized.map((b) => `${b.table}(${b.events.join(",")})`).join("+");
  const key = `${scopeKey(scope)}|${bindingKey}`;

  let map = registries.get(client);
  if (!map) {
    map = new Map();
    registries.set(client, map);
  }

  let entry = map.get(key);
  if (!entry) {
    const id = nextId++;
    entry = {
      id,
      key,
      // Topic names are visible to the Realtime server only; keep them unique per scope.
      topic: `rt:${scopeKey(scope)}:${normalized.map((b) => b.table).join("+")}`,
      client,
      scope,
      bindings: normalized,
      consumers: new Set(),
      channel: null,
      status: "IDLE",
      reconnectAttempts: 0,
      reconnects: 0,
      reconnectTimer: null,
      teardownTimer: null,
      recovering: false,
      events: 0,
      eventTimes: [],
    };
    map.set(key, entry);
  }

  if (entry.teardownTimer) {
    clearTimeout(entry.teardownTimer);
    entry.teardownTimer = null;
  }
  entry.consumers.add(consumer);
  if (!entry.channel && !entry.reconnectTimer) open(entry);

  const owned = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned.consumers.delete(consumer);
    if (owned.consumers.size > 0 || !isRegistered(owned)) return;
    if (owned.teardownTimer) clearTimeout(owned.teardownTimer);
    owned.teardownTimer = setTimeout(() => {
      owned.teardownTimer = null;
      if (owned.consumers.size === 0) destroy(owned);
    }, config.teardownGraceMs);
  };
}

/** Tears down every channel immediately (sign-out, wallet switch). */
export function resetRealtimeChannels(): void {
  // Includes entries waiting on a reconnect or teardown timer: destroy()
  // cancels both, so nothing reopens after a sign-out.
  for (const entry of [...liveEntries]) destroy(entry);
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

export interface RealtimeChannelStats {
  id: number;
  scope: RealtimeScope["kind"];
  tables: string[];
  consumers: number;
  status: string;
  events: number;
  eventsPerMinute: number;
  reconnects: number;
}

export interface RealtimeTelemetry {
  at: string;
  liveChannels: number;
  peakLiveChannels: number;
  consumers: number;
  channelsOpened: number;
  channelsClosed: number;
  reconnects: number;
  totalEvents: number;
  eventsPerMinute: number;
  overBudget: boolean;
  channels: RealtimeChannelStats[];
}

function liveChannelCount(): number {
  let n = 0;
  for (const entry of liveEntries) if (entry.channel) n++;
  return n;
}

export function getRealtimeTelemetry(): RealtimeTelemetry {
  const now = config.now();
  const minutes = config.rateWindowMs / 60_000;
  const channels: RealtimeChannelStats[] = [...liveEntries]
    .map((entry) => {
      pruneRates(entry, now);
      return {
        id: entry.id,
        scope: entry.scope.kind,
        tables: entry.bindings.map((b) => b.table),
        consumers: entry.consumers.size,
        status: entry.status,
        events: entry.events,
        eventsPerMinute: Number((entry.eventTimes.length / minutes).toFixed(2)),
        reconnects: entry.reconnects,
      };
    })
    .sort((a, b) => a.id - b.id);

  const live = liveChannelCount();
  return {
    at: new Date(now).toISOString(),
    liveChannels: live,
    peakLiveChannels: counters.peakLiveChannels,
    consumers: channels.reduce((n, c) => n + c.consumers, 0),
    channelsOpened: counters.opened,
    channelsClosed: counters.closed,
    reconnects: counters.reconnects,
    totalEvents: channels.reduce((n, c) => n + c.events, 0),
    eventsPerMinute: Number(channels.reduce((n, c) => n + c.eventsPerMinute, 0).toFixed(2)),
    overBudget: live > config.maxLiveChannels,
    channels,
  };
}

type TelemetryListener = (snapshot: RealtimeTelemetry) => void;
const telemetryListeners = new Set<TelemetryListener>();
let telemetryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reports a telemetry snapshot to `listener` every `intervalMs` while at least
 * one listener is registered. Returns an unsubscribe function.
 */
export function onRealtimeTelemetry(listener: TelemetryListener, intervalMs = 60_000): () => void {
  telemetryListeners.add(listener);
  if (!telemetryTimer) {
    telemetryTimer = setInterval(() => {
      const snapshot = getRealtimeTelemetry();
      if (snapshot.overBudget) {
        console.warn(
          `[StellarStar] ${snapshot.liveChannels} live realtime channels exceeds the budget of ${config.maxLiveChannels}.`,
        );
      }
      for (const l of [...telemetryListeners]) l(snapshot);
    }, intervalMs);
  }
  return () => {
    telemetryListeners.delete(listener);
    if (telemetryListeners.size === 0 && telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = null;
    }
  };
}

/** Test seam: override timing/randomness and reset counters. */
export function configureRealtimeRegistry(overrides: Partial<RealtimeRegistryConfig> = {}): void {
  resetRealtimeChannels();
  config = { ...DEFAULT_CONFIG, ...overrides };
  counters.opened = 0;
  counters.closed = 0;
  counters.reconnects = 0;
  counters.peakLiveChannels = 0;
}
