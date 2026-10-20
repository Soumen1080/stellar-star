import type { ExpenseCategory } from "@/lib/expense/categories";

export type SplitMode = "equal" | "custom";

export interface Member {
  id: string;
  name: string;
  walletAddress?: string;
  weight?: number;
}

/**
 * One on-chain payment towards a share (#325). Append-only; see
 * lib/settlement/installments.ts for the invariants.
 */
export interface ShareInstallment {
  /** 1-based position within the share. */
  seq: number;
  /** Decimal string at ledger precision. */
  amount: string;
  /** `amount` as integer stroops/base units, the value every sum uses. */
  amountStroops: string;
  /** Stellar transaction that moved this installment, lowercase hex. */
  txHash: string;
  ledger?: number | null;
  /** Expense id this installment is attested and recorded under on-chain. */
  claimId: string;
  /** Nonce of the oracle attestation covering this installment, if minted. */
  attestationNonce?: string | null;
  /** True once the attestation oracle confirmed the payment against Horizon. */
  verified: boolean;
  /** True once the settlement contract recorded this installment. */
  onChain: boolean;
  paidAt: string;
}

export interface SplitShare {
  memberId: string;
  name: string;
  walletAddress?: string;
  /** What this member owes, in the settlement asset. */
  amount: string;
  /** True only when the whole share is settled; never for a partial payment. */
  paid: boolean;
  txHash?: string;
  /** Payments made towards this share. Absent on shares paid in one go. */
  installments?: ShareInstallment[];
  /** Sum of `installments` in integer stroops, kept alongside for SQL checks. */
  paidStroops?: string;
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
   * Rate used to convert `currency` into the settlement asset at creation time,
   * as a decimal string. Absent when the expense was entered directly in the
   * settlement asset (no conversion happened).
   */
  exchangeRate?: string;
  /** ISO timestamp of the `exchangeRate` quote, for provenance. */
  exchangeRateTimestamp?: string;
  /** Provider that produced `exchangeRate` (e.g. "coingecko"). */
  exchangeRateSource?: string;
  /**
   * The amount exactly as the user typed it, in `currency`. `totalAmount` is
   * this converted at `exchangeRate`. Absent on rows created before #323.
   */
  enteredAmount?: string;
  /**
   * Canonical Stellar asset this expense settles in ("native", "USDC:GA5Z…").
   * Absent on rows created before multi-asset support, which all settle native.
   */
  settlementAsset?: string | null;
  /**
   * One of `EXPENSE_CATEGORIES` (lib/expense/categories.ts). Absent on
   * uncategorized expenses, which includes every row created before #317.
   */
  category?: ExpenseCategory | null;
  /** Normalized labels (see lib/expense/tags.ts); organization only, never money. */
  tags?: string[];
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
