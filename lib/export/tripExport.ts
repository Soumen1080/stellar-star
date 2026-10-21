/**
 * Trip exports (#324): CSV rows, print summaries and the portable archive.
 *
 * Everything here is pure and works on data the caller is already allowed to
 * see. Authorisation is not decided here: the browser exports what RLS loaded
 * for it, and the archive route builds from a client scoped to the caller's
 * session (see app/api/exports/archive/route.ts).
 *
 * Every amount stays the exact decimal string it was stored as. Sums go
 * through `Money` (BigInt stroops) and come out as 7-decimal strings.
 */

import { Money } from "@/lib/money";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { shareBalance } from "@/lib/settlement/installments";
import { computeNetBalances, type RawDebt } from "@/lib/settlement/simplify";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import { amount, raw, text, toCsv, type CsvCell } from "./csv";

/**
 * Optional provenance fields some rows carry (entered amount and quote source
 * arrive with #323; category with a future feature). Read defensively so the
 * export works whichever of those has shipped.
 */
export type ExportableExpense = Expense;

export const CSV_HEADER = [
  "record_type",
  "trip_id",
  "trip_name",
  "expense_id",
  "expense_title",
  "category",
  "created_at",
  "paid_by",
  "member_id",
  "member_name",
  "member_wallet",
  "amount",
  "settlement_asset",
  "entered_amount",
  "entered_currency",
  "exchange_rate",
  "exchange_rate_source",
  "exchange_rate_timestamp",
  "paid",
  "transaction_hash",
  "explorer_url",
  "note",
];

const TX_HASH = /^[0-9a-f]{64}$/i;

/** Only well-formed hashes become links, so stored junk cannot inject a URL. */
export function explorerTxUrl(txHash: string | undefined, explorerBase: string): string | undefined {
  if (!txHash || !TX_HASH.test(txHash)) return undefined;
  return `${explorerBase.replace(/\/+$/, "")}/tx/${txHash.toLowerCase()}`;
}

/** "native" → "XLM", "USDC:GA…" → "USDC:GA…" (full key keeps the issuer). */
export function assetLabel(assetKey: string): string {
  return assetKey === "native" ? "XLM" : assetKey;
}

function provenanceCells(expense: ExportableExpense): CsvCell[] {
  const converted = Boolean(expense.exchangeRate) && expense.currency.toUpperCase() !== "XLM";
  return [
    amount(converted ? expense.enteredAmount ?? null : expense.totalAmount),
    text(expense.currency),
    amount(converted ? expense.exchangeRate ?? null : null),
    text(converted ? expense.exchangeRateSource ?? null : null),
    text(converted ? expense.exchangeRateTimestamp ?? null : null),
  ];
}

export interface CsvOptions {
  explorerBase: string;
}

/**
 * One `expense` row per expense, one `share` row per share, and one
 * `adjustment` row for every share marked paid without an on-chain
 * transaction — a manual settlement adjustment an accountant must see.
 */
export function buildExportRows(
  trip: Trip | null,
  expenses: ExportableExpense[],
  { explorerBase }: CsvOptions,
): CsvCell[][] {
  const rows: CsvCell[][] = [];
  const tripCells = [text(trip?.id ?? ""), text(trip?.name ?? "")];

  for (const expense of expenses) {
    const asset = assetLabel(settlementAssetOf(expense));
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    const head = [
      ...tripCells,
      text(expense.id),
      text(expense.title),
      text(expense.category ?? ""),
      text(expense.createdAt),
      text(payer?.name ?? ""),
    ];

    rows.push([
      text("expense"),
      ...head,
      text(""),
      text(""),
      text(payer?.walletAddress ?? ""),
      amount(expense.totalAmount),
      text(asset),
      ...provenanceCells(expense),
      raw(expense.settled),
      text(""),
      text(""),
      text(expense.description ?? ""),
    ]);

    for (const share of expense.shares) {
      const isPayer = share.memberId === expense.paidByMemberId;
      const shareCells = (
        recordType: string,
        note: string,
        value: string = share.amount,
        txHash: string | undefined = share.txHash,
        paid: boolean = share.paid,
      ): CsvCell[] => [
        text(recordType),
        ...head,
        text(share.memberId),
        text(share.name),
        text(share.walletAddress ?? ""),
        amount(value),
        text(asset),
        amount(null),
        text(null),
        amount(null),
        text(null),
        text(null),
        raw(paid),
        text(txHash ?? ""),
        text(explorerTxUrl(txHash, explorerBase) ?? ""),
        text(note),
      ];

      rows.push(shareCells("share", isPayer ? "Payer's own share; no payment needed" : ""));
      // One row per partial payment (#325), each with its own transaction.
      for (const installment of share.installments ?? []) {
        rows.push(
          shareCells(
            "installment",
            `Installment #${installment.seq}${installment.onChain ? " (recorded on-chain)" : ""}`,
            installment.amount,
            installment.txHash,
            true,
          ),
        );
      }
      if (share.paid && !isPayer && !TX_HASH.test(share.txHash ?? "")) {
        rows.push(shareCells("adjustment", "Marked paid without an on-chain transaction"));
      }
    }
  }
  return rows;
}

export function buildTripCsv(trip: Trip | null, expenses: ExportableExpense[], options: CsvOptions): string {
  return toCsv(CSV_HEADER, buildExportRows(trip, expenses, options));
}

// ─── Balances ─────────────────────────────────────────────────────────────────

