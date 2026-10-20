"use client";

import { assetLabel, computeTripBalances, explorerTxUrl, type ExportableExpense } from "@/lib/export/tripExport";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { formatAddress } from "@/lib/utils";
import type { Trip } from "@/types/trip";

interface TripPrintSummaryProps {
  trip: Trip;
  expenses: ExportableExpense[];
  explorerBase: string;
  /** Receipt (transaction) links are included only when the viewer opts in. */
  includeReceipts: boolean;
  generatedAt: Date;
}

const cell = "border-b border-[#E5E5E5] px-2 py-1.5 text-left align-top";

function Outstanding({ value }: { value: string }) {
  if (/^-/.test(value)) return <span>owes {value.slice(1)}</span>;
  if (/^0(\.0+)?$/.test(value)) return <span>settled</span>;
  return <span>is owed {value}</span>;
}

/**
 * A print-friendly summary: balances per settlement asset, every expense and
 * share, and explorer links. Amounts are printed exactly as stored.
 */
export function TripPrintSummary({ trip, expenses, explorerBase, includeReceipts, generatedAt }: TripPrintSummaryProps) {
  const balances = computeTripBalances(trip, expenses);

  return (
    <article className="mx-auto max-w-3xl bg-white p-8 text-[12px] leading-relaxed text-[#111] print:max-w-none print:p-0">
      <header className="mb-6 border-b-2 border-[#111] pb-3">
        <h1 className="text-2xl font-black">{trip.name}</h1>
        {trip.description && <p className="text-[#555]">{trip.description}</p>}
        <p className="mt-1 text-[11px] text-[#666]">
          {trip.members.length} members · {expenses.length} expenses · {trip.settled ? "settled" : "open"} ·
          generated {generatedAt.toISOString().replace("T", " ").slice(0, 16)} UTC
        </p>
      </header>

      <section className="mb-8 break-inside-avoid">
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide">Balances</h2>
        {balances.length === 0 && <p>No expenses yet.</p>}
        {balances.map((group) => (
          <table key={group.asset} className="mb-4 w-full border-collapse">
            <caption className="mb-1 text-left font-semibold">
              {group.asset} — total {group.total} {group.asset}
            </caption>
            <thead>
              <tr>
                <th className={cell}>Member</th>
                <th className={cell}>Paid</th>
                <th className={cell}>Share</th>
                <th className={cell}>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => (
                <tr key={m.memberId}>
                  <td className={cell}>
                    {m.name}
                    {m.walletAddress && (
                      <a className="block font-mono text-[10px] text-[#0F766E]" href={`${explorerBase}/account/${m.walletAddress}`}>
                        {formatAddress(m.walletAddress, 6)}
                      </a>
                    )}
                  </td>
                  <td className={cell}>{m.paid}</td>
                  <td className={cell}>{m.share}</td>
                  <td className={cell}>
                    <Outstanding value={m.outstanding} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide">Expenses</h2>
        {expenses.map((expense) => {
          const asset = assetLabel(settlementAssetOf(expense));
          const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
          const converted = expense.exchangeRate && expense.currency.toUpperCase() !== "XLM";
          return (
            <div key={expense.id} className="mb-5 break-inside-avoid">
              <h3 className="font-bold">
                {expense.title} — {expense.totalAmount} {asset}
              </h3>
              <p className="text-[11px] text-[#555]">
                {expense.createdAt.slice(0, 10)} · paid by {payer?.name ?? "unknown"}
                {converted &&
                  ` · entered ${expense.enteredAmount ?? "?"} ${expense.currency} at ${expense.exchangeRate} ${asset}/${expense.currency}` +
                    (expense.exchangeRateSource ? ` (${expense.exchangeRateSource}` : " (") +
                    `${expense.exchangeRateTimestamp ? `, ${expense.exchangeRateTimestamp.slice(0, 16).replace("T", " ")} UTC` : ""})`}
              </p>
              <table className="mt-1 w-full border-collapse">
                <tbody>
                  {expense.shares.map((share) => {
                    const receipt = includeReceipts ? explorerTxUrl(share.txHash, explorerBase) : undefined;
                    return (
                      <tr key={share.memberId}>
                        <td className={cell}>{share.name}</td>
                        <td className={cell}>
                          {share.amount} {asset}
                        </td>
                        <td className={cell}>
                          {share.memberId === expense.paidByMemberId ? "payer" : share.paid ? "paid" : "unpaid"}
                        </td>
                        <td className={cell}>
                          {receipt ? (
                            <a href={receipt} className="font-mono text-[10px] text-[#0F766E] break-all">
                              {receipt}
                            </a>
                          ) : share.paid && share.memberId !== expense.paidByMemberId && !share.txHash ? (
                            <span className="text-[10px] text-[#888]">marked paid off-chain</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
      </section>
    </article>
  );
}
