"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildPaymentEventKey, fetchContractEvents } from "@/lib/stellar/events";
import { getContractPayments } from "@/lib/stellar/contract";
import type { ContractPaymentEvent, ContractPaymentRecord } from "@/types/contract";
import type { Expense } from "@/types/expense";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { reconcileTripWithChainState } from "@/lib/settlement/reconcile";
import { acquirePollSlot, claimGlobalTick } from "@/hooks/usePollBudget";

const BASE_POLL_INTERVAL_MS = 10_000; // 10s
const MAX_POLL_INTERVAL_MS  = 60_000; // 60s
const BACKOFF_FACTOR        = 1.5;
const MIN_VISIBILITY_THROTTLE_MS = 5_000; // 5s minimum between visibility fetches

/**
 * How often to re-read durable contract state during a long-lived session.
 * The event stream covers the fast path; this is the safety net that keeps a
 * session correct once it outlives the RPC retention window, and repairs any
 * event the stream dropped.
 */
const STATE_REFRESH_INTERVAL_MS = 5 * 60_000; // 5min

interface UseContractEventsResult {
  events: ContractPaymentEvent[];
  latestLedger: number;
  isLoading: boolean;
  error: string | null;
  /**
   * True when neither the event stream nor durable contract state could give an
   * authoritative answer (events pruned/truncated *and* state archived). The UI
   * must render this as "settlement status unknown", never as "unpaid".
   */
  degraded: boolean;
  /** Contract storage for this trip is archived or its TTL expired. */
  stateArchived: boolean;
  refresh: () => Promise<void>;
}

function recordToEvent(record: ContractPaymentRecord): ContractPaymentEvent {
  return {
    ledger: 0,
    ledgerClosedAt: record.timestamp ? new Date(record.timestamp * 1000).toISOString() : "",
    tripId: record.tripId,
    expenseId: record.expenseId,
    payer: record.payer,
    member: record.member,
    amountStroops: record.amountStroops.toString(),
    asset: record.asset || "native",
    txHash: record.txHash,
    timestamp: record.timestamp,
  };
}

