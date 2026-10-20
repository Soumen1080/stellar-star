/**
 * In-memory ReminderRepository for tests (#326). `viewer` emulates RLS: when
 * set, reminders and expenses are only visible to the wallets they involve.
 */

import { defaultPreferences, type ReminderRepository } from "@/lib/reminders/repository";
import type { Expense } from "@/types/expense";
import type { PaymentReminder, ReminderEvent, ReminderPreferences, ReminderSchedule } from "@/types/reminder";

export interface MemoryDb {
  expenses: Map<string, Expense>;
  trips: Map<string, { name: string; expenseIds: string[]; memberWallets: string[] }>;
  reminders: Map<string, PaymentReminder>;
  events: ReminderEvent[];
  preferences: Map<string, ReminderPreferences>;
  schedules: Map<string, ReminderSchedule>;
}

export function memoryDb(): MemoryDb {
  return {
    expenses: new Map(),
    trips: new Map(),
    reminders: new Map(),
    events: [],
    preferences: new Map(),
    schedules: new Map(),
  };
}

let seq = 0;
const uuid = () => {
  seq++;
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`;
};

export function memoryRepository(db: MemoryDb, viewer: string | null): ReminderRepository {
  const canSeeTrip = (tripId: string) => {
    const trip = db.trips.get(tripId);
    return !!trip && (viewer === null || trip.memberWallets.includes(viewer));
  };
  const canSeeExpense = (expense: Expense) =>
    viewer === null || expense.members.some((m) => m.walletAddress === viewer);

  return {
    async findExpense(id) {
      const expense = db.expenses.get(id);
      return expense && canSeeExpense(expense) ? expense : null;
    },
    async findTrip(id) {
      if (!canSeeTrip(id)) return null;
      const trip = db.trips.get(id)!;
      return { name: trip.name, expenseIds: trip.expenseIds };
    },
    async listTripExpenses(tripId) {
      const trip = db.trips.get(tripId);
      return trip ? trip.expenseIds.map((id) => db.expenses.get(id)!).filter(Boolean) : [];
    },
    async insertReminder(r) {
      const reminder: PaymentReminder = {
        ...r,
        id: uuid(),
        channels: ["in_app"],
        createdAt: new Date().toISOString(),
        readAt: null,
      };
      db.reminders.set(reminder.id, reminder);
      return reminder;
    },
    async updateReminder(id, patch) {
      const current = db.reminders.get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      db.reminders.set(id, next);
      return next;
    },
    async getReminder(id) {
      const r = db.reminders.get(id);
      if (!r) return null;
      if (viewer !== null && viewer !== r.senderWallet && viewer !== r.recipientWallet) return null;
      return r;
    },
    async listReminders(wallet, role) {
      return [...db.reminders.values()].filter((r) =>
        role === "recipient" ? r.recipientWallet === wallet : r.senderWallet === wallet,
      );
    },
    async appendEvents(events) {
      for (const e of events) {
        db.events.push({
          id: uuid(),
          reminderId: e.reminderId,
          actorWallet: e.actorWallet,
          kind: e.kind,
          channel: e.channel ?? null,
          detail: e.detail ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    },
    async listEvents(reminderId) {
      return db.events.filter((e) => e.reminderId === reminderId);
    },
    async getPreferences(wallet, scope) {
      if (scope === "own" && viewer !== null && viewer !== wallet) return null;
      return db.preferences.get(wallet) ?? null;
    },
    async savePreferences(wallet, patch) {
      const next = { ...(db.preferences.get(wallet) ?? defaultPreferences(wallet)), ...patch };
      db.preferences.set(wallet, next);
      return next;
    },
    async listSchedules(owner) {
      return [...db.schedules.values()].filter((s) => s.ownerWallet === owner && s.active);
    },
    async createSchedule(s) {
      for (const existing of db.schedules.values()) {
        if (existing.tripId === s.tripId && existing.ownerWallet === s.ownerWallet) existing.active = false;
      }
      const schedule: ReminderSchedule = { ...s, id: uuid(), active: true };
      db.schedules.set(schedule.id, schedule);
      return schedule;
    },
    async disableSchedule(id, owner) {
      const s = db.schedules.get(id);
      if (!s || s.ownerWallet !== owner || !s.active) return false;
      s.active = false;
      return true;
    },
    async listDueSchedules(now) {
      return [...db.schedules.values()].filter((s) => s.active && new Date(s.nextRunAt) <= now);
    },
    async advanceSchedule(id, next) {
      const s = db.schedules.get(id);
      if (s) s.nextRunAt = next.toISOString();
    },
  };
}
