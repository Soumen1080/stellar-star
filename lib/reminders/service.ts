/**
 * lib/reminders/service.ts — reminders and payment requests (#326). Server only.
 *
 * Every entry point takes its dependencies explicitly (storage, transport,
 * rate limiter, clock) so the flows are tested end to end without a network.
 * The rules themselves live in ./policy.
 */

import { Money } from "@/lib/money";
import type {
  ExternalReminderChannel,
  PaymentReminder,
  PaymentRequestContext,
  ReminderAction,
  ReminderChannel,
  ReminderPreferences,
  ReminderSchedule,
  ReminderTrigger,
} from "@/types/reminder";

export type { ReminderAction };
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import type { ReminderTransport } from "./delivery";
import {
  REMINDER_LIMITS,
  buildExternalMessage,
  decideExternalChannels,
  isMuted,
  isValidScheduleInterval,
  nextScheduleRun,
  paymentRequestPath,
  rateLimitKeys,
  resolveReminderTarget,
} from "./policy";
import { defaultPreferences, type NewReminderEvent, type ReminderRepository } from "./repository";

export interface ReminderDeps {
  repo: ReminderRepository;
  canManageReminders?: (tripId: string, wallet: string) => Promise<boolean>;
  transport: ReminderTransport;
  rateLimit: (key: string, limit: number, windowMs: number) => Promise<{ allowed: boolean; resetMs: number }>;
  /** Absolute origin used to build links in external messages. */
  origin: string;
  /** Builds the one-click unsubscribe link for an external channel. */
  unsubscribeLink: (wallet: string, channel: ExternalReminderChannel) => string;
  now?: () => Date;
}

export type Failure = { ok: false; status: number; message: string; retryAfterMs?: number };

export interface SendReminderInput {
  senderWallet: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  note: string | null;
  trigger: ReminderTrigger;
  scheduleId?: string | null;
}

export type SendReminderResult = { ok: true; reminder: PaymentReminder; channels: ReminderChannel[] } | Failure;

/**
 * Sends one reminder. Called only from an explicit "Remind" action or a
 * user-created schedule; nothing in the app calls it on its own.
 */
