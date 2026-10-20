"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { CalendarClock, Pause, Play, Plus, SkipForward, Square, Undo2 } from "lucide-react";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { Modal } from "@/components/ui/Modal";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, isExpenseCategory } from "@/lib/expense/categories";
import { getSupabaseClient } from "@/lib/supabase/client";
import { generateDueDrafts } from "@/lib/recurring/generate";
import {
  clearOccurrenceException,
  fetchExceptions,
  fetchTripDrafts,
  fetchTripTemplates,
  insertTemplate,
  resolveDraft,
  setOccurrenceException,
  setTemplateStatus,
} from "@/lib/recurring/queries";
import { describeCadence, isCalendarDate, upcomingOccurrences, utcToday } from "@/lib/recurring/schedule";
import type { Member } from "@/types/expense";
import type { CadenceUnit, ExpenseDraft, OccurrenceException, RecurringTemplate } from "@/types/recurring";

interface RecurringPanelProps {
  tripId: string;
  members: Member[];
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  /** Called after a reviewed draft is saved as a normal expense. */
  onExpenseCreated: (expenseId: string) => void;
}

const field =
  "w-full rounded-lg border border-[#E5E5E5] bg-white px-2.5 py-2 text-sm outline-none focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/15";
const label = "text-[11px] font-semibold uppercase tracking-wide text-[#444]";

/**
 * Recurring expenses for a trip. Drafts are generated idempotently and only
 * become expenses through the normal, reviewed ExpenseForm — no payment or
 * wallet signature is ever started from here.
 */
