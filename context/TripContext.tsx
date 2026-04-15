"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Trip } from "@/types/trip";
import { LS_TRIPS } from "@/lib/utils/constants";
import { supabase, createAuthenticatedClient, isSupabaseConfigured } from "@/lib/supabase/client";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { useWalletContext } from "./WalletContext";


interface TripContextType {
  trips: Trip[];
  addTrip: (trip: Trip) => void;
  updateTrip: (id: string, updates: Partial<Trip>) => void;
  deleteTrip: (id: string) => void;
  addExpenseToTrip: (tripId: string, expenseId: string) => void;
  settleTrip: (id: string) => void;
  getTrip: (id: string) => Trip | undefined;
  isLoading: boolean;
}


const TripContext = createContext<TripContextType | null>(null);
TripContext.displayName = "TripContext";


function dbRowToTrip(row: any): Trip {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    members: row.members,
    expenseIds: row.expense_ids,
    createdAt: row.created_at,
    settled: row.settled,
  };
}

function tripToDbRow(trip: Trip, creatorWallet: string) {
  const memberWallets = trip.members
    .map((m) => m.walletAddress)
    .filter((addr): addr is string => !!addr);

  const allMemberWallets = creatorWallet && !memberWallets.includes(creatorWallet)
    ? [creatorWallet, ...memberWallets]
    : memberWallets;

  return {
    id: trip.id,
    name: trip.name,
    description: trip.description ?? null,
    members: trip.members,
    expense_ids: trip.expenseIds,
    created_at: trip.createdAt,
    settled: trip.settled,
    created_by_wallet: creatorWallet,
    member_wallets: allMemberWallets,
  };
}


