"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildPaymentEventKey, fetchContractEvents } from "@/lib/stellar/events";
import { getContractPayments } from "@/lib/stellar/contract";
import type { ContractPaymentEvent, ContractPaymentRecord } from "@/types/contract";
import type { Expense } from "@/types/expense";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { reconcileTripWithChainState } from "@/lib/settlement/reconcile";

const BASE_POLL_INTERVAL_MS = 10_000; // 10s
const MAX_POLL_INTERVAL_MS  = 60_000; // 60s
const BACKOFF_FACTOR        = 1.5;
const MIN_VISIBILITY_THROTTLE_MS = 5_000; // 5s minimum between visibility fetches

interface UseContractEventsResult {
  events: ContractPaymentEvent[];
  latestLedger: number;
  isLoading: boolean;
  error: string | null;
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

  const ledgerRef = useRef(0);
  ledgerRef.current = latestLedger;

  const currentIntervalRef = useRef(BASE_POLL_INTERVAL_MS);
  const lastFetchTimeRef   = useRef(0);
  const isFetchingRef      = useRef(false);
  const stateLoadedRef     = useRef(false);
  const timeoutIdRef       = useRef<NodeJS.Timeout | null>(null);

  const fetch_ = useCallback(async (isFirst = false) => {
    if (!tripId || !CONTRACT_ID) return;
    if (isFetchingRef.current) return;

    isFetchingRef.current = true;
    if (isFirst) setIsLoading(true);
    lastFetchTimeRef.current = Date.now();

    try {
      const allNewEvents: ContractPaymentEvent[] = [];

      // 1. On initial load, read durable contract storage (survives event retention expiry)
      if (isFirst && !stateLoadedRef.current) {
        try {
          const stateRes = await getContractPayments(tripId);
          if (stateRes.success && stateRes.payments.length > 0) {
            const converted = stateRes.payments.map(recordToEvent);
            allNewEvents.push(...converted);
            stateLoadedRef.current = true;
          }
        } catch (err) {
          console.warn("[useContractEvents] Contract state read warning:", err);
        }
      }

      // 2. Query real-time event stream
      const result = await fetchContractEvents(ledgerRef.current, tripId);
      if (result.events.length > 0) {
        allNewEvents.push(...result.events);
      }

      if (allNewEvents.length > 0) {
        setEvents((prev) => {
          const known = new Set(prev.map(buildPaymentEventKey));
          const toAdd = allNewEvents.filter((e) => !known.has(buildPaymentEventKey(e)));
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

    stateLoadedRef.current = false;
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

  return { events, latestLedger, isLoading, error, refresh };
}
