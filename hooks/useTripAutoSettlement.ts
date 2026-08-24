"use client";

import { useEffect, useRef } from "react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

/**
 * Marks a trip settled once every expense linked to it is settled.
 *
 * `settleTrip` writes to the database and rejects on failure, so the rejection
 * is handled here: an effect cannot await, and an unhandled rejection would
 * surface as a console error with no user-visible consequence.
 *
 * The attempt is also recorded per trip id, so a trip that fails to settle is
 * not retried on every render — the next successful load will re-evaluate it.
 */
export function useTripAutoSettlement(
  trip: Trip | undefined,
  expenses: Expense[],
  settleTrip: (id: string) => void | Promise<void>,
) {
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!trip || trip.settled) return;

    const linkedExpenses = expenses.filter((expense) => trip.expenseIds.includes(expense.id));
    if (linkedExpenses.length === 0 || !linkedExpenses.every((expense) => expense.settled)) {
      return;
    }

    if (attemptedRef.current === trip.id) return;
    attemptedRef.current = trip.id;

    Promise.resolve(settleTrip(trip.id)).catch((err) => {
      // Allow a later render to try again once the cause clears.
      attemptedRef.current = null;
      console.error("Failed to auto-settle trip:", err);
    });
  }, [expenses, trip, settleTrip]);
}
