/**
 * Database access for recurring templates, occurrence exceptions and drafts.
 * Browser calls run under the wallet's RLS; the scheduled job passes a
 * service-role client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  ExpenseDraftRow,
  Json,
  RecurringExceptionRow,
  RecurringTemplateRow,
} from "@/types/supabase";
import type { Member } from "@/types/expense";
import type {
  DraftPayload,
  ExpenseDraft,
  OccurrenceException,
  OccurrenceOverrides,
  RecurringStatus,
  RecurringTemplate,
} from "@/types/recurring";
import { isExpenseCategory } from "@/lib/expense/categories";
import { requireAuthenticatedClient } from "@/lib/supabase/client";
import { toDatabaseError, DatabaseError } from "@/lib/supabase/queries";

type Client = SupabaseClient<Database>;

const TEMPLATE_COLUMNS =
  "id, trip_id, title, description, category, tags, currency, amount_kind, amount, split_mode, paid_by_member_id, members, cadence_unit, cadence_interval, start_date, end_date, generate_from, reminder_lead_days, status, version, created_by_wallet, member_wallets, created_at, updated_at";
const EXCEPTION_COLUMNS = "id, template_id, occurrence_date, action, overrides, created_by_wallet, created_at";
const DRAFT_COLUMNS =
  "id, template_id, template_version, trip_id, occurrence_date, payload, status, expense_id, member_wallets, created_at, resolved_at, resolved_by_wallet";

// ─── Mappers ──────────────────────────────────────────────────────────────────

export function rowToTemplate(row: RecurringTemplateRow): RecurringTemplate {
  return {
    id: row.id,
    tripId: row.trip_id,
    title: row.title,
    description: row.description,
    category: isExpenseCategory(row.category) ? row.category : null,
    tags: row.tags ?? [],
    currency: row.currency,
    amountRule:
      row.amount_kind === "fixed"
        ? { kind: "fixed", amount: row.amount ?? "0" }
        : { kind: "variable", estimate: row.amount },
    splitMode: row.split_mode,
    paidByMemberId: row.paid_by_member_id,
    members: (row.members ?? []) as unknown as Member[],
    cadence: { unit: row.cadence_unit, interval: row.cadence_interval },
    startDate: row.start_date,
    endDate: row.end_date,
    generateFrom: row.generate_from,
    reminderLeadDays: row.reminder_lead_days,
    status: row.status,
    version: row.version,
    createdByWallet: row.created_by_wallet,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToException(row: RecurringExceptionRow): OccurrenceException {
  return {
    id: row.id,
    templateId: row.template_id,
    occurrenceDate: row.occurrence_date,
    action: row.action,
    overrides: (row.overrides ?? {}) as OccurrenceOverrides,
  };
}

export function rowToDraft(row: ExpenseDraftRow): ExpenseDraft {
  return {
    id: row.id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    tripId: row.trip_id,
    occurrenceDate: row.occurrence_date,
    payload: row.payload as unknown as DraftPayload,
    status: row.status,
    expenseId: row.expense_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** Template fields a user authors (everything else is server- or lifecycle-managed). */
export type TemplateInput = Pick<
  RecurringTemplate,
  | "title"
  | "description"
  | "category"
  | "tags"
  | "currency"
  | "amountRule"
  | "splitMode"
  | "paidByMemberId"
  | "members"
  | "cadence"
  | "startDate"
  | "endDate"
  | "reminderLeadDays"
>;

function inputToColumns(input: TemplateInput) {
  return {
    title: input.title,
    description: input.description,
    category: input.category,
    tags: input.tags,
    currency: input.currency,
    amount_kind: input.amountRule.kind,
    amount: input.amountRule.kind === "fixed" ? input.amountRule.amount : input.amountRule.estimate ?? null,
    split_mode: input.splitMode,
    paid_by_member_id: input.paidByMemberId,
    members: input.members as unknown as Json,
    cadence_unit: input.cadence.unit,
    cadence_interval: input.cadence.interval,
    start_date: input.startDate,
    end_date: input.endDate,
    reminder_lead_days: input.reminderLeadDays,
  };
}

