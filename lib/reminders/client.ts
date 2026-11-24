"use client";

/**
 * Browser side of reminders and payment requests (#326). Every call carries
 * the wallet session; the server decides who may see or send what.
 */

import { getAccessToken } from "@/lib/supabase/session";
import type {
  PaymentReminder,
  PaymentRequestContext,
  ReminderAction,
  ReminderChannel,
  ReminderPreferences,
  ReminderSchedule,
} from "@/types/reminder";
import { idempotencyHeaders, newIdempotencyKey } from "@/lib/idempotency/client";

export class ReminderRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReminderRequestError";
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new ReminderRequestError("Sign in with your wallet to continue.", 401);
  const res = await fetchImpl(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ReminderRequestError(body?.error || "The reminder request failed.", res.status);
  return body.data as T;
}

/**
 * Writes below send an Idempotency-Key (#412). Pass the same key when retrying
 * one action; a fresh key is generated when omitted.
 */
export function sendPaymentReminder(
  input: { tripId: string; expenseId: string; memberId: string; note?: string },
  fetchImpl?: typeof fetch,
  idempotencyKey: string = newIdempotencyKey(),
) {
  return call<{ reminder: PaymentReminder; channels: ReminderChannel[] }>(
    "/api/reminders",
    { method: "POST", body: JSON.stringify(input), headers: idempotencyHeaders(idempotencyKey) },
    fetchImpl,
  );
}

export function listReminders(role: "recipient" | "sender" = "recipient", fetchImpl?: typeof fetch) {
  return call<PaymentReminder[]>(`/api/reminders?role=${role}`, {}, fetchImpl);
}

export function getPaymentRequest(id: string, fetchImpl?: typeof fetch) {
  return call<PaymentRequestContext>(`/api/reminders/${encodeURIComponent(id)}`, {}, fetchImpl);
}

export function actOnReminder(
  id: string,
  action: ReminderAction,
  fetchImpl?: typeof fetch,
  idempotencyKey: string = newIdempotencyKey(),
) {
  return call<{ reminder: PaymentReminder; preferences: ReminderPreferences | null }>(
    `/api/reminders/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ action }), headers: idempotencyHeaders(idempotencyKey) },
    fetchImpl,
  );
}

export function getReminderPreferences(fetchImpl?: typeof fetch) {
  return call<ReminderPreferences>("/api/reminders/preferences", {}, fetchImpl);
}

export function saveReminderPreferences(
  patch: Partial<Pick<ReminderPreferences, "emailOptIn" | "emailAddress" | "pushOptIn" | "pushEndpoint">>,
  fetchImpl?: typeof fetch,
) {
  return call<ReminderPreferences>(
    "/api/reminders/preferences",
    { method: "PUT", body: JSON.stringify(patch) },
    fetchImpl,
  );
}

export function listReminderSchedules(fetchImpl?: typeof fetch) {
  return call<ReminderSchedule[]>("/api/reminders/schedules", {}, fetchImpl);
}

export function createReminderSchedule(
  tripId: string,
  intervalDays: number,
  fetchImpl?: typeof fetch,
  idempotencyKey: string = newIdempotencyKey(),
) {
  return call<ReminderSchedule>(
    "/api/reminders/schedules",
    { method: "POST", body: JSON.stringify({ tripId, intervalDays }), headers: idempotencyHeaders(idempotencyKey) },
    fetchImpl,
  );
}

export function disableReminderSchedule(
  id: string,
  fetchImpl?: typeof fetch,
  idempotencyKey: string = newIdempotencyKey(),
) {
  return call<{ disabled: boolean }>(
    `/api/reminders/schedules?id=${encodeURIComponent(id)}`,
    { method: "DELETE", headers: idempotencyHeaders(idempotencyKey) },
    fetchImpl,
  );
}