export function RecurringPanel({
  tripId,
  members,
  currentUserPublicKey,
  currentUserName,
  onExpenseCreated,
}: RecurringPanelProps) {
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [exceptions, setExceptions] = useState<OccurrenceException[]>([]);
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reviewing, setReviewing] = useState<ExpenseDraft | null>(null);
  const today = utcToday();

  const load = useCallback(async () => {
    try {
      const nextTemplates = await fetchTripTemplates(tripId);
      const nextExceptions = await fetchExceptions(nextTemplates.map((t) => t.id));
      const client = getSupabaseClient();
      // Catch up on anything due, in case no scheduler is configured.
      if (client) await generateDueDrafts(client, nextTemplates, nextExceptions, today);
      setTemplates(nextTemplates);
      setExceptions(nextExceptions);
      setDrafts(await fetchTripDrafts(tripId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load recurring expenses.");
    }
  }, [tripId, today]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
    }
  };

  const wallet = currentUserPublicKey ?? "";
  const pending = drafts.filter((draft) => draft.status === "pending");

  return (
    <section aria-label="Recurring expenses">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-[#0F0F14]">Recurring ({templates.length})</h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-xl bg-[#0F0F14] px-3 py-2 text-xs font-bold text-[#2DD4BF]"
        >
          <Plus aria-hidden="true" size={12} /> New recurring
        </button>
      </div>

      {error && <p role="alert" className="mb-3 text-xs text-red-500">{error}</p>}

      {pending.length > 0 && (
        <div className="mb-4 rounded-xl border border-[#2DD4BF]/40 bg-[#F0FFFB] p-3">
          <h3 className="mb-2 text-xs font-bold text-[#134E4A]">Drafts waiting for review ({pending.length})</h3>
          <ul className="space-y-1.5">
            {pending.map((draft) => (
              <li key={draft.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  <strong>{draft.payload.title}</strong> · {draft.occurrenceDate}
                  {draft.occurrenceDate > today && " (upcoming)"}
                  {draft.payload.amount ? ` · ${draft.payload.amount} ${draft.payload.currency}` : " · amount to enter"}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button type="button" onClick={() => setReviewing(draft)} className="rounded-lg bg-[#0F0F14] px-2 py-1 font-bold text-[#2DD4BF]">
                    Review &amp; save
                  </button>
                  <button
                    type="button"
                    onClick={() => void act(() => resolveDraft(draft.id, { status: "dismissed" }, wallet))}
                    className="rounded-lg px-2 py-1 text-[#888] hover:text-[#0F0F14]"
                  >
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {templates.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#E5E5E5] px-4 py-8 text-center text-sm text-[#AAA]">
          No recurring expenses. Add rent, utilities or subscriptions to get a draft each time they are due.
        </p>
      ) : (
        <ul className="space-y-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              exceptions={exceptions}
              drafts={drafts}
              today={today}
              onStatus={(status) => act(() => setTemplateStatus(template, status, today))}
              onSkip={(date) => act(() => setOccurrenceException(template.id, date, "skip", {}, wallet, today))}
              onOverride={(date, amount) =>
                act(() => setOccurrenceException(template.id, date, "override", { amount }, wallet, today))
              }
              onRestore={(date) => act(() => clearOccurrenceException(template.id, date))}
            />
          ))}
        </ul>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New recurring expense" size="lg">
        <TemplateForm
          members={members}
          today={today}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            await insertTemplate(tripId, input, wallet);
            setCreating(false);
            await load();
          }}
        />
      </Modal>

      <Modal
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title="Review recurring expense"
        description="Check the details, then save. Nothing is paid or signed automatically."
        size="lg"
      >
        {reviewing && (
          <ExpenseForm
            currentUserPublicKey={currentUserPublicKey}
            currentUserName={currentUserName}
            defaultMembers={reviewing.payload.members}
            initialValues={{
              title: reviewing.payload.title,
              description: reviewing.payload.description,
              totalAmount: reviewing.payload.amount,
              currency: reviewing.payload.currency,
              splitMode: reviewing.payload.splitMode,
              paidByMemberId: reviewing.payload.paidByMemberId,
              category: reviewing.payload.category,
              tags: reviewing.payload.tags,
            }}
            onCancel={() => setReviewing(null)}
            onSuccess={(expenseId) => {
              const draft = reviewing;
              setReviewing(null);
              if (!expenseId) return;
              onExpenseCreated(expenseId);
              void act(() => resolveDraft(draft.id, { status: "saved", expenseId }, wallet));
            }}
          />
        )}
      </Modal>
    </section>
  );
}

function TemplateCard({
  template,
  exceptions,
  drafts,
  today,
  onStatus,
  onSkip,
  onOverride,
  onRestore,
}: {
  template: RecurringTemplate;
  exceptions: OccurrenceException[];
  drafts: ExpenseDraft[];
  today: string;
  onStatus: (status: RecurringTemplate["status"]) => void;
  onSkip: (date: string) => void;
  onOverride: (date: string, amount: string) => void;
  onRestore: (date: string) => void;
}) {
  const drafted = new Set(drafts.filter((d) => d.templateId === template.id).map((d) => d.occurrenceDate));
  const upcoming = upcomingOccurrences(template, exceptions, today, 4);
  const rule = template.amountRule;

  return (
    <li className="rounded-xl border border-[#E5E5E5] bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-[#0F0F14]">{template.title}</p>
          <p className="text-xs text-[#888]">
            {describeCadence(template.cadence)} · {rule.kind === "fixed" ? `${rule.amount} ${template.currency}` : "variable amount"}
            {template.endDate ? ` · until ${template.endDate}` : ""}
            {template.reminderLeadDays ? ` · draft ${template.reminderLeadDays}d early` : ""}
          </p>
          <p className="text-[11px] font-semibold uppercase text-[#AAA]">{template.status}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {template.status === "active" && (
            <button type="button" onClick={() => onStatus("paused")} aria-label={`Pause ${template.title}`} className="rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0]">
              <Pause aria-hidden="true" size={13} />
            </button>
          )}
          {template.status === "paused" && (
            <button type="button" onClick={() => onStatus("active")} aria-label={`Resume ${template.title}`} className="rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0]">
              <Play aria-hidden="true" size={13} />
            </button>
          )}
          {template.status !== "ended" && (
            <button type="button" onClick={() => onStatus("ended")} aria-label={`End ${template.title}`} className="rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0]">
              <Square aria-hidden="true" size={13} />
            </button>
          )}
        </div>
      </div>

      {template.status !== "ended" && upcoming.length > 0 && (
        <ul aria-label={`Upcoming ${template.title}`} className="mt-2 space-y-1">
          {upcoming.map(({ date, exception }) => (
            <li key={date} className="flex items-center justify-between gap-2 text-xs text-[#555]">
              <span className="flex items-center gap-1">
                <CalendarClock aria-hidden="true" size={11} />
                <span className={exception?.action === "skip" ? "line-through text-[#AAA]" : ""}>{date}</span>
                {exception?.action === "override" && exception.overrides.amount && (
                  <span>· {exception.overrides.amount} {template.currency}</span>
                )}
                {drafted.has(date) && <span className="text-[#134E4A]">· drafted</span>}
              </span>
              {!drafted.has(date) && date >= today && (
                <span className="flex gap-1">
                  {exception ? (
                    <button type="button" onClick={() => onRestore(date)} aria-label={`Restore ${date}`} className="rounded p-1 hover:bg-[#F0F0F0]">
                      <Undo2 aria-hidden="true" size={11} />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const amount = window.prompt(`Amount for ${date} (${template.currency})`, rule.kind === "fixed" ? rule.amount : "");
                          if (amount && /^[0-9]+(\.[0-9]{1,7})?$/.test(amount.trim())) onOverride(date, amount.trim());
                        }}
                        aria-label={`Change amount for ${date}`}
                        className="rounded px-1.5 py-0.5 hover:bg-[#F0F0F0]"
                      >
                        Edit
                      </button>
                      <button type="button" onClick={() => onSkip(date)} aria-label={`Skip ${date}`} className="rounded p-1 hover:bg-[#F0F0F0]">
                        <SkipForward aria-hidden="true" size={11} />
                      </button>
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

type TemplateFormInput = Parameters<typeof insertTemplate>[1];

function TemplateForm({
  members,
  today,
  onSubmit,
  onCancel,
}: {
  members: Member[];
  today: string;
  onSubmit: (input: TemplateFormInput) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [amountKind, setAmountKind] = useState<"fixed" | "variable">("fixed");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("XLM");
  const [unit, setUnit] = useState<CadenceUnit>("month");
  const [interval, setRepeatEvery] = useState("1");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [payer, setPayer] = useState(members[0]?.id ?? "");
  const [category, setCategory] = useState("");
  const [lead, setLead] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const n = Number(interval);
    if (!title.trim()) return setError("Title is required.");
    if (amountKind === "fixed" && !/^[0-9]+(\.[0-9]{1,7})?$/.test(amount.trim())) return setError("Enter a valid amount.");
    if (!Number.isInteger(n) || n < 1 || n > 365) return setError("Repeat interval must be 1–365.");
    if (!isCalendarDate(startDate)) return setError("Choose a start date.");
    if (endDate && (!isCalendarDate(endDate) || endDate < startDate)) return setError("End date must be after the start.");
    if (members.length < 2) return setError("The trip needs at least two members.");
    setSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: null,
        category: isExpenseCategory(category) ? category : null,
        tags: [],
        currency,
        amountRule: amountKind === "fixed" ? { kind: "fixed", amount: amount.trim() } : { kind: "variable", estimate: amount.trim() || null },
        splitMode: "equal",
        paidByMemberId: payer,
        members,
        cadence: { unit, interval: n },
        startDate,
        endDate: endDate || null,
        reminderLeadDays: lead ? Math.min(30, Math.max(0, Number(lead))) : null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2 flex flex-col gap-1">
        <label htmlFor={`${id}-title`} className={label}>Title</label>
        <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className={field} placeholder="Rent" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-kind`} className={label}>Amount rule</label>
        <select id={`${id}-kind`} value={amountKind} onChange={(e) => setAmountKind(e.target.value as "fixed" | "variable")} className={field}>
          <option value="fixed">Same amount each time</option>
          <option value="variable">Enter amount at review</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-amount`} className={label}>{amountKind === "fixed" ? "Amount" : "Estimate (optional)"}</label>
        <div className="flex gap-2">
          <input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
          <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${field} w-24`}>
            {["XLM", "USD", "EUR", "GBP", "INR"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-interval`} className={label}>Repeats every</label>
        <div className="flex gap-2">
          <input id={`${id}-interval`} type="number" min={1} max={365} value={interval} onChange={(e) => setRepeatEvery(e.target.value)} className={`${field} w-20`} />
          <select aria-label="Repeat unit" value={unit} onChange={(e) => setUnit(e.target.value as CadenceUnit)} className={field}>
            <option value="day">day(s)</option>
            <option value="week">week(s)</option>
            <option value="month">month(s)</option>
            <option value="year">year(s)</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-payer`} className={label}>Paid by</label>
        <select id={`${id}-payer`} value={payer} onChange={(e) => setPayer(e.target.value)} className={field}>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-start`} className={label}>Starts</label>
        <input id={`${id}-start`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={field} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-end`} className={label}>Ends (optional)</label>
        <input id={`${id}-end`} type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className={field} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-category`} className={label}>Category</label>
        <select id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
          <option value="">No category</option>
          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABELS[c]}</option>)}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-lead`} className={label}>Reminder</label>
        <select id={`${id}-lead`} value={lead} onChange={(e) => setLead(e.target.value)} className={field}>
          <option value="">On the due date</option>
          <option value="1">1 day before</option>
          <option value="3">3 days before</option>
          <option value="7">1 week before</option>
        </select>
      </div>
      <p className="sm:col-span-2 text-[11px] text-[#888]">
        Split equally between all {members.length} trip members. Each occurrence creates a draft you review and save — nothing is paid automatically.
      </p>
      {error && <p role="alert" className="sm:col-span-2 text-xs text-red-500">{error}</p>}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-xl px-3 py-2 text-sm text-[#888]">Cancel</button>
        <button type="submit" disabled={saving} className="rounded-xl bg-[#0F0F14] px-4 py-2 text-sm font-bold text-[#2DD4BF] disabled:opacity-50">
          {saving ? "Saving…" : "Save recurring"}
        </button>
      </div>
    </form>
  );
}
