"use client";

import React, { createContext, useCallback, useContext, useMemo } from "react";
import type { Trip } from "@/types/trip";
import { LS_TRIPS } from "@/lib/utils/constants";
import {
  fetchTrips,
  insertTrip,
  updateTripRow,
  deleteTripRow,
  addExpenseIdToTrip,
  rowToTrip,
} from "@/lib/supabase/queries";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { useWalletContext } from "./WalletContext";

interface TripContextType {
  trips: Trip[];
  addTrip: (trip: Trip) => Promise<void>;
  updateTrip: (id: string, updates: Partial<Trip>) => Promise<void>;
  deleteTrip: (id: string) => Promise<void>;
  addExpenseToTrip: (tripId: string, expenseId: string) => Promise<void>;
  settleTrip: (id: string) => Promise<void>;
  getTrip: (id: string) => Trip | undefined;
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

  const { items: trips, isLoading, isOffline, error, needsSetup, refresh, mutate, wallet } =
    useRealtimeCollection<Trip>({
      table: "trips",
      cacheKey: LS_TRIPS,
      fetchAll: fetchTrips,
      fromRow: rowToTrip,
      getId: getTripId,
      connectedWallet: publicKey,
    });

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
    },
    [wallet, mutate]
  );

  const updateTrip = useCallback(
    async (id: string, updates: Partial<Trip>) => {
      const saved = await updateTripRow(id, updates);
      mutate((previous) => previous.map((t) => (t.id === id ? saved : t)));
    },
    [mutate]
  );

  const deleteTrip = useCallback(
    async (id: string) => {
      await deleteTripRow(id);
      mutate((previous) => previous.filter((t) => t.id !== id));
    },
    [mutate]
  );

  const addExpenseToTrip = useCallback(
    async (tripId: string, expenseId: string) => {
      const expenseIds = await addExpenseIdToTrip(tripId, expenseId);
      mutate((previous) => previous.map((t) => (t.id === tripId ? { ...t, expenseIds } : t)));
    },
    [mutate]
  );

  const settleTrip = useCallback(
    async (id: string) => {
      const saved = await updateTripRow(id, { settled: true });
      mutate((previous) => previous.map((t) => (t.id === id ? saved : t)));
    },
    [mutate]
  );

  const getTrip = useCallback((id: string) => trips.find((t) => t.id === id), [trips]);

  const value = useMemo<TripContextType>(
    () => ({
      trips,
      addTrip,
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
      addTrip,
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
