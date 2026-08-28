"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildPaymentEventKey, fetchContractEvents } from "@/lib/stellar/events";
import type { ContractPaymentEvent } from "@/types/contract";
import type { Expense } from "@/types/expense";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { reconcileTripWithChainState } from "@/lib/settlement/reconcile";

const POLL_INTERVAL_MS = 10_000;

interface UseContractEventsResult {
  events: ContractPaymentEvent[];
  latestLedger: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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

  const fetch_ = useCallback(async (isFirst = false) => {
    if (!tripId || !CONTRACT_ID) return;
    if (isFirst) setIsLoading(true);

    try {
      const result = await fetchContractEvents(ledgerRef.current, tripId);

      if (result.events.length > 0) {
        setEvents((prev) => {
          const known   = new Set(prev.map(buildPaymentEventKey));
          const newEvts = result.events.filter((e) => !known.has(buildPaymentEventKey(e)));
          return newEvts.length > 0 ? [...prev, ...newEvts] : prev;
        });

        // Trigger background reconciliation to converge Supabase app state with on-chain truth
        if (expenses && expenses.length > 0) {
          reconcileTripWithChainState(tripId, expenses, result.events).catch((err) => {
            console.warn("[useContractEvents] Auto-reconciliation warning:", err);
          });
        }
      }

      if (result.latestLedger > ledgerRef.current) {
        setLatestLedger(result.latestLedger);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Event fetch failed.");
    } finally {
      if (isFirst) setIsLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    if (!tripId || !CONTRACT_ID) return;

    fetch_(true);
    const interval = setInterval(() => fetch_(), POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") fetch_(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tripId, fetch_]);

  return { events, latestLedger, isLoading, error, refresh: () => fetch_() };
}
