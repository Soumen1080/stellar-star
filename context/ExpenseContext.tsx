"use client";

import React, { createContext, useCallback, useContext, useMemo } from "react";
import type { Expense } from "@/types/expense";
import { LS_EXPENSES } from "@/lib/utils/constants";
import {
  fetchExpenses,
  insertExpense,
  updateExpenseRow,
  deleteExpenseRow,
  detachExpenseFromTrips,
  markSharePaidRow,
  rowToExpense,
} from "@/lib/supabase/queries";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { useWalletContext } from "./WalletContext";

interface ExpenseContextType {
  expenses: Expense[];
  addExpense: (expense: Expense) => Promise<void>;
  updateExpense: (id: string, updates: Partial<Expense>) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  markSharePaid: (expenseId: string, memberId: string, txHash: string) => Promise<void>;
  getExpense: (id: string) => Expense | undefined;
  isLoading: boolean;
  isOffline: boolean;
  error: string | null;
  needsSetup: boolean;
  refresh: () => Promise<void>;
}

const ExpenseContext = createContext<ExpenseContextType | null>(null);
ExpenseContext.displayName = "ExpenseContext";

const getExpenseId = (expense: Expense) => expense.id;

export function ExpenseProvider({ children }: { children: React.ReactNode }) {
  const { publicKey } = useWalletContext();

  const { items: expenses, isLoading, isOffline, error, needsSetup, refresh, mutate, wallet } =
    useRealtimeCollection<Expense>({
      table: "expenses",
      cacheKey: LS_EXPENSES,
      fetchAll: fetchExpenses,
      fromRow: rowToExpense,
      getId: getExpenseId,
      connectedWallet: publicKey,
    });

  const addExpense = useCallback(
    async (expense: Expense) => {
      if (!wallet) throw new Error("Sign in with your wallet before adding an expense.");

      const saved = await insertExpense(expense, wallet);
      mutate((previous) =>
        previous.some((e) => e.id === saved.id) ? previous : [saved, ...previous]
      );
    },
    [wallet, mutate]
  );

  const updateExpense = useCallback(
    async (id: string, updates: Partial<Expense>) => {
      const baseExpense = expenses.find((e) => e.id === id);
      const saved = await updateExpenseRow(id, updates, baseExpense);
      mutate((previous) => previous.map((e) => (e.id === id ? saved : e)));
    },
    [expenses, mutate]
  );

  const deleteExpense = useCallback(
    async (id: string) => {
      // Unlink first: if the delete succeeds but the unlink does not, trips are
      // left pointing at an expense that no longer exists.
      await detachExpenseFromTrips(id);
      await deleteExpenseRow(id);
      mutate((previous) => previous.filter((e) => e.id !== id));
    },
    [mutate]
  );

  /**
   * Records an on-chain payment against a member's share.
   *
   * Never optimistic: the Stellar transaction has already settled by the time
   * this runs, so showing "paid" before the database agrees would hide a
   * genuine bookkeeping failure the user needs to know about. `markSharePaidRow`
   * re-reads the shares immediately before writing, so a payment made
   * concurrently by another member is not clobbered.
   */
  const markSharePaid = useCallback(
    async (expenseId: string, memberId: string, txHash: string) => {
      const saved = await markSharePaidRow(expenseId, memberId, txHash);
      mutate((previous) => previous.map((e) => (e.id === expenseId ? saved : e)));
    },
    [mutate]
  );

  const getExpense = useCallback((id: string) => expenses.find((e) => e.id === id), [expenses]);

  const value = useMemo<ExpenseContextType>(
    () => ({
      expenses,
      addExpense,
      updateExpense,
      deleteExpense,
      markSharePaid,
      getExpense,
      isLoading,
      isOffline,
      error,
      needsSetup,
      refresh,
    }),
    [
      expenses,
      addExpense,
      updateExpense,
      deleteExpense,
      markSharePaid,
      getExpense,
      isLoading,
      isOffline,
      error,
      needsSetup,
      refresh,
    ]
  );

  return <ExpenseContext.Provider value={value}>{children}</ExpenseContext.Provider>;
}

export function useExpenseContext(): ExpenseContextType {
  const ctx = useContext(ExpenseContext);
  if (!ctx) throw new Error("useExpenseContext must be used within <ExpenseProvider />");
  return ctx;
}
