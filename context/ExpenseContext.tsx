"use client";

import React, { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { Expense } from "@/types/expense";
import { LS_EXPENSES } from "@/lib/utils/constants";
import { useToast } from "@/components/ui/Toast";
import {
  fetchExpenses,
  insertExpense,
  updateExpenseRow,
  deleteExpenseRow,
  detachExpenseFromTrips,
  markSharePaidRow,
  cacheDomainsForMutation,
  rowToExpense,
} from "@/lib/supabase/queries";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { invalidateQueryCaches } from "@/lib/supabase/cacheInvalidation";
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
  const { error: toastError } = useToast();

  const { items: expenses, isLoading, isOffline, error, needsSetup, refresh, mutate, wallet } =
    useRealtimeCollection<Expense>({
      table: "expenses",
      cacheKey: LS_EXPENSES,
      fetchAll: fetchExpenses,
      fromRow: rowToExpense,
      getId: getExpenseId,
      connectedWallet: publicKey,
    });

  const expensesRef = useRef(expenses);
  expensesRef.current = expenses;

  const addExpense = useCallback(
    async (expense: Expense) => {
      if (!wallet) throw new Error("Sign in with your wallet before adding an expense.");

      mutate((previous) =>
        previous.some((e) => e.id === expense.id) ? previous : [expense, ...previous]
      );

      try {
        const saved = await insertExpense(expense, wallet);
        mutate((previous) =>
          previous.map((e) => (e.id === saved.id ? saved : e))
        );
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("expense_write"),
          expenseId: saved.id,
        });
      } catch (err: any) {
        mutate((previous) => previous.filter((e) => e.id !== expense.id));
        toastError("Failed to add expense", "An error occurred while saving.");
        throw err;
      }
    },
    [wallet, mutate, toastError]
  );

  const updateExpense = useCallback(
    async (id: string, updates: Partial<Expense>) => {
      const baseExpense = expensesRef.current.find((e) => e.id === id);
      const saved = await updateExpenseRow(id, updates, baseExpense);
      mutate((previous) => previous.map((e) => (e.id === id ? saved : e)));
    },
    [mutate]
  );

  const deleteExpense = useCallback(
    async (id: string) => {
      const snapshot = expenses.find((e) => e.id === id);
      if (!snapshot) return;

      mutate((previous) => previous.filter((e) => e.id !== id));

      try {
        // Unlink first: if the delete succeeds but the unlink does not, trips are
        // left pointing at an expense that no longer exists.
        await detachExpenseFromTrips(id);
        await deleteExpenseRow(id);
        if (wallet) {
          invalidateQueryCaches({
            wallet,
            domains: cacheDomainsForMutation("expense_write"),
            expenseId: id,
          });
        }
      } catch (err: any) {
        mutate((previous) => {
          if (previous.some((e) => e.id === id)) return previous;
          return [...previous, snapshot];
        });
        toastError("Failed to delete expense", "Reverting to previous state.");
        throw err;
      }
    },
    [expenses, mutate, toastError, wallet]
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
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("expense_write"),
          expenseId,
        });
      }
    },
    [mutate, wallet]
  );

  const getExpense = useCallback((id: string) => expensesRef.current.find((e) => e.id === id), []);

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
