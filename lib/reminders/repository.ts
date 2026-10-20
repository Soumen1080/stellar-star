/**
 * lib/reminders/repository.ts — storage for reminders (#326). Server only.
 *
 * Two clients, on purpose:
 *  - `user`: bound to the caller's wallet session. Everything the caller must
 *    be *allowed* to see (the expense they are asking about, a reminder they
 *    open) is read through it, so RLS is the access check.
 *  - `service`: service role, used only for what the caller may not read
 *    directly — the recipient's private delivery preferences — and by the
 *    schedule runner, which acts for a schedule's owner.
 */

import { fetchExpenseById, rowToExpense } from "@/lib/supabase/queries";
import type { StellarStarClient } from "@/lib/supabase/client";
import type { Expense } from "@/types/expense";
import type {
  ExpenseRow,
  PaymentReminderRow,
  ReminderEventRow,
  ReminderPreferencesRow,
  ReminderScheduleRow,
} from "@/types/supabase";
import type {
  PaymentReminder,
  ReminderChannel,
  ReminderEvent,
  ReminderEventKind,
  ReminderPreferences,
  ReminderSchedule,
  ReminderState,
  ReminderTrigger,
} from "@/types/reminder";

export interface NewReminder {
  tripId: string;
  expenseId: string;
  memberId: string;
  recipientWallet: string;
  senderWallet: string;
  amount: string;
  asset: string;
  note: string | null;
  trigger: ReminderTrigger;
  scheduleId: string | null;
  state: ReminderState;
}

export interface NewReminderEvent {
  reminderId: string | null;
  actorWallet: string;
  kind: ReminderEventKind;
  channel?: ReminderChannel | null;
  detail?: string | null;
}

export type PreferencesPatch = Partial<Omit<ReminderPreferences, "wallet">>;

