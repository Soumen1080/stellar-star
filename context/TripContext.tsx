"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Trip } from "@/types/trip";
import { LS_TRIPS } from "@/lib/utils/constants";
import {
  fetchTrips,
  insertTrip,
  createTripFromCopyRow,
  updateTripRow,
  deleteTripRow,
  addExpenseIdToTrip,
  cacheDomainsForMutation,
  rowToTrip,
} from "@/lib/supabase/queries";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { invalidateQueryCaches } from "@/lib/supabase/cacheInvalidation";
import { useWalletContext } from "./WalletContext";
import type { TripCopyRequest } from "@/lib/trip/templates";
import { cancelTripWatcher, cancelAllTripWatchers } from "@/hooks/useContractEvents";

interface TripContextType {
  trips: Trip[];
  addTrip: (trip: Trip) => Promise<void>;
  /** Creates a trip from a template or past trip. Safe to retry with the same key. */
  copyTrip: (request: TripCopyRequest) => Promise<Trip>;
  updateTrip: (id: string, updates: Partial<Trip>) => Promise<void>;
  deleteTrip: (id: string) => Promise<void>;
  addExpenseToTrip: (tripId: string, expenseId: string) => Promise<void>;
  settleTrip: (id: string) => Promise<void>;
  getTrip: (id: string) => Trip | undefined;
  activeTripId: string | null;
  setActiveTripId: (id: string | null) => void;
  isTripActive: (id: string) => boolean;
  isLoading: boolean;
  isOffline: boolean;
  error: string | null;
  needsSetup: boolean;
  refresh: () => Promise<void>;
}

const TripContext = createContext<TripContextType | null>(null);
TripContext.displayName = "TripContext";

const getTripId = (trip: Trip) => trip.id;

export function TripProvider({ children }: { children: React.ReactNode }) {
  const { publicKey } = useWalletContext();
  const [activeTripId, setActiveTripId] = useState<string | null>(null);

  const { items: trips, isLoading, isOffline, error, needsSetup, refresh, mutate, wallet } =
    useRealtimeCollection<Trip>({
      table: "trips",
      cacheKey: LS_TRIPS,
      fetchAll: fetchTrips,
      fromRow: rowToTrip,
      getId: getTripId,
      connectedWallet: publicKey,
    });

  const handleSetActiveTripId = useCallback((id: string | null) => {
    setActiveTripId((prev) => {
      if (prev && prev !== id) {
        // Cancel stale polls for the previous trip before activating the new one
        cancelTripWatcher(prev);
      }
      return id;
    });
  }, []);

  const isTripActive = useCallback(
    (id: string): boolean => {
      if (!id) return false;
      if (activeTripId !== null && activeTripId !== id) return false;
      const trip = trips.find((t) => t.id === id);
      if (trip) {
        return !trip.settled;
      }
      return activeTripId === id;
    },
    [activeTripId, trips]
  );

  // Cancel all stale trip watchers and background polls when wallet changes or disconnects
  useEffect(() => {
    if (!wallet) {
      cancelAllTripWatchers();
    }
  }, [wallet]);

  /**
   * Writes go to the database first, then update local state from the row the
   * database actually stored.
   *
   * The previous version wrote to state optimistically and then hand-rolled a
   * rollback on failure, which meant a rejected write could leave the UI
   * showing a trip that does not exist. Trusting the returned row also picks up
   * the server-derived columns (member_wallets, updated_at) instead of guessing
   * them.
   */
  const addTrip = useCallback(
    async (trip: Trip) => {
      if (!wallet) throw new Error("Sign in with your wallet before creating a trip.");

      const saved = await insertTrip(trip, wallet);
      mutate((previous) =>
        previous.some((t) => t.id === saved.id) ? previous : [saved, ...previous]
      );
      invalidateQueryCaches({
        wallet,
        domains: cacheDomainsForMutation("trip_write"),
        tripId: saved.id,
      });
    },
    [wallet, mutate]
  );

  const copyTrip = useCallback(
    async (request: TripCopyRequest) => {
      if (!wallet) throw new Error("Sign in with your wallet before creating a trip.");

      const saved = await createTripFromCopyRow(request);
      // A replayed key returns the trip that already exists, so merge rather
      // than prepend to avoid a duplicate card.
      mutate((previous) =>
        previous.some((t) => t.id === saved.id)
          ? previous.map((t) => (t.id === saved.id ? saved : t))
          : [saved, ...previous]
      );
      invalidateQueryCaches({
        wallet,
        domains: cacheDomainsForMutation("trip_write"),
        tripId: saved.id,
      });
      return saved;
    },
    [wallet, mutate]
  );

  const updateTrip = useCallback(
    async (id: string, updates: Partial<Trip>) => {
      const saved = await updateTripRow(id, updates);
      mutate((previous) => previous.map((t) => (t.id === id ? saved : t)));
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation(
            updates.members ? "trip_members_write" : "trip_write",
          ),
          tripId: id,
        });
      }
    },
    [mutate, wallet]
  );

  const deleteTrip = useCallback(
    async (id: string) => {
      cancelTripWatcher(id);
      if (activeTripId === id) {
        setActiveTripId(null);
      }
      await deleteTripRow(id);
      mutate((previous) => previous.filter((t) => t.id !== id));
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("trip_write"),
          tripId: id,
        });
      }
    },
    [activeTripId, mutate, wallet]
  );

  const addExpenseToTrip = useCallback(
    async (tripId: string, expenseId: string) => {
      const expenseIds = await addExpenseIdToTrip(tripId, expenseId);
      mutate((previous) => previous.map((t) => (t.id === tripId ? { ...t, expenseIds } : t)));
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("trip_expense_link"),
          tripId,
          expenseId,
        });
      }
    },
    [mutate, wallet]
  );

  const settleTrip = useCallback(
    async (id: string) => {
      cancelTripWatcher(id);
      const saved = await updateTripRow(id, { settled: true });
      mutate((previous) => previous.map((t) => (t.id === id ? saved : t)));
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("trip_write"),
          tripId: id,
        });
      }
    },
    [mutate, wallet]
  );

  const getTrip = useCallback((id: string) => trips.find((t) => t.id === id), [trips]);

  const value = useMemo<TripContextType>(
    () => ({
      trips,
      activeTripId,
      setActiveTripId: handleSetActiveTripId,
      isTripActive,
      addTrip,
      copyTrip,
      updateTrip,
      deleteTrip,
      addExpenseToTrip,
      settleTrip,
      getTrip,
      isLoading,
      isOffline,
      error,
      needsSetup,
      refresh,
    }),
    [
      trips,
      activeTripId,
      handleSetActiveTripId,
      isTripActive,
      addTrip,
      copyTrip,
      updateTrip,
      deleteTrip,
      addExpenseToTrip,
      settleTrip,
      getTrip,
      isLoading,
      isOffline,
      error,
      needsSetup,
      refresh,
    ]
  );

  return <TripContext.Provider value={value}>{children}</TripContext.Provider>;
}

export function useTripContext(): TripContextType {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error("useTripContext must be used inside <TripProvider>");
  return ctx;
}