export function TripProvider({ children }: { children: React.ReactNode }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const channelRef = useRef<any>(null);
  const { publicKey } = useWalletContext();

  const getClient = useCallback(() => {
    if (!isSupabaseConfigured() || !supabase) {
      throw new Error("Supabase is not configured.");
    }
    return publicKey ? createAuthenticatedClient(publicKey) : supabase;
  }, [publicKey]);

  useEffect(() => {
    let isMounted = true;

    async function loadTrips() {
      try {
        if (!isSupabaseConfigured()) throw new Error("Supabase not configured");
        const client = getClient();
        const { data, error } = await client
          .from("trips")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;

        if (isMounted && data) {
          const trips = data.map(dbRowToTrip);
          setTrips(trips);
          localStorage.setItem(LS_TRIPS, JSON.stringify(trips));
        }
      } catch (err) {
        console.warn("Failed to load trips from Supabase, using localStorage:", err);
        try {
          const raw = localStorage.getItem(LS_TRIPS);
          if (raw && isMounted) {
            setTrips(JSON.parse(raw) as Trip[]);
          }
        } catch {
          // ignore
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadTrips();

    return () => {
      isMounted = false;
    };
  }, [getClient]);


  useEffect(() => {
    if (isLoading || !supabase) return;

    const channel = supabase
      .channel("trips-changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trips" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const newTrip = dbRowToTrip(payload.new);
          setTrips((prev) => {
            if (prev.some((t) => t.id === newTrip.id)) return prev;
            const updated = [newTrip, ...prev];
            localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "trips" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const updatedTrip = dbRowToTrip(payload.new);
          setTrips((prev) => {
            const updated = prev.map((t) =>
              t.id === updatedTrip.id ? updatedTrip : t
            );
            localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "trips" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const deletedId = (payload.old as any)?.id;
          if (!deletedId) return;
          setTrips((prev) => {
            const updated = prev.filter((t) => t.id !== deletedId);
            localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe();
    };
  }, [isLoading]);

  const addTrip = useCallback(async (trip: Trip) => {
    if (!publicKey) throw new Error("Wallet not connected");

    setTrips((prev) => {
      const updated = [trip, ...prev];
      localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
      return updated;
    });

    // Persist to Supabase — throw on failure so the caller can handle it
    const client = getClient();
    const { error } = await client
      .from("trips")
      .insert([tripToDbRow(trip, publicKey)]);

    if (error) {
      setTrips((prev) => {
        const rolled = prev.filter((t) => t.id !== trip.id);
        localStorage.setItem(LS_TRIPS, JSON.stringify(rolled));
        return rolled;
      });
      throw error;
    }
  }, [getClient, publicKey]);

  const updateTrip = useCallback(
    async (id: string, updates: Partial<Trip>) => {
      try {
        const current = trips.find((t) => t.id === id);
        if (!current) return;

        const merged = { ...current, ...updates };
        const dbRow = tripToDbRow(merged, publicKey || '');

        const client = getClient();
        const { error } = await client
          .from("trips")
          .update(dbRow)
          .eq("id", id);

        if (error) throw error;

        setTrips((prev) => {
          const updated = prev.map((t) => (t.id === id ? merged : t));
          localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
          return updated;
        });
      } catch (err) {
        console.error("Failed to update trip in Supabase:", err);
        setTrips((prev) => {
          const updated = prev.map((t) =>
            t.id === id ? { ...t, ...updates } : t
          );
          localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
          return updated;
        });
      }
    },
    [trips, getClient, publicKey]
  );

  const deleteTrip = useCallback(async (id: string) => {
    try {
      const client = getClient();
      const { error } = await client.from("trips").delete().eq("id", id);

      if (error) throw error;

      setTrips((prev) => {
        const updated = prev.filter((t) => t.id !== id);
        localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
        return updated;
      });
    } catch (err) {
      console.error("Failed to delete trip from Supabase:", err);
      setTrips((prev) => {
        const updated = prev.filter((t) => t.id !== id);
        localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
        return updated;
      });
    }
  }, [getClient]);

  const addExpenseToTrip = useCallback(
    async (tripId: string, expenseId: string) => {
      try {
        const current = trips.find((t) => t.id === tripId);
        if (!current || current.expenseIds.includes(expenseId)) return;

        const expenseIds = [...current.expenseIds, expenseId];

        const client = getClient();
        const { error } = await client
          .from("trips")
          .update({ expense_ids: expenseIds })
          .eq("id", tripId);

        if (error) throw error;

        setTrips((prev) => {
          const updated = prev.map((t) =>
            t.id === tripId ? { ...t, expenseIds } : t
          );
          localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
          return updated;
        });
      } catch (err) {
        console.error("Failed to add expense to trip in Supabase:", err);
        setTrips((prev) => {
          const updated = prev.map((t) =>
            t.id === tripId && !t.expenseIds.includes(expenseId)
              ? { ...t, expenseIds: [...t.expenseIds, expenseId] }
              : t
          );
          localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
          return updated;
        });
      }
    },
    [trips, getClient]
  );

  const settleTrip = useCallback(async (id: string) => {
    try {
      const client = getClient();
      const { error } = await client
        .from("trips")
        .update({ settled: true })
        .eq("id", id);

      if (error) throw error;

      setTrips((prev) => {
        const updated = prev.map((t) => (t.id === id ? { ...t, settled: true } : t));
        localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
        return updated;
      });
    } catch (err) {
      console.error("Failed to settle trip in Supabase:", err);
      setTrips((prev) => {
        const updated = prev.map((t) => (t.id === id ? { ...t, settled: true } : t));
        localStorage.setItem(LS_TRIPS, JSON.stringify(updated));
        return updated;
      });
    }
  }, [getClient]);

  const getTrip = useCallback(
    (id: string) => trips.find((t) => t.id === id),
    [trips]
  );

  return (
    <TripContext.Provider
      value={{
        trips,
        addTrip,
        updateTrip,
        deleteTrip,
        addExpenseToTrip,
        settleTrip,
        getTrip,
        isLoading,
      }}
    >
      {children}
    </TripContext.Provider>
  );
}

export function useTripContext(): TripContextType {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error("useTripContext must be used inside <TripProvider>");
  return ctx;
}