export interface ReminderRepository {
  findExpense(expenseId: string): Promise<Expense | null>;
  /** Null when the trip is not visible to the caller. */
  findTrip(tripId: string): Promise<{ name: string; expenseIds: string[] } | null>;
  listTripExpenses(tripId: string): Promise<Expense[]>;
  insertReminder(reminder: NewReminder): Promise<PaymentReminder>;
  updateReminder(
    id: string,
    patch: Partial<Pick<PaymentReminder, "state" | "readAt" | "channels">>,
  ): Promise<PaymentReminder | null>;
  getReminder(id: string): Promise<PaymentReminder | null>;
  listReminders(wallet: string, role: "recipient" | "sender", limit: number): Promise<PaymentReminder[]>;
  appendEvents(events: NewReminderEvent[]): Promise<void>;
  listEvents(reminderId: string): Promise<ReminderEvent[]>;
  /** Own preferences (session) or a recipient's (service role). */
  getPreferences(wallet: string, scope: "own" | "recipient"): Promise<ReminderPreferences | null>;
  savePreferences(wallet: string, patch: PreferencesPatch, scope: "own" | "service"): Promise<ReminderPreferences>;
  listSchedules(ownerWallet: string): Promise<ReminderSchedule[]>;
  createSchedule(schedule: Omit<ReminderSchedule, "id" | "active">): Promise<ReminderSchedule>;
  disableSchedule(id: string, ownerWallet: string): Promise<boolean>;
  listDueSchedules(now: Date, limit: number): Promise<ReminderSchedule[]>;
  advanceSchedule(id: string, nextRunAt: Date): Promise<void>;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

export function rowToReminder(row: PaymentReminderRow): PaymentReminder {
  return {
    id: row.id,
    tripId: row.trip_id,
    expenseId: row.expense_id,
    memberId: row.member_id,
    recipientWallet: row.recipient_wallet,
    senderWallet: row.sender_wallet,
    amount: row.amount,
    asset: row.asset,
    note: row.note,
    trigger: row.trigger,
    scheduleId: row.schedule_id,
    state: row.state,
    channels: (row.channels ?? []) as ReminderChannel[],
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function rowToReminderEvent(row: ReminderEventRow): ReminderEvent {
  return {
    id: row.id,
    reminderId: row.reminder_id,
    actorWallet: row.actor_wallet,
    kind: row.kind as ReminderEventKind,
    channel: row.channel,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export function rowToPreferences(row: ReminderPreferencesRow): ReminderPreferences {
  return {
    wallet: row.wallet,
    emailOptIn: row.email_opt_in,
    emailAddress: row.email_address,
    pushOptIn: row.push_opt_in,
    pushEndpoint: row.push_endpoint,
    mutedTripIds: row.muted_trip_ids ?? [],
    mutedSenderWallets: row.muted_sender_wallets ?? [],
  };
}

export function rowToSchedule(row: ReminderScheduleRow): ReminderSchedule {
  return {
    id: row.id,
    tripId: row.trip_id,
    ownerWallet: row.owner_wallet,
    intervalDays: row.interval_days,
    nextRunAt: row.next_run_at,
    active: row.active,
  };
}

export function defaultPreferences(wallet: string): ReminderPreferences {
  return {
    wallet,
    emailOptIn: false,
    emailAddress: null,
    pushOptIn: false,
    pushEndpoint: null,
    mutedTripIds: [],
    mutedSenderWallets: [],
  };
}

const REMINDER_COLUMNS =
  "id, trip_id, expense_id, member_id, recipient_wallet, sender_wallet, amount, asset, note, trigger, schedule_id, state, channels, created_at, updated_at, read_at";
const EVENT_COLUMNS = "id, reminder_id, actor_wallet, kind, channel, detail, created_at";
const PREFERENCE_COLUMNS =
  "wallet, email_opt_in, email_address, push_opt_in, push_endpoint, muted_trip_ids, muted_sender_wallets, created_at, updated_at";
const SCHEDULE_COLUMNS = "id, trip_id, owner_wallet, interval_days, next_run_at, active, created_at, updated_at";

// ─── Supabase implementation ─────────────────────────────────────────────────

export function supabaseReminderRepository(clients: {
  user: StellarStarClient | null;
  service: StellarStarClient | null;
}): ReminderRepository {
  const { user, service } = clients;
  const primary = (): StellarStarClient => {
    const client = user ?? service;
    if (!client) throw new Error("Database service is not configured on the server.");
    return client;
  };
  const fail = (action: string, error: { message: string }): never => {
    throw new Error(`Failed to ${action}: ${error.message}`);
  };

  return {
    async findExpense(expenseId) {
      return fetchExpenseById(expenseId, primary());
    },

    async findTrip(tripId) {
      const { data, error } = await primary()
        .from("trips")
        .select("name, expense_ids")
        .eq("id", tripId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as { name?: string; expense_ids?: string[] };
      return { name: row.name ?? "", expenseIds: row.expense_ids ?? [] };
    },

    async listTripExpenses(tripId) {
      const client = primary();
      const { data: trip, error: tripError } = await client
        .from("trips")
        .select("expense_ids")
        .eq("id", tripId)
        .maybeSingle();
      if (tripError || !trip) return [];
      const ids = ((trip as { expense_ids?: string[] }).expense_ids ?? []).slice(0, 500);
      if (ids.length === 0) return [];
      const { data, error } = await client.from("expenses").select("*").in("id", ids);
      if (error) return [];
      return (data ?? []).map((row) => rowToExpense(row as ExpenseRow));
    },

    async insertReminder(reminder) {
      const { data, error } = await primary()
        .from("payment_reminders")
        .insert({
          trip_id: reminder.tripId,
          expense_id: reminder.expenseId,
          member_id: reminder.memberId,
          recipient_wallet: reminder.recipientWallet,
          sender_wallet: reminder.senderWallet,
          amount: reminder.amount,
          asset: reminder.asset,
          note: reminder.note,
          trigger: reminder.trigger,
          schedule_id: reminder.scheduleId,
          state: reminder.state,
          channels: ["in_app"],
        })
        .select(REMINDER_COLUMNS)
        .single();
      if (error || !data) fail("record the reminder", error ?? { message: "no row returned" });
      return rowToReminder(data as PaymentReminderRow);
    },

    async updateReminder(id, patch) {
      const update: Partial<Pick<PaymentReminderRow, "state" | "read_at" | "channels">> = {};
      if (patch.state !== undefined) update.state = patch.state;
      if (patch.readAt !== undefined) update.read_at = patch.readAt;
      if (patch.channels !== undefined) update.channels = patch.channels;
      const { data, error } = await primary()
        .from("payment_reminders")
        .update(update)
        .eq("id", id)
        .select(REMINDER_COLUMNS)
        .maybeSingle();
      if (error) fail("update the reminder", error);
      return data ? rowToReminder(data as PaymentReminderRow) : null;
    },

    async getReminder(id) {
      const { data, error } = await primary()
        .from("payment_reminders")
        .select(REMINDER_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) return null;
      return data ? rowToReminder(data as PaymentReminderRow) : null;
    },

    async listReminders(wallet, role, limit) {
      const column = role === "recipient" ? "recipient_wallet" : "sender_wallet";
      const { data, error } = await primary()
        .from("payment_reminders")
        .select(REMINDER_COLUMNS)
        .eq(column, wallet)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) fail("load reminders", error);
      return (data ?? []).map((row) => rowToReminder(row as PaymentReminderRow));
    },

    async appendEvents(events) {
      if (events.length === 0) return;
      const { error } = await primary()
        .from("reminder_events")
        .insert(
          events.map((e) => ({
            reminder_id: e.reminderId,
            actor_wallet: e.actorWallet,
            kind: e.kind,
            channel: e.channel ?? null,
            detail: e.detail ? e.detail.slice(0, 200) : null,
          })),
        );
      if (error) fail("record reminder history", error);
    },

    async listEvents(reminderId) {
      const { data, error } = await primary()
        .from("reminder_events")
        .select(EVENT_COLUMNS)
        .eq("reminder_id", reminderId)
        .order("created_at", { ascending: true });
      if (error) return [];
      return (data ?? []).map((row) => rowToReminderEvent(row as ReminderEventRow));
    },

    async getPreferences(wallet, scope) {
      const client = scope === "recipient" ? service : primary();
      if (!client) return null;
      const { data, error } = await client
        .from("reminder_preferences")
        .select(PREFERENCE_COLUMNS)
        .eq("wallet", wallet)
        .maybeSingle();
      if (error) return null;
      return data ? rowToPreferences(data as ReminderPreferencesRow) : null;
    },

    async savePreferences(wallet, patch, scope) {
      const client = scope === "service" ? service : primary();
      if (!client) throw new Error("Database service is not configured on the server.");
      const row: Record<string, unknown> = { wallet };
      if (patch.emailOptIn !== undefined) row.email_opt_in = patch.emailOptIn;
      if (patch.emailAddress !== undefined) row.email_address = patch.emailAddress;
      if (patch.pushOptIn !== undefined) row.push_opt_in = patch.pushOptIn;
      if (patch.pushEndpoint !== undefined) row.push_endpoint = patch.pushEndpoint;
      if (patch.mutedTripIds !== undefined) row.muted_trip_ids = patch.mutedTripIds;
      if (patch.mutedSenderWallets !== undefined) row.muted_sender_wallets = patch.mutedSenderWallets;
      const { data, error } = await client
        .from("reminder_preferences")
        .upsert(row as { wallet: string }, { onConflict: "wallet" })
        .select(PREFERENCE_COLUMNS)
        .single();
      if (error || !data) fail("save reminder preferences", error ?? { message: "no row returned" });
      return rowToPreferences(data as ReminderPreferencesRow);
    },

    async listSchedules(ownerWallet) {
      const { data, error } = await primary()
        .from("reminder_schedules")
        .select(SCHEDULE_COLUMNS)
        .eq("owner_wallet", ownerWallet)
        .eq("active", true);
      if (error) fail("load reminder schedules", error);
      return (data ?? []).map((row) => rowToSchedule(row as ReminderScheduleRow));
    },

    async createSchedule(schedule) {
      const client = primary();
      // Replace, never stack: the partial unique index allows one active row.
      await client
        .from("reminder_schedules")
        .update({ active: false })
        .eq("trip_id", schedule.tripId)
        .eq("owner_wallet", schedule.ownerWallet)
        .eq("active", true);
      const { data, error } = await client
        .from("reminder_schedules")
        .insert({
          trip_id: schedule.tripId,
          owner_wallet: schedule.ownerWallet,
          interval_days: schedule.intervalDays,
          next_run_at: schedule.nextRunAt,
        })
        .select(SCHEDULE_COLUMNS)
        .single();
      if (error || !data) fail("create the reminder schedule", error ?? { message: "no row returned" });
      return rowToSchedule(data as ReminderScheduleRow);
    },

    async disableSchedule(id, ownerWallet) {
      const { data, error } = await primary()
        .from("reminder_schedules")
        .update({ active: false })
        .eq("id", id)
        .eq("owner_wallet", ownerWallet)
        .select("id");
      if (error) fail("disable the reminder schedule", error);
      return (data ?? []).length > 0;
    },

    async listDueSchedules(now, limit) {
      const client = service;
      if (!client) return [];
      const { data, error } = await client
        .from("reminder_schedules")
        .select(SCHEDULE_COLUMNS)
        .eq("active", true)
        .lte("next_run_at", now.toISOString())
        .order("next_run_at", { ascending: true })
        .limit(limit);
      if (error) fail("load due reminder schedules", error);
      return (data ?? []).map((row) => rowToSchedule(row as ReminderScheduleRow));
    },

    async advanceSchedule(id, nextRunAt) {
      const client = service ?? primary();
      const { error } = await client
        .from("reminder_schedules")
        .update({ next_run_at: nextRunAt.toISOString() })
        .eq("id", id);
      if (error) fail("advance the reminder schedule", error);
    },
  };
}
