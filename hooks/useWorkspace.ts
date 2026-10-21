"use client";

import { useCallback, useEffect, useState } from "react";
import type { Trip } from "@/types/trip";
import {
  createEmptyWorkspace,
  normalizeWorkspace,
  type BookingReference,
  type ChecklistItem,
  type ItineraryItem,
  type TravelWorkspace,
} from "@/types/workspace";
import { useTrip } from "@/hooks/useTrip";
import { useToast } from "@/components/ui/Toast";
import { useWalletContext } from "@/context/WalletContext";

const getCacheKey = (tripId: string, wallet: string) => `stellar_star_workspace:${wallet}:${tripId}`;

export function useWorkspace(trip: Trip) {
  const { updateTrip } = useTrip();
  const { success: toastSuccess, error: toastError } = useToast();
  const { publicKey } = useWalletContext();

  const [workspace, setWorkspace] = useState<TravelWorkspace>(() => {
    if (trip.workspace) {
      return normalizeWorkspace(trip.workspace);
    }
    // Try localStorage cache
    if (typeof window !== "undefined") {
      try {
        const cached = publicKey ? localStorage.getItem(getCacheKey(trip.id, publicKey)) : null;
        if (cached) return normalizeWorkspace(JSON.parse(cached));
      } catch {
        // ignore parse error
      }
    }
    return createEmptyWorkspace();
  });

  // Sync state if trip.workspace updates from database
  useEffect(() => {
    if (trip.workspace) {
      const normalized = normalizeWorkspace(trip.workspace);
      setWorkspace(normalized);
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(getCacheKey(trip.id), JSON.stringify(normalized));
        } catch {
          // ignore cache write error
        }
      }
    } else {
      let cachedWorkspace: TravelWorkspace | null = null;
      if (publicKey) {
        try {
          const cached = localStorage.getItem(getCacheKey(trip.id, publicKey));
          if (cached) cachedWorkspace = normalizeWorkspace(JSON.parse(cached));
        } catch { /* Ignore malformed wallet-scoped cache entries. */ }
      }
      setWorkspace(cachedWorkspace ?? createEmptyWorkspace());
    }
  }, [trip.id, trip.workspace, publicKey]);

  const saveWorkspace = useCallback(
    async (next: TravelWorkspace) => {
      const withTimestamp: TravelWorkspace = {
        ...next,
        updatedAt: new Date().toISOString(),
      };
      setWorkspace(withTimestamp);

      if (typeof window !== "undefined") {
        try {
          if (publicKey) localStorage.setItem(getCacheKey(trip.id, publicKey), JSON.stringify(withTimestamp));
        } catch {
          // ignore
        }
      }

      try {
        await updateTrip(trip.id, { workspace: withTimestamp });
      } catch (err) {
        console.warn("Failed to persist workspace to remote server, saved locally:", err);
      }
    },
    [trip.id, updateTrip, publicKey]
  );

  // ─── Itinerary actions ────────────────────────────────────────────────────────

  const addItineraryItem = useCallback(
    async (item: Omit<ItineraryItem, "id" | "tripId" | "createdAt">) => {
      const newItem: ItineraryItem = {
        ...item,
        id: crypto.randomUUID ? crypto.randomUUID() : `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tripId: trip.id,
        createdAt: new Date().toISOString(),
      };

      const next: TravelWorkspace = {
        ...workspace,
        itinerary: [...workspace.itinerary, newItem],
      };
      await saveWorkspace(next);
      toastSuccess("Added to itinerary", newItem.title);
      return newItem;
    },
    [trip.id, workspace, saveWorkspace, toastSuccess]
  );

  const updateItineraryItem = useCallback(
    async (itemId: string, updates: Partial<ItineraryItem>) => {
      const next: TravelWorkspace = {
        ...workspace,
        itinerary: workspace.itinerary.map((it) =>
          it.id === itemId ? { ...it, ...updates, updatedAt: new Date().toISOString() } : it
        ),
      };
      await saveWorkspace(next);
      toastSuccess("Itinerary updated");
    },
    [workspace, saveWorkspace, toastSuccess]
  );

  const deleteItineraryItem = useCallback(
    async (itemId: string) => {
      const next: TravelWorkspace = {
        ...workspace,
        itinerary: workspace.itinerary.filter((it) => it.id !== itemId),
      };
      await saveWorkspace(next);
      toastSuccess("Item removed");
    },
    [workspace, saveWorkspace, toastSuccess]
  );

  // ─── Checklist actions ────────────────────────────────────────────────────────

  const addChecklistItem = useCallback(
    async (item: Omit<ChecklistItem, "id" | "tripId" | "createdAt">) => {
      const newItem: ChecklistItem = {
        ...item,
        id: crypto.randomUUID ? crypto.randomUUID() : `chk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tripId: trip.id,
        createdAt: new Date().toISOString(),
      };

      const next: TravelWorkspace = {
        ...workspace,
        checklists: [...workspace.checklists, newItem],
      };
      await saveWorkspace(next);
      toastSuccess("Added task", newItem.title);
      return newItem;
    },
    [trip.id, workspace, saveWorkspace, toastSuccess]
  );

  const toggleChecklistItem = useCallback(
    async (itemId: string) => {
      const next: TravelWorkspace = {
        ...workspace,
        checklists: workspace.checklists.map((c) =>
          c.id === itemId ? { ...c, isCompleted: !c.isCompleted } : c
        ),
      };
      await saveWorkspace(next);
    },
    [workspace, saveWorkspace]
  );

  const updateChecklistItem = useCallback(
    async (itemId: string, updates: Partial<ChecklistItem>) => {
      const next: TravelWorkspace = {
        ...workspace,
        checklists: workspace.checklists.map((c) =>
          c.id === itemId ? { ...c, ...updates } : c
        ),
      };
      await saveWorkspace(next);
    },
    [workspace, saveWorkspace]
  );

  const deleteChecklistItem = useCallback(
    async (itemId: string) => {
      const next: TravelWorkspace = {
        ...workspace,
        checklists: workspace.checklists.filter((c) => c.id !== itemId),
      };
      await saveWorkspace(next);
    },
    [workspace, saveWorkspace]
  );

  // ─── Booking reference actions ────────────────────────────────────────────────

  const addBookingReference = useCallback(
    async (booking: Omit<BookingReference, "id" | "tripId" | "createdAt">) => {
      const newBooking: BookingReference = {
        ...booking,
        id: crypto.randomUUID ? crypto.randomUUID() : `book-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        tripId: trip.id,
        createdAt: new Date().toISOString(),
      };

      const next: TravelWorkspace = {
        ...workspace,
        bookings: [...workspace.bookings, newBooking],
      };
      await saveWorkspace(next);
      toastSuccess("Booking added", newBooking.title);
      return newBooking;
    },
    [trip.id, workspace, saveWorkspace, toastSuccess]
  );

  const updateBookingReference = useCallback(
    async (bookingId: string, updates: Partial<BookingReference>) => {
      const next: TravelWorkspace = {
        ...workspace,
        bookings: workspace.bookings.map((b) =>
          b.id === bookingId ? { ...b, ...updates, updatedAt: new Date().toISOString() } : b
        ),
      };
      await saveWorkspace(next);
      toastSuccess("Booking updated");
    },
    [workspace, saveWorkspace, toastSuccess]
  );

  const deleteBookingReference = useCallback(
    async (bookingId: string) => {
      const next: TravelWorkspace = {
        ...workspace,
        bookings: workspace.bookings.filter((b) => b.id !== bookingId),
      };
      await saveWorkspace(next);
      toastSuccess("Booking removed");
    },
    [workspace, saveWorkspace, toastSuccess]
  );

  // ─── Purge travel-only content ────────────────────────────────────────────────

  const purgeWorkspace = useCallback(async () => {
    const empty = createEmptyWorkspace();
    await saveWorkspace(empty);
    toastSuccess("Travel content deleted", "Expenses and trip balances remain intact.");
  }, [saveWorkspace, toastSuccess]);

  return {
    workspace,
    addItineraryItem,
    updateItineraryItem,
    deleteItineraryItem,
    addChecklistItem,
    toggleChecklistItem,
    updateChecklistItem,
    deleteChecklistItem,
    addBookingReference,
    updateBookingReference,
    deleteBookingReference,
    purgeWorkspace,
  };
}