export async function sendReminder(deps: ReminderDeps, input: SendReminderInput): Promise<SendReminderResult> {
  const { repo } = deps;

  // Read through the sender's session: RLS proves they can see this expense.
  const [expense, trip] = await Promise.all([repo.findExpense(input.expenseId), repo.findTrip(input.tripId)]);
  if (!trip || !trip.expenseIds.includes(input.expenseId)) {
    return { ok: false, status: 404, message: "That expense is not available to you." };
  }
  if (deps.canManageReminders && !(await deps.canManageReminders(input.tripId, input.senderWallet))) {
    return { ok: false, status: 403, message: "You do not have permission to manage reminders for this trip." };
  }
  const target = resolveReminderTarget(expense, input.memberId, input.senderWallet);
  if (!target.ok) return { ok: false, status: target.status, message: target.message };

  const keys = rateLimitKeys(input.senderWallet, target.recipientWallet, input.expenseId);
  const perShare = await deps.rateLimit(keys.perShare, REMINDER_LIMITS.perShare.limit, REMINDER_LIMITS.perShare.windowMs);
  if (!perShare.allowed) {
    return {
      ok: false,
      status: 429,
      message: `${target.share.name} was already reminded about this expense recently. Please wait before asking again.`,
      retryAfterMs: perShare.resetMs,
    };
  }
  const perSender = await deps.rateLimit(keys.perSender, REMINDER_LIMITS.perSender.limit, REMINDER_LIMITS.perSender.windowMs);
  if (!perSender.allowed) {
    return {
      ok: false,
      status: 429,
      message: "You have sent a lot of reminders today. Please try again later.",
      retryAfterMs: perSender.resetMs,
    };
  }

  const prefs = await repo.getPreferences(target.recipientWallet, "recipient");
  const muted = isMuted(prefs, input.tripId, input.senderWallet);

  const reminder = await repo.insertReminder({
    tripId: input.tripId,
    expenseId: input.expenseId,
    memberId: input.memberId,
    recipientWallet: target.recipientWallet,
    senderWallet: input.senderWallet,
    amount: target.amount,
    asset: expense ? settlementAssetOf(expense) : "native",
    note: input.note,
    trigger: input.trigger,
    scheduleId: input.scheduleId ?? null,
    // A muted reminder is still recorded, so history stays complete, but it is
    // hidden from the recipient's inbox and never leaves the app.
    state: muted ? "muted" : "delivered",
  });

  const events: NewReminderEvent[] = [
    {
      reminderId: reminder.id,
      actorWallet: input.senderWallet,
      kind: "sent",
      channel: "in_app",
      detail: input.trigger === "schedule" ? "scheduled" : "manual",
    },
  ];
  if (muted) {
    events.push({ reminderId: reminder.id, actorWallet: input.senderWallet, kind: "skipped", channel: "in_app", detail: "muted" });
  }

  const channels: ReminderChannel[] = muted ? [] : ["in_app"];
  const decisions = decideExternalChannels(
    prefs,
    muted,
    (channel) => deps.transport.isConfigured(channel),
    () => true,
  );

  for (const decision of decisions) {
    if (!decision.send) {
      // Not opting in is the default, not news; everything else is recorded.
      if (decision.reason !== "not_opted_in") {
        events.push({
          reminderId: reminder.id,
          actorWallet: input.senderWallet,
          kind: "skipped",
          channel: decision.channel,
          detail: decision.reason,
        });
      }
      continue;
    }

    const limit = await deps.rateLimit(
      keys.external(decision.channel),
      REMINDER_LIMITS.externalPerRecipient.limit,
      REMINDER_LIMITS.externalPerRecipient.windowMs,
    );
    if (!limit.allowed) {
      events.push({
        reminderId: reminder.id,
        actorWallet: input.senderWallet,
        kind: "skipped",
        channel: decision.channel,
        detail: "rate_limited",
      });
      continue;
    }

    const message = buildExternalMessage(
      `${deps.origin}${paymentRequestPath(reminder.id)}`,
      deps.unsubscribeLink(target.recipientWallet, decision.channel),
    );
    try {
      await deps.transport.send(decision.channel, decision.address, message);
      channels.push(decision.channel);
      events.push({ reminderId: reminder.id, actorWallet: input.senderWallet, kind: "delivered", channel: decision.channel });
    } catch {
      events.push({
        reminderId: reminder.id,
        actorWallet: input.senderWallet,
        kind: "skipped",
        channel: decision.channel,
        detail: "delivery_failed",
      });
    }
  }

  const onlyInApp = channels.length === 1 && channels[0] === "in_app";
  const saved = onlyInApp ? reminder : ((await repo.updateReminder(reminder.id, { channels })) ?? { ...reminder, channels });
  await repo.appendEvents(events);

  return { ok: true, reminder: saved, channels };
}

/**
 * What the request page shows. RLS returns the reminder only to its sender
 * and recipient; anyone else gets the same 404 as a missing id, so the link
 * reveals nothing until its owner signs in.
 */
export async function loadRequestContext(
  deps: ReminderDeps,
  viewerWallet: string,
  reminderId: string,
): Promise<{ ok: true; context: PaymentRequestContext } | Failure> {
  const { repo } = deps;
  const notFound: Failure = { ok: false, status: 404, message: "This payment request is not available." };

  let reminder = await repo.getReminder(reminderId);
  if (!reminder) return notFound;
  const viewerRole =
    reminder.recipientWallet === viewerWallet ? "recipient" : reminder.senderWallet === viewerWallet ? "sender" : null;
  if (!viewerRole) return notFound;

  const [expense, trip] = await Promise.all([repo.findExpense(reminder.expenseId), repo.findTrip(reminder.tripId)]);
  const share = expense?.shares.find((s) => s.memberId === reminder!.memberId) ?? null;
  const alreadyPaid = share?.paid ?? false;
  const outstanding = share && !share.paid ? (Money.tryParse(share.amount)?.format() ?? null) : share ? "0.0000000" : null;

  if (viewerRole === "recipient" && reminder.state === "delivered") {
    const now = (deps.now?.() ?? new Date()).toISOString();
    reminder = (await repo.updateReminder(reminder.id, { state: "read", readAt: now })) ?? reminder;
    await repo.appendEvents([{ reminderId: reminder.id, actorWallet: viewerWallet, kind: "read", channel: "in_app" }]);
  }

  return {
    ok: true,
    context: {
      reminder,
      viewerRole,
      tripName: trip?.name ?? null,
      expenseTitle: expense?.title ?? null,
      outstanding,
      alreadyPaid,
      history: await repo.listEvents(reminder.id),
    },
  };
}

