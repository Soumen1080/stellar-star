/**
 * lib/settlement/inflight.ts
 *
 * In-process single-flight registry for irreversible money-path actions.
 *
 * The durable `settlement_intents` row is the cross-device lock, but it cannot
 * stop two calls originating inside one tab. `acquireSettlementIntent` has to
 * let the *same* wallet resume an intent it already owns — that is what makes a
 * refresh, a retry, or a resumed tab recoverable instead of permanently locked
 * out. A double-tapped Pay button satisfies that check twice, and both calls
 * then build a fresh transaction, each with its own source sequence number, so
 * Horizon accepts both and the payer is charged twice.
 *
 * This registry closes that window on the client: concurrent callers sharing a
 * key await the first call's promise instead of starting a second attempt. The
 * key is released as soon as the attempt settles, so a genuine retry after a
 * failure is never blocked.
 *
 * This is a latency optimisation, not a correctness boundary. Durable exactly-once
 * guarantees still come from the intent row's UNIQUE(idempotency_key) constraint
 * and from the on-chain `checkIsPaid` pre-flight.
 */

/** Keys currently being worked on, mapped to the in-flight promise. */
const inflight = new Map<string, Promise<unknown>>();

/** True while an attempt registered under `key` is still running. */
export function isInFlight(key: string): boolean {
  return inflight.has(key);
}

/**
 * Runs `work` for `key`, or joins the attempt already running under that key.
 *
 * Every caller receives the same result or the same rejection, and `work` runs
 * at most once per key at a time. The entry is removed once the attempt settles,
 * so the next call starts fresh work.
 */
export function runOnce<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  // Wrapped in an async IIFE so a synchronous throw inside `work` also releases
  // the key instead of leaving it registered forever.
  const attempt = (async () => work())().finally(() => {
    if (inflight.get(key) === attempt) inflight.delete(key);
  });

  inflight.set(key, attempt);
  return attempt;
}
