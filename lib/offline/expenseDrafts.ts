import type { Expense } from "@/types/expense";

export type ExpenseDraftStatus = "queued" | "conflict";
export interface ExpenseDraft {
  idempotencyKey: string;
  expense: Expense;
  status: ExpenseDraftStatus;
  message?: string;
  queuedAt: string;
}

const queueKey = (wallet: string) => `StellarStar:expense-drafts:${wallet}`;

export function readExpenseDrafts(wallet: string): ExpenseDraft[] {
  try {
    const value = JSON.parse(localStorage.getItem(queueKey(wallet)) || "[]");
    return Array.isArray(value) ? value as ExpenseDraft[] : [];
  } catch { return []; }
}

function writeExpenseDrafts(wallet: string, drafts: ExpenseDraft[]): void {
  try {
    if (drafts.length) localStorage.setItem(queueKey(wallet), JSON.stringify(drafts));
    else localStorage.removeItem(queueKey(wallet));
  } catch { /* A full or disabled storage area must not fake a queued draft. */ }
}

export function enqueueExpenseDraft(wallet: string, expense: Expense): ExpenseDraft[] {
  const drafts = readExpenseDrafts(wallet);
  if (!drafts.some((draft) => draft.expense.id === expense.id)) {
    drafts.push({ idempotencyKey: crypto.randomUUID(), expense, status: "queued", queuedAt: new Date().toISOString() });
    writeExpenseDrafts(wallet, drafts);
  }
  return readExpenseDrafts(wallet);
}

export function updateExpenseDraft(wallet: string, idempotencyKey: string, updates: Partial<ExpenseDraft>): ExpenseDraft[] {
  const drafts = readExpenseDrafts(wallet).map((draft) => draft.idempotencyKey === idempotencyKey ? { ...draft, ...updates } : draft);
  writeExpenseDrafts(wallet, drafts);
  return drafts;
}

export function removeExpenseDraft(wallet: string, idempotencyKey: string): ExpenseDraft[] {
  const drafts = readExpenseDrafts(wallet).filter((draft) => draft.idempotencyKey !== idempotencyKey);
  writeExpenseDrafts(wallet, drafts);
  return drafts;
}
