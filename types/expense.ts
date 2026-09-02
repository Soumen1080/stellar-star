export type SplitMode = "equal" | "custom";

export interface Member {
  id: string;
  name: string;
  walletAddress?: string;
  weight?: number;
}

export interface SplitShare {
  memberId: string;
  name: string;
  walletAddress?: string;
  amount: string;
  paid: boolean;
  txHash?: string;
}

export interface Expense {
  id: string;
  title: string;
  description?: string;
  /** Amount denominated in the settlement asset (see `settlementAsset`). */
  totalAmount: string;
  /**
   * The fiat currency the user typed in (EUR, USD, …) — a display and
   * provenance fact only.
   *
   * NOT a Stellar asset and never a payment denomination: `totalAmount` was
   * already converted out of it at creation time via `exchangeRate`. Use
   * `settlementAssetOf()` from lib/settlement/expenseAsset.ts to ask what this
   * expense actually settles in.
   */
  currency: string;
  /**
   * Units of `currency` per one unit of the settlement asset, captured when the
   * expense was created. `totalAmount` was converted through it, so it is the
   * only way back to the fiat figure the user actually typed — the receipt
   * views divide by it to show provenance.
   *
   * Absent when `currency` is already the settlement asset (no conversion
   * happened) and on rows created before FX capture existed.
   */
  exchangeRate?: string;
  /** ISO timestamp the `exchangeRate` above was quoted at. */
  exchangeRateTimestamp?: string;
  /**
   * Canonical Stellar asset this expense settles in ("native", "USDC:GA5Z…").
   * Absent on rows created before multi-asset support, which all settle native.
   */
  settlementAsset?: string | null;
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
  shares: SplitShare[];
  createdAt: string;
  settled: boolean;
  version?: number;
  updatedAt?: string;
}

export type ExpenseFormData = {
  title: string;
  description: string;
  totalAmount: string;
  splitMode: SplitMode;
  paidByMemberId: string;
  members: Member[];
};
