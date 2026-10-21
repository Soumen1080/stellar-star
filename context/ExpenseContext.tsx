"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Expense } from "@/types/expense";
import { LS_EXPENSES } from "@/lib/utils/constants";
import { useToast } from "@/components/ui/Toast";
import {
  fetchExpenses,
  updateExpenseRow,
  deleteExpenseRow,
  detachExpenseFromTrips,
  markSharePaidRow,
  recordShareInstallmentRow,
  cacheDomainsForMutation,
  rowToExpense,
} from "@/lib/supabase/queries";
import { useRealtimeCollection } from "@/lib/supabase/useRealtimeCollection";
import { invalidateQueryCaches } from "@/lib/supabase/cacheInvalidation";
import { useWalletContext } from "./WalletContext";
import type { NewInstallment } from "@/lib/settlement/installments";
import { useAccessToken } from "@/lib/supabase/useSession";
import { enqueueExpenseDraft, readExpenseDrafts, removeExpenseDraft, updateExpenseDraft, type ExpenseDraft } from "@/lib/offline/expenseDrafts";

interface ExpenseContextType {
  expenses: Expense[];
  addExpense: (expense: Expense) => Promise<{ queued: boolean }>;
  expenseDrafts: ExpenseDraft[];
  syncExpenseDrafts: () => Promise<void>;
  discardExpenseDraft: (idempotencyKey: string) => void;
  updateExpense: (id: string, updates: Partial<Expense>) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  markSharePaid: (expenseId: string, memberId: string, txHash: string) => Promise<void>;
  /** Appends one partial payment to a share; the share is paid only once fully covered. */
  recordShareInstallment: (
    expenseId: string,
    memberId: string,
    installment: NewInstallment,
  ) => Promise<Expense>;
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
  const accessToken = useAccessToken();

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
  const [expenseDrafts, setExpenseDrafts] = useState<ExpenseDraft[]>([]);
  const syncingDraftsRef = useRef(false);

  useEffect(() => {
    setExpenseDrafts(wallet ? readExpenseDrafts(wallet) : []);
  }, [wallet]);

  const syncExpenseDrafts = useCallback(async () => {
    if (!wallet || !accessToken || !navigator.onLine || syncingDraftsRef.current) return;
    syncingDraftsRef.current = true;
    const current = readExpenseDrafts(wallet);
    try {
      for (const draft of current) {
        if (draft.status === "conflict") continue;
        try {
        const response = await fetch("/api/expenses", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, "Idempotency-Key": draft.idempotencyKey },
          body: JSON.stringify(draft.expense),
        });
        if (response.status === 409) {
          const body = await response.json().catch(() => ({}));
          if (body.code === "IDEMPOTENCY_IN_PROGRESS") continue;
          setExpenseDrafts(updateExpenseDraft(wallet, draft.idempotencyKey, { status: "conflict", message: body.error || "This draft conflicts with a server change. Review it before retrying." }));
          continue;
        }
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500) {
            const body = await response.json().catch(() => ({}));
            setExpenseDrafts(updateExpenseDraft(wallet, draft.idempotencyKey, { status: "conflict", message: body.error || "The server rejected this draft. Review it before retrying." }));
          }
          continue;
        }
        const saved = await response.json() as Expense;
        mutate((previous) => [saved, ...previous.filter((item) => item.id !== draft.expense.id && item.id !== saved.id)]);
        setExpenseDrafts(removeExpenseDraft(wallet, draft.idempotencyKey));
        invalidateQueryCaches({ wallet, domains: cacheDomainsForMutation("expense_write"), expenseId: saved.id });
        } catch { /* Retain the queue item for the next online event. */ }
      }
    } finally { syncingDraftsRef.current = false; }
  }, [accessToken, mutate, wallet]);

  useEffect(() => {
    if (!wallet || !accessToken) return;
    const onOnline = () => { void syncExpenseDrafts(); };
    window.addEventListener("online", onOnline);
    if (navigator.onLine) void syncExpenseDrafts();
    return () => window.removeEventListener("online", onOnline);
  }, [accessToken, syncExpenseDrafts, wallet]);

  const addExpense = useCallback(
    async (expense: Expense) => {
      if (!wallet) throw new Error("Sign in with your wallet before adding an expense.");
      const queued = enqueueExpenseDraft(wallet, expense);
      const draft = queued.find((item) => item.expense.id === expense.id);
      if (!draft) throw new Error("Could not save an offline-safe expense draft in this browser.");
      setExpenseDrafts(queued);
      mutate((previous) => previous.some((e) => e.id === expense.id) ? previous : [expense, ...previous]);
      if (!navigator.onLine) return { queued: true };
      try {
        await syncExpenseDrafts();
        const remaining = readExpenseDrafts(wallet).find((item) => item.idempotencyKey === draft.idempotencyKey);
        return { queued: Boolean(remaining) };
      } catch {
        return { queued: true };
      }
    },
    [wallet, mutate, syncExpenseDrafts]
  );

  const discardExpenseDraft = useCallback((idempotencyKey: string) => {
    if (!wallet) return;
    const existing = readExpenseDrafts(wallet).find((draft) => draft.idempotencyKey === idempotencyKey);
    setExpenseDrafts(removeExpenseDraft(wallet, idempotencyKey));
    if (existing) mutate((previous) => previous.filter((expense) => expense.id !== existing.expense.id));
  }, [mutate, wallet]);

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

  /**
   * Records one installment against a share (#325). Never optimistic, for the
   * same reason as `markSharePaid`; the RPC re-checks the remaining balance.
   */
  const recordShareInstallment = useCallback(
    async (expenseId: string, memberId: string, installment: NewInstallment) => {
      const saved = await recordShareInstallmentRow(expenseId, memberId, installment);
      mutate((previous) => previous.map((e) => (e.id === expenseId ? saved : e)));
      if (wallet) {
        invalidateQueryCaches({
          wallet,
          domains: cacheDomainsForMutation("expense_write"),
          expenseId,
        });
      }
      return saved;
    },
    [mutate, wallet]
  );

  const getExpense = useCallback((id: string) => expensesRef.current.find((e) => e.id === id), []);

  const value = useMemo<ExpenseContextType>(
    () => ({
      expenses,
      addExpense,
      expenseDrafts,
      syncExpenseDrafts,
      discardExpenseDraft,
      updateExpense,
      deleteExpense,
      markSharePaid,
      recordShareInstallment,
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
      expenseDrafts,
      syncExpenseDrafts,
      discardExpenseDraft,
      updateExpense,
      deleteExpense,
      markSharePaid,
      recordShareInstallment,
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
