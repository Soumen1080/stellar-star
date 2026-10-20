"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Bell, BellOff, PiggyBank, Pencil } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { EXPENSE_CATEGORIES, categoryLabel, type ExpenseCategory } from "@/lib/expense/categories";
import { fetchExchangeRate, describeAge } from "@/lib/fx/quote";
import { fetchTripDrafts } from "@/lib/recurring/queries";
import {
  crossedThresholds,
  formatDisplay,
  summarizeBudget,
  type DisplayRate,
} from "@/lib/budget/compute";
import {
  fetchActiveAlerts,
  fetchAlertMute,
  fetchTripBudget,
  saveTripBudget,
  setAlertMute,
  syncBudgetAlerts,
  type BudgetInput,
} from "@/lib/budget/queries";
import type { BudgetAlert, TripBudget } from "@/types/budget";
import type { Expense } from "@/types/expense";
import type { ExpenseDraft } from "@/types/recurring";

const CURRENCIES = ["XLM", "USD", "EUR", "GBP", "INR"];
const THRESHOLD_CHOICES = [50, 75, 80, 90, 100];

interface TripBudgetCardProps {
  tripId: string;
  expenses: Expense[];
  currentUserPublicKey?: string | null;
}

export function TripBudgetCard({ tripId, expenses, currentUserPublicKey }: TripBudgetCardProps) {
  const { info: toastInfo } = useToast();
  const [budget, setBudget] = useState<TripBudget | null>(null);
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [rate, setRate] = useState<DisplayRate | null>(null);
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [muted, setMuted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = currentUserPublicKey ?? "";

  const load = useCallback(async () => {
    try {
      const [nextBudget, nextDrafts] = await Promise.all([
        fetchTripBudget(tripId),
        fetchTripDrafts(tripId).catch(() => [] as ExpenseDraft[]),
      ]);
      setBudget(nextBudget);
      setDrafts(nextDrafts);
      if (wallet) setMuted(await fetchAlertMute(tripId, wallet));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the budget.");
    }
  }, [tripId, wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  // Rate for converting XLM-settled spend into the display currency.
  useEffect(() => {
    if (!budget || budget.currency === "XLM") {
      setRate(null);
      return;
    }
    let cancelled = false;
    void fetchExchangeRate(budget.currency).then((quote) => {
      if (cancelled) return;
      const xlmPerUnit = quote ? Number(quote.rate) : NaN;
      setRate(
        Number.isFinite(xlmPerUnit) && xlmPerUnit > 0
          ? { perXlm: 1 / xlmPerUnit, fetchedAt: quote!.fetchedAtIso, stale: quote!.stale }
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [budget]);

  const summary = useMemo(
    () => (budget ? summarizeBudget(budget, expenses, drafts, rate) : null),
    [budget, expenses, drafts, rate],
  );

  // Fire/re-arm alerts whenever the committed numbers change.
  useEffect(() => {
    if (!budget || !summary) return;
    let cancelled = false;
    void (async () => {
      try {
        const active = await fetchActiveAlerts(tripId);
        const fired = await syncBudgetAlerts(tripId, crossedThresholds(summary, budget.thresholds), active);
        if (cancelled) return;
        setAlerts(await fetchActiveAlerts(tripId));
        if (!muted) {
          for (const alert of fired) {
            toastInfo(
              `Budget ${alert.threshold}% reached`,
              `${alert.scope === "total" ? "Trip total" : categoryLabel(alert.scope)} is at ${alert.threshold}% of its budget.`,
            );
          }
        }
      } catch {
        // Alerts are advisory; a failure must not break the trip page.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `summary` changes identity on every recompute; key on what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget, tripId, summary?.committed.amount, muted]);

  const toggleMute = async () => {
    try {
      await setAlertMute(tripId, wallet, !muted);
      setMuted(!muted);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update alert preference.");
    }
  };

  return (
    <section aria-labelledby={`budget-${tripId}`} className="mb-5 rounded-2xl border border-[#E5E5E5] bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`budget-${tripId}`} className="flex items-center gap-1.5 text-sm font-bold text-[#0F0F14]">
          <PiggyBank aria-hidden="true" size={14} /> Budget
        </h2>
        <div className="flex items-center gap-1">
          {budget && wallet && (
            <button
              type="button"
              onClick={() => void toggleMute()}
              aria-pressed={muted}
              aria-label={muted ? "Unmute budget alerts for me" : "Mute budget alerts for me"}
              className="rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0]"
            >
              {muted ? <BellOff aria-hidden="true" size={13} /> : <Bell aria-hidden="true" size={13} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-[#444] hover:bg-[#F0F0F0]"
          >
            <Pencil aria-hidden="true" size={11} /> {budget ? "Edit" : "Set budget"}
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}

      {!budget ? (
        <p className="mt-2 text-xs text-[#AAA]">No budget yet. Set a total and per-category caps to track spending.</p>
      ) : summary && (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-3 gap-2 text-center">
            {[
              ["Committed", summary.committed.amount, summary.committed.approximate],
              ["Pending", summary.pending.amount, summary.pending.approximate],
              ["Remaining", summary.remaining, summary.approximate],
            ].map(([labelText, value, approx]) => (
              <div key={labelText as string} className="rounded-xl bg-[#FAFAFA] p-2">
                <dt className="text-[10px] font-semibold uppercase text-[#888]">{labelText as string}</dt>
                <dd className={`text-sm font-bold ${typeof value === "number" && value < 0 ? "text-red-500" : "text-[#0F0F14]"}`}>
                  {value === null ? "—" : `${approx ? "≈ " : ""}${formatDisplay(value as number, summary.currency)}`}
                </dd>
              </div>
            ))}
          </dl>

          {summary.caps.length > 0 && (
            <ul className="space-y-2">
              {summary.caps.map((cap) => (
                <li key={cap.scope}>
                  <div className="flex justify-between text-xs text-[#555]">
                    <span>{cap.scope === "total" ? "Trip total" : categoryLabel(cap.scope)}</span>
                    <span>
                      {formatDisplay(cap.spent, summary.currency)} / {formatDisplay(cap.cap, summary.currency)}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${cap.scope === "total" ? "Trip total" : categoryLabel(cap.scope)} spending`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, Math.round(cap.percent))}
                    aria-valuetext={`${Math.round(cap.percent)}% of budget`}
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#F0F0F0]"
                  >
                    <div
                      className={`h-full ${cap.percent >= 100 ? "bg-red-500" : cap.percent >= 80 ? "bg-amber-400" : "bg-[#2DD4BF]"}`}
                      style={{ width: `${Math.min(100, cap.percent)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {summary.pending.unpricedDrafts > 0 && (
            <p className="text-[11px] text-[#888]">
              {summary.pending.unpricedDrafts} pending draft{summary.pending.unpricedDrafts === 1 ? "" : "s"} without a
              known amount {summary.pending.unpricedDrafts === 1 ? "is" : "are"} not counted.
            </p>
          )}

          {summary.unconverted.map(({ asset, amount }) => (
            <p key={asset} className="text-[11px] text-amber-700">
              {amount.toFixed(2)} {asset.split(":")[0]} settles in a different asset and has no {summary.currency} rate,
              so it is shown separately and not included in the totals above.
            </p>
          ))}

          {summary.approximate && (
            <p className="text-[11px] text-[#888]">
              ≈ Amounts paid in XLM are converted to {summary.currency} at today&apos;s rate
              {rate ? ` (fetched ${describeAge(Date.now() - Date.parse(rate.fetchedAt))} ago${rate.stale ? ", cached" : ""})` : ""},
              so these totals are approximate. Expenses entered in {summary.currency} use their original amount.
              Settlement amounts are never changed.
            </p>
          )}
          {!rate && budget.currency !== "XLM" && expenses.some((e) => e.currency !== budget.currency) && (
            <p className="text-[11px] text-amber-700">
              Exchange rates are unavailable, so XLM amounts can&apos;t be converted to {budget.currency} right now.
            </p>
          )}

          {!muted && alerts.length > 0 && (
            <ul aria-label="Budget alerts" className="space-y-1">
              {alerts.map((alert) => (
                <li key={alert.id} className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  {alert.scope === "total" ? "Trip total" : categoryLabel(alert.scope)} passed {alert.threshold}% of budget on{" "}
                  {new Date(alert.firedAt).toLocaleDateString()}.
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={editing} onClose={() => setEditing(false)} title="Trip budget" size="md">
        <BudgetForm
          initial={budget}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            const saved = await saveTripBudget(tripId, input, budget, wallet);
            setBudget(saved);
            setEditing(false);
          }}
        />
      </Modal>
    </section>
  );
}

const AMOUNT_RE = /^[0-9]+(\.[0-9]{1,7})?$/;

function BudgetForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: TripBudget | null;
  onSave: (input: BudgetInput) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [currency, setCurrency] = useState(initial?.currency ?? "XLM");
  const [total, setTotal] = useState(initial?.totalAmount ?? "");
  const [caps, setCaps] = useState<Partial<Record<ExpenseCategory, string>>>(initial?.categoryCaps ?? {});
  const [thresholds, setThresholds] = useState<number[]>(initial?.thresholds ?? [50, 80, 100]);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (total && !AMOUNT_RE.test(total.trim())) return setError("Enter a valid total.");
    const cleanCaps: Partial<Record<ExpenseCategory, string>> = {};
    for (const [category, value] of Object.entries(caps)) {
      if (!value?.trim()) continue;
      if (!AMOUNT_RE.test(value.trim())) return setError(`Enter a valid cap for ${categoryLabel(category)}.`);
      cleanCaps[category as ExpenseCategory] = value.trim();
    }
    try {
      await onSave({ currency, totalAmount: total.trim() || null, categoryCaps: cleanCaps, thresholds });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the budget.");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-total`} className="text-[11px] font-semibold uppercase text-[#444]">Total budget (optional)</label>
          <input id={`${id}-total`} inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} className="rounded-lg border border-[#E5E5E5] px-2.5 py-2 text-sm" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-currency`} className="text-[11px] font-semibold uppercase text-[#444]">Display currency</label>
          <select id={`${id}-currency`} value={currency} onChange={(e) => setCurrency(e.target.value)} className="rounded-lg border border-[#E5E5E5] px-2.5 py-2 text-sm">
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-[11px] font-semibold uppercase text-[#444]">Category caps (optional)</legend>
        <div className="grid grid-cols-2 gap-2">
          {EXPENSE_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center justify-between gap-2 text-xs text-[#555]">
              {categoryLabel(category)}
              <input
                inputMode="decimal"
                value={caps[category] ?? ""}
                onChange={(e) => setCaps((prev) => ({ ...prev, [category]: e.target.value }))}
                aria-label={`${categoryLabel(category)} cap`}
                className="w-24 rounded-lg border border-[#E5E5E5] px-2 py-1 text-xs"
              />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-[11px] font-semibold uppercase text-[#444]">Alert at</legend>
        <div className="flex flex-wrap gap-3">
          {THRESHOLD_CHOICES.map((t) => (
            <label key={t} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={thresholds.includes(t)}
                onChange={(e) => setThresholds((prev) => (e.target.checked ? [...prev, t] : prev.filter((x) => x !== t)))}
              />
              {t}%
            </label>
          ))}
        </div>
      </fieldset>

      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-xl px-3 py-2 text-sm text-[#888]">Cancel</button>
        <button type="submit" className="rounded-xl bg-[#0F0F14] px-4 py-2 text-sm font-bold text-[#2DD4BF]">Save budget</button>
      </div>
    </form>
  );
}
