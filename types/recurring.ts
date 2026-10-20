import type { ExpenseCategory } from "@/lib/expense/categories";
import type { Member, SplitMode } from "./expense";

export type CadenceUnit = "day" | "week" | "month" | "year";

export interface Cadence {
  unit: CadenceUnit;
  /** Every N units, 1..365. */
  interval: number;
}

/**
 * How each occurrence's amount is decided.
 * - fixed:    the same amount every time (rent, subscriptions)
 * - variable: entered at review (utilities); `estimate` only pre-fills the form
 */
export type AmountRule =
  | { kind: "fixed"; amount: string }
  | { kind: "variable"; estimate?: string | null };

export type RecurringStatus = "active" | "paused" | "ended";

export interface RecurringTemplate {
  id: string;
  tripId: string | null;
  title: string;
  description: string | null;
  category: ExpenseCategory | null;
  tags: string[];
  /** What the user types amounts in (XLM or a fiat code); converted at review, never here. */
  currency: string;
  amountRule: AmountRule;
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
  cadence: Cadence;
  /** Calendar dates, YYYY-MM-DD. */
  startDate: string;
  endDate: string | null;
  /**
   * First date the generator may produce. Starts at `startDate`; resuming a
   * paused template moves it to the resume date so the paused gap is not
   * back-filled with surprise drafts.
   */
  generateFrom: string;
  /** Create the draft this many days before it is due (null = on the day). */
  reminderLeadDays: number | null;
  status: RecurringStatus;
  version: number;
  createdByWallet: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields an occurrence override may change. Amount/title only — never members or payer. */
export interface OccurrenceOverrides {
  title?: string;
  description?: string | null;
  amount?: string;
}

export interface OccurrenceException {
  id: string;
  templateId: string;
  occurrenceDate: string;
  action: "skip" | "override";
  overrides: OccurrenceOverrides;
}

/** What a draft pre-fills. A snapshot: later template edits never rewrite it. */
export interface DraftPayload {
  title: string;
  description: string | null;
  category: ExpenseCategory | null;
  tags: string[];
  currency: string;
  /** Empty for a variable amount the reviewer must enter. */
  amount: string;
  amountKind: AmountRule["kind"];
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
}

export type DraftStatus = "pending" | "saved" | "dismissed";

export interface ExpenseDraft {
  id: string;
  templateId: string;
  templateVersion: number;
  tripId: string | null;
  occurrenceDate: string;
  payload: DraftPayload;
  status: DraftStatus;
  expenseId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
