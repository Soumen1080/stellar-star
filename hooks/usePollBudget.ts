/**
 * A process-wide budget for on-chain polling.
 *
 * Invariant: polling cost does not grow unbounded with the number of open
 * trips or with returning users.
 *
 * Two mechanisms:
 *  1. `acquirePollSlot` caps how many trips may have a poll in flight at once.
 *     Extra trips skip that tick rather than queueing, so a user with twenty
 *     open trips issues the same request rate as one with four.
 *  2. `claimGlobalTick` enforces a minimum interval between *any* two polls
 *     across all trips, which absorbs the visibility-change burst that occurs
 *     when a backgrounded tab with several trips is refocused.
 *
 * Module state is intentional: the budget is shared by every hook instance in
 * the page.
 */

/** Maximum concurrent in-flight polls across all trips. */
export const MAX_CONCURRENT_POLLS = 3;

/** Minimum gap between any two polls, process-wide. */
export const GLOBAL_MIN_POLL_GAP_MS = 1_000;

let inFlight = 0;
let lastGlobalPollAt = 0;

/**
 * Attempts to reserve one of the concurrent poll slots.
 * Returns a release function, or `null` when the budget is exhausted.
 * The caller must invoke the release function in a `finally`.
 */
export function acquirePollSlot(): (() => void) | null {
  if (inFlight >= MAX_CONCURRENT_POLLS) return null;
  inFlight++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
  };
}

/**
 * Rate-limits polls process-wide. Returns false when the caller should skip
 * this tick because another trip polled too recently.
 */
export function claimGlobalTick(now: number = Date.now()): boolean {
  if (now - lastGlobalPollAt < GLOBAL_MIN_POLL_GAP_MS) return false;
  lastGlobalPollAt = now;
  return true;
}

/** Test seam. */
export function __resetPollBudget(): void {
  inFlight = 0;
  lastGlobalPollAt = 0;
}
