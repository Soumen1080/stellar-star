"use client";

import { useCallback, useEffect, useState } from "react";
import type { Trip } from "@/types/trip";
import {
  createEmptyWorkspace,
  normalizeWorkspace,
  type BookingReference,
  type ChecklistItem,
  type ChoreCadence,
  type RecurringChore,
  type ItineraryItem,
  type TravelWorkspace,
  choreCompletedThisPeriod,
  currentChoreAssignee,
} from "@/types/workspace";
import { useTrip } from "@/hooks/useTrip";
import { useToast } from "@/components/ui/Toast";
import { useWalletContext } from "@/context/WalletContext";
import { memberRole } from "@/lib/trip/roles";

const getCacheKey = (tripId: string, wallet: string = "anonymous") => `stellar_star_workspace:${wallet}:${tripId}`;

export function useWorkspace(trip: Trip) {
  const { updateTrip, appendChoreCompletion } = useTrip();
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
      try {
        await updateTrip(trip.id, { workspace: withTimestamp });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Please try again.";
        toastError("Could not save travel workspace", reason);
        const persistenceError = error instanceof Error ? error : new Error(reason);
        persistenceError.name = "WorkspacePersistenceError";
        throw persistenceError;
      }

      setWorkspace(withTimestamp);
      if (typeof window !== "undefined" && publicKey) {
        try {
          localStorage.setItem(getCacheKey(trip.id, publicKey), JSON.stringify(withTimestamp));
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Local storage is unavailable.";
          toastError("Workspace saved, but local cache could not be updated", reason);
        }
      }
    },
    [trip.id, updateTrip, publicKey, toastError]
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

  // ─── Chore coordination (kept separate from expenses and settlement) ────────

  const addChore = useCallback(
    async (input: {
      title: string;
      cadence: ChoreCadence;
      rotationMemberIds: string[];
      linkedExpenseId?: string | null;
    }) => {
      if (!publicKey) throw new Error("Sign in with your wallet to add a chore.");
      const creator = trip.members.find(
        (member) => member.walletAddress?.trim().toUpperCase() === publicKey.trim().toUpperCase(),
      );
      if (!creator || memberRole(creator, trip) !== "owner") {
        throw new Error("Only the trip owner can add chores.");
      }
      const chore: RecurringChore = {
        ...input,
        id: crypto.randomUUID ? crypto.randomUUID() : `chore-${Date.now()}`,
        tripId: trip.id,
        rotationMemberIds: [...new Set(input.rotationMemberIds)],
        completionHistory: [],
        createdByWallet: publicKey,
        createdAt: new Date().toISOString(),
      };
      const next = { ...workspace, chores: [...workspace.chores, chore] };
      await saveWorkspace(next);
      toastSuccess("Recurring chore added", chore.title);
      return chore;
    },
    [trip, workspace, saveWorkspace, publicKey, toastSuccess]
  );

  const completeChore = useCallback(
    async (choreId: string) => {
      if (!publicKey) throw new Error("Sign in with your wallet to complete a chore.");
      if (workspace.choreOptOutWallets.includes(publicKey.toUpperCase())) {
        throw new Error("Opt back in to chore coordination before completing chores.");
      }
      const chore = workspace.chores.find((item) => item.id === choreId);
      if (!chore) throw new Error("This chore no longer exists.");
      if (choreCompletedThisPeriod(chore)) {
        throw new Error("This chore is already marked complete for this period.");
      }
      const optedOutMemberIds = trip.members
        .filter((member) =>
          member.walletAddress &&
          workspace.choreOptOutWallets.includes(member.walletAddress.trim().toUpperCase())
        )
        .map((member) => member.id);
      const assignedMemberId = currentChoreAssignee(chore, optedOutMemberIds);
      if (!assignedMemberId) throw new Error("Assign at least one member to this chore.");
      const completingMember = trip.members.find(
        (member) => member.walletAddress?.trim().toUpperCase() === publicKey.trim().toUpperCase(),
      );
      if (!completingMember || completingMember.id !== assignedMemberId) {
        throw new Error("Only the currently assigned member can complete this chore.");
      }

      const savedTrip = await appendChoreCompletion(trip.id, choreId);
      setWorkspace(normalizeWorkspace(savedTrip.workspace));
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(
            getCacheKey(trip.id, publicKey),
            JSON.stringify(normalizeWorkspace(savedTrip.workspace)),
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Local storage is unavailable.";
          toastError("Chore completed, but local cache could not be updated", reason);
        }
      }
      toastSuccess("Chore completed", "This does not record or change a payment.");
    },
    [workspace, appendChoreCompletion, publicKey, toastSuccess, toastError, trip.id, trip.members]
  );

  const toggleChoreOptOut = useCallback(async () => {
    if (!publicKey) throw new Error("Sign in with your wallet to change this preference.");
    const wallet = publicKey.trim().toUpperCase();
    const optedOut = workspace.choreOptOutWallets.includes(wallet);
    await saveWorkspace({
      ...workspace,
      choreOptOutWallets: optedOut
        ? workspace.choreOptOutWallets.filter((item) => item !== wallet)
        : [...workspace.choreOptOutWallets, wallet],
    });
  }, [workspace, saveWorkspace, publicKey]);

  const setChoresEnabled = useCallback(
    async (enabled: boolean) => {
      if (!publicKey) throw new Error("Sign in with your wallet to change chore coordination.");
      const currentMember = trip.members.find(
        (member) => member.walletAddress?.trim().toUpperCase() === publicKey.trim().toUpperCase(),
      );
      if (!currentMember || memberRole(currentMember, trip) !== "owner") {
        throw new Error("Only the trip owner can change chore coordination.");
      }
      await saveWorkspace({ ...workspace, choresEnabled: enabled });
    },
    [workspace, saveWorkspace, publicKey, trip]
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
    addChore,
    completeChore,
    toggleChoreOptOut,
    setChoresEnabled,
    addBookingReference,
    updateBookingReference,
    deleteBookingReference,
    purgeWorkspace,
  };
}