export function useContractEvents(
  tripId: string | undefined,
  expenses?: Expense[],
): UseContractEventsResult {
  const [events, setEvents]             = useState<ContractPaymentEvent[]>([]);
  const [latestLedger, setLatestLedger] = useState(0);
  const [isLoading, setIsLoading]       = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [degraded, setDegraded]         = useState(false);
  const [stateArchived, setStateArchived] = useState(false);

  const ledgerRef = useRef(0);
  ledgerRef.current = latestLedger;

  const currentIntervalRef = useRef(BASE_POLL_INTERVAL_MS);
  const lastFetchTimeRef   = useRef(0);
  const isFetchingRef      = useRef(false);
  const lastStateReadRef   = useRef(0);
  const timeoutIdRef       = useRef<NodeJS.Timeout | null>(null);

  const fetch_ = useCallback(async (isFirst = false) => {
    if (!tripId || !CONTRACT_ID) return;
    if (isFetchingRef.current) return;

    // Bounded polling: skip this tick if the process-wide budget is spent.
    // A first load bypasses the rate gate so opening a trip always renders,
    // but still respects the concurrency cap.
    if (!isFirst && !claimGlobalTick()) return;
    const releaseSlot = acquirePollSlot();
    if (!releaseSlot) return;

    isFetchingRef.current = true;
    if (isFirst) setIsLoading(true);
    lastFetchTimeRef.current = Date.now();

    try {
      const allNewEvents: ContractPaymentEvent[] = [];

      // 1. Query the real-time event stream first, so we know whether the
      //    durable path is required rather than merely periodic.
      const result = await fetchContractEvents(ledgerRef.current, tripId);
      if (result.events.length > 0) {
        allNewEvents.push(...result.events);
      }

      // 2. Read durable contract storage. This is the only path that works for
      //    a trip older than the RPC retention window, so it runs on first
      //    load, whenever events were pruned or truncated, and on a slow timer
      //    thereafter so a long-lived session stays correct as it ages past
      //    the window.
      const stateIsStale =
        Date.now() - lastStateReadRef.current >= STATE_REFRESH_INTERVAL_MS;
      const needsState =
        isFirst || result.retentionExpired || result.truncated || stateIsStale;

      let stateAuthoritative = false;
      if (needsState) {
        try {
          const stateRes = await getContractPayments(tripId);
          lastStateReadRef.current = Date.now();
          setStateArchived(Boolean(stateRes.isArchived));
          // Archived storage is not evidence of absence — it is unknown.
          stateAuthoritative = stateRes.success && !stateRes.isArchived;
          if (stateRes.success && stateRes.payments.length > 0) {
            allNewEvents.push(...stateRes.payments.map(recordToEvent));
          }
        } catch (err) {
          console.warn("[useContractEvents] Contract state read warning:", err);
        }
      } else {
        // Not re-read this tick, but a recent successful read still stands.
        stateAuthoritative = lastStateReadRef.current > 0;
      }

      const eventsAuthoritative =
        !result.retentionExpired && !result.truncated && !result.error;
      setDegraded(!stateAuthoritative && !eventsAuthoritative);

      if (allNewEvents.length > 0) {
        // Idempotent, order-independent merge keyed on the exact
        // (trip, expense, member, amount, asset) tuple. Re-running a poll or
        // replaying the same records converges to the same set, so missed or
        // duplicated polls are harmless.
        setEvents((prev) => {
          const known = new Set(prev.map(buildPaymentEventKey));
          const seen = new Set<string>();
          const toAdd: ContractPaymentEvent[] = [];
          for (const e of allNewEvents) {
            const key = buildPaymentEventKey(e);
            if (known.has(key) || seen.has(key)) continue;
            seen.add(key);
            toAdd.push(e);
          }
          return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
        });

        // Trigger background reconciliation to converge Supabase app state with on-chain truth
        if (expenses && expenses.length > 0) {
          reconcileTripWithChainState(tripId, expenses, allNewEvents).catch((err) => {
            console.warn("[useContractEvents] Auto-reconciliation warning:", err);
          });
        }

        // Reset backoff interval on receiving events
        currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
      } else if (!isFirst) {
        // Adaptive backoff on idle
        currentIntervalRef.current = Math.min(
          MAX_POLL_INTERVAL_MS,
          Math.round(currentIntervalRef.current * BACKOFF_FACTOR),
        );
      }

      if (result.latestLedger > ledgerRef.current) {
        setLatestLedger(result.latestLedger);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Event fetch failed.");
    } finally {
      releaseSlot();
      isFetchingRef.current = false;
      if (isFirst) setIsLoading(false);
    }
  }, [tripId, expenses]);

  const refresh = useCallback(async () => {
    currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
    await fetch_();
  }, [fetch_]);

  useEffect(() => {
    if (!tripId || !CONTRACT_ID) return;

    lastStateReadRef.current = 0;
    currentIntervalRef.current = BASE_POLL_INTERVAL_MS;

    fetch_(true);

    let isSubscribed = true;

    const scheduleNextPoll = () => {
      if (!isSubscribed) return;
      timeoutIdRef.current = setTimeout(async () => {
        await fetch_();
        if (isSubscribed) {
          scheduleNextPoll();
        }
      }, currentIntervalRef.current);
    };

    scheduleNextPoll();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        const elapsed = Date.now() - lastFetchTimeRef.current;
        if (elapsed >= MIN_VISIBILITY_THROTTLE_MS) {
          currentIntervalRef.current = BASE_POLL_INTERVAL_MS;
          fetch_();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      isSubscribed = false;
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tripId, fetch_]);

  return { events, latestLedger, isLoading, error, degraded, stateArchived, refresh };
}