export const REMINDER_ACTIONS: readonly ReminderAction[] = [
  "dismiss",
  "cancel",
  "mute_trip",
  "unmute_trip",
  "mute_sender",
  "unmute_sender",
];

/** Recipient choices (dismiss, mute) and the sender's cancel. All recorded. */
export async function applyReminderAction(
  deps: ReminderDeps,
  viewerWallet: string,
  reminderId: string,
  action: ReminderAction,
): Promise<{ ok: true; reminder: PaymentReminder; preferences?: ReminderPreferences } | Failure> {
  const { repo } = deps;
  const reminder = await repo.getReminder(reminderId);
  if (!reminder || ![reminder.recipientWallet, reminder.senderWallet].includes(viewerWallet)) {
    return { ok: false, status: 404, message: "This payment request is not available." };
  }

  if (action === "cancel") {
    if (reminder.senderWallet !== viewerWallet) {
      return { ok: false, status: 403, message: "Only the sender can cancel a request." };
    }
    const updated = (await repo.updateReminder(reminder.id, { state: "cancelled" })) ?? reminder;
    await repo.appendEvents([{ reminderId: reminder.id, actorWallet: viewerWallet, kind: "cancelled" }]);
    return { ok: true, reminder: updated };
  }

  if (reminder.recipientWallet !== viewerWallet) {
    return { ok: false, status: 403, message: "Only the recipient can do that." };
  }

  if (action === "dismiss") {
    const updated = (await repo.updateReminder(reminder.id, { state: "dismissed" })) ?? reminder;
    await repo.appendEvents([{ reminderId: reminder.id, actorWallet: viewerWallet, kind: "dismissed" }]);
    return { ok: true, reminder: updated };
  }

  const prefs = (await repo.getPreferences(viewerWallet, "own")) ?? defaultPreferences(viewerWallet);
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  const patch =
    action === "mute_trip" || action === "unmute_trip"
      ? { mutedTripIds: toggle(prefs.mutedTripIds, reminder.tripId, action === "mute_trip") }
      : { mutedSenderWallets: toggle(prefs.mutedSenderWallets, reminder.senderWallet, action === "mute_sender") };
  const preferences = await repo.savePreferences(viewerWallet, patch, "own");
  const kind = (
    { mute_trip: "muted_trip", unmute_trip: "unmuted_trip", mute_sender: "muted_sender", unmute_sender: "unmuted_sender" } as const
  )[action];
  await repo.appendEvents([{ reminderId: reminder.id, actorWallet: viewerWallet, kind }]);
  return { ok: true, reminder, preferences };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PreferencesInput {
  emailOptIn?: unknown;
  emailAddress?: unknown;
  pushOptIn?: unknown;
  pushEndpoint?: unknown;
}

/** Opt in or out of email/push. Opting in is always explicit, never assumed. */
export async function updatePreferences(
  deps: ReminderDeps,
  wallet: string,
  input: PreferencesInput,
): Promise<{ ok: true; preferences: ReminderPreferences } | Failure> {
  const { repo } = deps;
  const current = (await repo.getPreferences(wallet, "own")) ?? defaultPreferences(wallet);
  const patch: Partial<ReminderPreferences> = {};

  if (input.emailAddress !== undefined) {
    if (input.emailAddress === null || input.emailAddress === "") patch.emailAddress = null;
    else if (typeof input.emailAddress === "string" && input.emailAddress.length <= 254 && EMAIL_PATTERN.test(input.emailAddress.trim())) {
      patch.emailAddress = input.emailAddress.trim();
    } else return { ok: false, status: 400, message: "Enter a valid email address." };
  }
  if (input.pushEndpoint !== undefined) {
    if (input.pushEndpoint === null || input.pushEndpoint === "") patch.pushEndpoint = null;
    else if (typeof input.pushEndpoint === "string" && input.pushEndpoint.length <= 1024 && /^https:\/\//i.test(input.pushEndpoint)) {
      patch.pushEndpoint = input.pushEndpoint;
    } else return { ok: false, status: 400, message: "The push endpoint must be an https URL." };
  }
  for (const key of ["emailOptIn", "pushOptIn"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { ok: false, status: 400, message: `${key} must be true or false.` };
    patch[key] = value;
  }

  const next = { ...current, ...patch };
  if (next.emailOptIn && !next.emailAddress) {
    return { ok: false, status: 400, message: "Add an email address to turn on email reminders." };
  }
  if (next.pushOptIn && !next.pushEndpoint) {
    return { ok: false, status: 400, message: "Enable notifications on this device to turn on push reminders." };
  }

  const preferences = await repo.savePreferences(wallet, patch, "own");
  const events: NewReminderEvent[] = [];
  for (const [key, channel] of [["emailOptIn", "email"], ["pushOptIn", "push"]] as const) {
    if (patch[key] !== undefined && patch[key] !== current[key]) {
      events.push({ reminderId: null, actorWallet: wallet, kind: patch[key] ? "opted_in" : "opted_out", channel });
    }
  }
  await repo.appendEvents(events);
  return { ok: true, preferences };
}

/** One-click unsubscribe from an email/push message; only ever turns a channel off. */
export async function unsubscribe(
  deps: ReminderDeps,
  claims: { wallet: string; channel: ExternalReminderChannel },
): Promise<{ ok: true } | Failure> {
  const patch = claims.channel === "email" ? { emailOptIn: false } : { pushOptIn: false };
  await deps.repo.savePreferences(claims.wallet, patch, "service");
  await deps.repo.appendEvents([
    { reminderId: null, actorWallet: claims.wallet, kind: "unsubscribed", channel: claims.channel },
  ]);
  return { ok: true };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createSchedule(
  deps: ReminderDeps,
  ownerWallet: string,
  tripId: unknown,
  intervalDays: unknown,
): Promise<{ ok: true; schedule: ReminderSchedule } | Failure> {
  if (typeof tripId !== "string" || !/^[\w-]{1,64}$/.test(tripId)) {
    return { ok: false, status: 400, message: "A trip id is required." };
  }
  if (!isValidScheduleInterval(intervalDays)) {
    return { ok: false, status: 400, message: "Choose an interval between 1 and 30 days." };
  }
  if (!(await deps.repo.findTrip(tripId))) {
    return { ok: false, status: 404, message: "That trip is not available to you." };
  }
  const now = deps.now?.() ?? new Date();
  const schedule = await deps.repo.createSchedule({
    tripId,
    ownerWallet,
    intervalDays,
    nextRunAt: new Date(now.getTime() + intervalDays * DAY_MS).toISOString(),
  });
  await deps.repo.appendEvents([
    { reminderId: null, actorWallet: ownerWallet, kind: "schedule_created", detail: `every ${intervalDays} day(s)` },
  ]);
  return { ok: true, schedule };
}

export async function disableSchedule(
  deps: ReminderDeps,
  ownerWallet: string,
  scheduleId: string,
): Promise<{ ok: true } | Failure> {
  const disabled = await deps.repo.disableSchedule(scheduleId, ownerWallet);
  if (!disabled) return { ok: false, status: 404, message: "That schedule is not available to you." };
  await deps.repo.appendEvents([{ reminderId: null, actorWallet: ownerWallet, kind: "schedule_disabled" }]);
  return { ok: true };
}

export interface ScheduleRunResult {
  schedules: number;
  sent: number;
  skipped: number;
}

/**
 * Runs schedules that members created and that are due. With no schedules,
 * this sends nothing: there is no implicit or default reminder cadence.
 */
export async function runDueSchedules(deps: ReminderDeps, limit = 100): Promise<ScheduleRunResult> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.repo.listDueSchedules(now, limit);
  const result: ScheduleRunResult = { schedules: due.length, sent: 0, skipped: 0 };

  for (const schedule of due) {
    // Advance first, so a crash mid-run cannot make the next run fire twice.
    await deps.repo.advanceSchedule(schedule.id, nextScheduleRun(new Date(schedule.nextRunAt), schedule.intervalDays, now));

    const expenses = await deps.repo.listTripExpenses(schedule.tripId);
    for (const expense of expenses) {
      const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
      if (payer?.walletAddress !== schedule.ownerWallet) continue;
      for (const share of expense.shares) {
        if (share.paid || share.memberId === expense.paidByMemberId) continue;
        const sent = await sendReminder(deps, {
          senderWallet: schedule.ownerWallet,
          tripId: schedule.tripId,
          expenseId: expense.id,
          memberId: share.memberId,
          note: null,
          trigger: "schedule",
          scheduleId: schedule.id,
        });
        if (sent.ok) result.sent++;
        else result.skipped++;
      }
    }
  }
  return result;
}