// ─── Templates ────────────────────────────────────────────────────────────────

export async function fetchTripTemplates(
  tripId: string,
  client: Client = requireAuthenticatedClient(),
): Promise<RecurringTemplate[]> {
  const { data, error } = await client
    .from("recurring_expense_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (error) throw toDatabaseError(error, "load recurring expenses");
  return (data ?? []).map((row) => rowToTemplate(row as RecurringTemplateRow));
}

/** Every active template — for the scheduled job, which runs with the service role. */
export async function fetchActiveTemplates(client: Client, { limit = 500, offset = 0 } = {}) {
  const { data, error } = await client
    .from("recurring_expense_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("status", "active")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw toDatabaseError(error, "load recurring expenses");
  return (data ?? []).map((row) => rowToTemplate(row as RecurringTemplateRow));
}

export async function insertTemplate(
  tripId: string | null,
  input: TemplateInput,
  creatorWallet: string,
  client: Client = requireAuthenticatedClient(),
): Promise<RecurringTemplate> {
  const { data, error } = await client
    .from("recurring_expense_templates")
    .insert({
      ...inputToColumns(input),
      trip_id: tripId,
      created_by_wallet: creatorWallet,
      generate_from: input.startDate,
    })
    .select(TEMPLATE_COLUMNS)
    .single();
  if (error || !data) throw error ? toDatabaseError(error, "save this recurring expense") : new DatabaseError("No data returned.");
  return rowToTemplate(data as RecurringTemplateRow);
}

/**
 * Edits the series going forward. Drafts already generated and expenses
 * already saved keep their snapshot — editing a template never rewrites
 * history. Version-checked so two members editing at once do not silently
 * overwrite each other.
 */
export async function updateTemplate(
  template: RecurringTemplate,
  input: TemplateInput,
  client: Client = requireAuthenticatedClient(),
): Promise<RecurringTemplate> {
  return patchTemplate(template, inputToColumns(input), client);
}

async function patchTemplate(
  template: RecurringTemplate,
  patch: Database["public"]["Tables"]["recurring_expense_templates"]["Update"],
  client: Client,
): Promise<RecurringTemplate> {
  const { data, error } = await client
    .from("recurring_expense_templates")
    .update({ ...patch, version: template.version + 1 })
    .eq("id", template.id)
    .eq("version", template.version)
    .select(TEMPLATE_COLUMNS)
    .maybeSingle();
  if (error) throw toDatabaseError(error, "update this recurring expense");
  if (!data) {
    throw new DatabaseError("Someone else changed this recurring expense. Reload and try again.", "40001");
  }
  return rowToTemplate(data as RecurringTemplateRow);
}

/**
 * Pause, resume or end a series. Resuming moves `generate_from` to today, so
 * occurrences that fell inside the pause are not back-filled as a surprise
 * batch of drafts.
 */
export function setTemplateStatus(
  template: RecurringTemplate,
  status: RecurringStatus,
  today: string,
  client: Client = requireAuthenticatedClient(),
): Promise<RecurringTemplate> {
  const patch: Database["public"]["Tables"]["recurring_expense_templates"]["Update"] = { status };
  if (status === "active" && template.status === "paused") {
    patch.generate_from = today > template.startDate ? today : template.startDate;
  }
  return patchTemplate(template, patch, client);
}

// ─── Exceptions (skip / edit one future occurrence) ──────────────────────────

export async function fetchExceptions(
  templateIds: string[],
  client: Client = requireAuthenticatedClient(),
): Promise<OccurrenceException[]> {
  if (templateIds.length === 0) return [];
  const { data, error } = await client
    .from("recurring_expense_exceptions")
    .select(EXCEPTION_COLUMNS)
    .in("template_id", templateIds);
  if (error) throw toDatabaseError(error, "load skipped occurrences");
  return (data ?? []).map((row) => rowToException(row as RecurringExceptionRow));
}

export async function setOccurrenceException(
  templateId: string,
  occurrenceDate: string,
  action: OccurrenceException["action"],
  overrides: OccurrenceOverrides,
  wallet: string,
  today: string,
  client: Client = requireAuthenticatedClient(),
): Promise<OccurrenceException> {
  if (occurrenceDate < today) {
    // History is immutable: a past occurrence is already a draft or an expense.
    throw new DatabaseError("Only future occurrences can be skipped or edited.");
  }
  const { data, error } = await client
    .from("recurring_expense_exceptions")
    .upsert(
      {
        template_id: templateId,
        occurrence_date: occurrenceDate,
        action,
        overrides: overrides as unknown as Json,
        created_by_wallet: wallet,
      },
      { onConflict: "template_id,occurrence_date" },
    )
    .select(EXCEPTION_COLUMNS)
    .single();
  if (error || !data) throw error ? toDatabaseError(error, "update this occurrence") : new DatabaseError("No data returned.");
  return rowToException(data as RecurringExceptionRow);
}

export async function clearOccurrenceException(
  templateId: string,
  occurrenceDate: string,
  client: Client = requireAuthenticatedClient(),
): Promise<void> {
  const { error } = await client
    .from("recurring_expense_exceptions")
    .delete()
    .eq("template_id", templateId)
    .eq("occurrence_date", occurrenceDate);
  if (error) throw toDatabaseError(error, "restore this occurrence");
}

// ─── Drafts ───────────────────────────────────────────────────────────────────

export async function fetchTripDrafts(
  tripId: string,
  client: Client = requireAuthenticatedClient(),
): Promise<ExpenseDraft[]> {
  const { data, error } = await client
    .from("expense_drafts")
    .select(DRAFT_COLUMNS)
    .eq("trip_id", tripId)
    .order("occurrence_date", { ascending: true });
  if (error) throw toDatabaseError(error, "load drafts");
  return (data ?? []).map((row) => rowToDraft(row as ExpenseDraftRow));
}

/**
 * Inserts drafts, skipping any (template, date) that already has one. The
 * unique key makes this the idempotency guarantee: re-running, or two runs
 * racing, can never produce a second draft for the same occurrence. Returns
 * only the rows actually created.
 */
export async function insertDraftsIdempotent(
  drafts: Array<{ templateId: string; templateVersion: number; occurrenceDate: string; payload: DraftPayload }>,
  client: Client,
): Promise<ExpenseDraft[]> {
  if (drafts.length === 0) return [];
  const { data, error } = await client
    .from("expense_drafts")
    .upsert(
      drafts.map((draft) => ({
        template_id: draft.templateId,
        template_version: draft.templateVersion,
        occurrence_date: draft.occurrenceDate,
        payload: draft.payload as unknown as Json,
      })),
      { onConflict: "template_id,occurrence_date", ignoreDuplicates: true },
    )
    .select(DRAFT_COLUMNS);
  if (error) throw toDatabaseError(error, "create drafts");
  return (data ?? []).map((row) => rowToDraft(row as ExpenseDraftRow));
}

/**
 * Marks a pending draft saved (with the expense the reviewer created) or
 * dismissed. Filtered on `status = pending`, so a draft resolved concurrently
 * by another member is not resolved twice.
 */
export async function resolveDraft(
  draftId: string,
  resolution: { status: "saved"; expenseId: string } | { status: "dismissed" },
  wallet: string,
  client: Client = requireAuthenticatedClient(),
): Promise<ExpenseDraft | null> {
  const { data, error } = await client
    .from("expense_drafts")
    .update({
      status: resolution.status,
      expense_id: resolution.status === "saved" ? resolution.expenseId : null,
      resolved_at: new Date().toISOString(),
      resolved_by_wallet: wallet,
    })
    .eq("id", draftId)
    .eq("status", "pending")
    .select(DRAFT_COLUMNS)
    .maybeSingle();
  if (error) throw toDatabaseError(error, "update this draft");
  return data ? rowToDraft(data as ExpenseDraftRow) : null;
}
