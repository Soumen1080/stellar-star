"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  archiveHouseholdChoreRow,
  completeHouseholdChoreRow,
  createHouseholdChoreRow,
  fetchHouseholdChoreCompletions,
  fetchHouseholdChorePreferences,
  fetchHouseholdChores,
  setHouseholdChoreOptOut,
} from "@/lib/supabase/queries";
import type {
  HouseholdChore,
  HouseholdChoreCompletion,
  HouseholdChoreDraft,
  HouseholdChorePreference,
} from "@/types/householdChore";

export function useHouseholdChores(
  tripId: string,
  walletAddress: string | null | undefined,
  enabled: boolean,
) {
  const [chores, setChores] = useState<HouseholdChore[]>([]);
  const [completions, setCompletions] = useState<HouseholdChoreCompletion[]>([]);
  const [preferences, setPreferences] = useState<HouseholdChorePreference[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !walletAddress) {
      setChores([]);
      setCompletions([]);
      setPreferences([]);
      setIsLoading(false);
      setError(null);
      return;
    }
    setIsLoading(true);
    try {
      const [nextChores, nextCompletions, nextPreferences] = await Promise.all([
        fetchHouseholdChores(tripId),
        fetchHouseholdChoreCompletions(tripId),
        fetchHouseholdChorePreferences(tripId),
      ]);
      setChores(nextChores);
      setCompletions(nextCompletions);
      setPreferences(nextPreferences);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load household coordination.");
    } finally {
      setIsLoading(false);
    }
  }, [enabled, tripId, walletAddress]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (!enabled || !walletAddress) {
        if (!disposed) {
          setChores([]);
          setCompletions([]);
          setPreferences([]);
          setIsLoading(false);
          setError(null);
        }
        return;
      }
      setIsLoading(true);
      try {
        const [nextChores, nextCompletions, nextPreferences] = await Promise.all([
          fetchHouseholdChores(tripId),
          fetchHouseholdChoreCompletions(tripId),
          fetchHouseholdChorePreferences(tripId),
        ]);
        if (!disposed) {
          setChores(nextChores);
          setCompletions(nextCompletions);
          setPreferences(nextPreferences);
          setError(null);
        }
      } catch (caught) {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : "Could not load household coordination.");
        }
      } finally {
        if (!disposed) setIsLoading(false);
      }
    };
    void load();

    const client = getSupabaseClient();
    if (!client || !enabled || !walletAddress) {
      return () => {
        disposed = true;
      };
    }
    const channel = client
      .channel(`household-chores-${tripId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "household_chores", filter: `trip_id=eq.${tripId}` }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "household_chore_completions", filter: `trip_id=eq.${tripId}` }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "household_chore_preferences", filter: `trip_id=eq.${tripId}` }, () => void refresh())
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" && !disposed) {
          setError("Live chore updates are unavailable. Refresh the page to see the latest changes.");
        }
      });

    return () => {
      disposed = true;
      void client.removeChannel(channel);
    };
  }, [enabled, refresh, tripId, walletAddress]);

  const myPreference = useMemo(
    () => preferences.find((preference) => preference.walletAddress.toUpperCase() === walletAddress?.toUpperCase()),
    [preferences, walletAddress],
  );

  const mutate = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setIsMutating(true);
    setError(null);
    try {
      await action();
      await refresh();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The household coordination change failed.");
      return false;
    } finally {
      setIsMutating(false);
    }
  }, [refresh]);

  const createChore = useCallback(
    async (draft: HouseholdChoreDraft) => {
      if (!walletAddress) {
        setError("Connect your wallet before adding a chore.");
        return false;
      }
      return mutate(async () => {
        await createHouseholdChoreRow(tripId, walletAddress, draft);
      });
    },
    [mutate, tripId, walletAddress],
  );

  const completeChore = useCallback(
    (choreId: string, dueOn: string, supplyExpenseId: string | null) =>
      mutate(async () => {
        await completeHouseholdChoreRow(choreId, dueOn, supplyExpenseId);
      }),
    [mutate],
  );

  const archiveChore = useCallback(
    (choreId: string) => mutate(() => archiveHouseholdChoreRow(choreId)),
    [mutate],
  );

  const setOptOut = useCallback(
    async (optedOut: boolean) => {
      if (!walletAddress) {
        setError("Connect your wallet before changing your chore preference.");
        return false;
      }
      return mutate(() => setHouseholdChoreOptOut(tripId, walletAddress, optedOut));
    },
    [mutate, tripId, walletAddress],
  );

  return {
    chores,
    completions,
    preferences,
    myPreference,
    isLoading,
    isMutating,
    error,
    refresh,
    createChore,
    completeChore,
    archiveChore,
    setOptOut,
  };
}