export interface MemberBalance {
  memberId: string;
  name: string;
  walletAddress?: string;
  /** Total this member fronted as payer. */
  paid: string;
  /** Total of this member's shares. */
  share: string;
  /** Unsettled net: positive = is owed, negative = owes. */
  outstanding: string;
}

export interface AssetBalances {
  asset: string;
  total: string;
  members: MemberBalance[];
}

/** Per-asset balances. Assets are never summed together. */
export function computeTripBalances(trip: Trip, expenses: Expense[]): AssetBalances[] {
  const byAsset = new Map<string, { total: Money; members: Map<string, { paid: Money; share: Money }> }>();
  const debts: RawDebt[] = [];
  const nameOf = new Map(trip.members.map((m) => [m.id, m]));

  for (const expense of expenses) {
    const asset = settlementAssetOf(expense);
    const bucket = byAsset.get(asset) ?? { total: Money.zero(), members: new Map() };
    byAsset.set(asset, bucket);
    const total = Money.tryParse(expense.totalAmount) ?? Money.zero();
    bucket.total = bucket.total.plus(total);

    const entry = (id: string) => {
      const existing = bucket.members.get(id) ?? { paid: Money.zero(), share: Money.zero() };
      bucket.members.set(id, existing);
      return existing;
    };
    entry(expense.paidByMemberId).paid = entry(expense.paidByMemberId).paid.plus(total);

    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    for (const share of expense.shares) {
      const shareAmount = Money.tryParse(share.amount) ?? Money.zero();
      entry(share.memberId).share = entry(share.memberId).share.plus(shareAmount);
      if (!nameOf.has(share.memberId)) {
        nameOf.set(share.memberId, { id: share.memberId, name: share.name, walletAddress: share.walletAddress });
      }
      if (!payer || share.memberId === payer.id) continue;
      // Partly paid shares (#325) owe only their remaining balance.
      const balance = shareBalance(share);
      if (balance.fullySettled) continue;
      debts.push({
        expenseId: expense.id,
        fromId: share.memberId,
        toId: payer.id,
        from: share.name,
        to: payer.name,
        amount: balance.remaining,
        asset,
        fromWallet: share.walletAddress,
        toWallet: payer.walletAddress,
      });
    }
  }

  const outstanding = computeNetBalances(debts);
  return [...byAsset.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([asset, bucket]) => ({
      asset: assetLabel(asset),
      total: bucket.total.toString(),
      members: [...bucket.members.entries()].map(([memberId, totals]) => {
        const info = nameOf.get(memberId);
        const net = outstanding.get(asset)?.get(memberId)?.net ?? Money.zero();
        return {
          memberId,
          name: info?.name ?? memberId,
          walletAddress: info?.walletAddress,
          paid: totals.paid.toString(),
          share: totals.share.toString(),
          outstanding: net.toString(),
        };
      }),
    }));
}

// ─── Portable archive ─────────────────────────────────────────────────────────

export const ARCHIVE_FORMAT = "stellar-star-trip-archive";
export const ARCHIVE_VERSION = 1;

export interface TripArchive {
  format: typeof ARCHIVE_FORMAT;
  version: typeof ARCHIVE_VERSION;
  generatedAt: string;
  network: string;
  /** The wallet the archive was generated for. Every trip is one it can read. */
  wallet: string;
  /** Amounts are decimal strings; parse them with an exact decimal library. */
  amountEncoding: "decimal-string";
  trips: Array<{
    trip: Trip;
    expenses: ExportableExpense[];
    balances: AssetBalances[];
  }>;
  /** Expenses the wallet can see that belong to none of the exported trips. */
  unassignedExpenses: ExportableExpense[];
  csv: string;
  counts: { trips: number; expenses: number; shares: number };
}

export function buildArchive(input: {
  wallet: string;
  network: string;
  explorerBase: string;
  trips: Trip[];
  expenses: ExportableExpense[];
  generatedAt?: string;
  /**
   * Include visible expenses that belong to none of `trips`. False when the
   * caller asked for specific trips, so the archive holds only those.
   */
  includeUnassigned?: boolean;
}): TripArchive {
  const byId = new Map(input.expenses.map((e) => [e.id, e]));
  const assigned = new Set<string>();
  const trips = input.trips.map((trip) => {
    const expenses = trip.expenseIds
      .map((id) => byId.get(id))
      .filter((e): e is ExportableExpense => Boolean(e));
    expenses.forEach((e) => assigned.add(e.id));
    return { trip, expenses, balances: computeTripBalances(trip, expenses) };
  });
  const unassignedExpenses = input.includeUnassigned === false
    ? []
    : input.expenses.filter((e) => !assigned.has(e.id));

  const csvRows = trips.flatMap(({ trip, expenses }) =>
    buildExportRows(trip, expenses, { explorerBase: input.explorerBase }),
  );
  csvRows.push(...buildExportRows(null, unassignedExpenses, { explorerBase: input.explorerBase }));

  const allExpenses = [...trips.flatMap((t) => t.expenses), ...unassignedExpenses];
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    network: input.network,
    wallet: input.wallet,
    amountEncoding: "decimal-string",
    trips,
    unassignedExpenses,
    csv: toCsv(CSV_HEADER, csvRows),
    counts: {
      trips: trips.length,
      expenses: allExpenses.length,
      shares: allExpenses.reduce((n, e) => n + e.shares.length, 0),
    },
  };
}

/** A filesystem-safe file name stem for a trip. */
export function exportFileStem(name: string, date = new Date()): string {
  const slug = name.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 60);
  return `${slug || "trip"}-${date.toISOString().slice(0, 10)}`;
}
