/**
 * lib/reminders/policy.ts — the rules for reminders and payment requests (#326).
 *
 * Pure: no I/O, so every rule here is unit-tested directly.
 *
 * Invariants:
 * 1. Only the payer of an expense (the creditor) may ask for a share of it,
 *    only for an unpaid share, and never of themselves.
 * 2. In-app delivery is always on. Email and push go out only when the
 *    recipient opted in, has not muted the trip or the sender, and is under
 *    the per-channel rate limit.
 * 3. Nothing private leaves the app: an external message carries a generic
 *    line and the opaque request link, never the trip, expense, amount or
 *    sender. The link page requires sign-in before it shows any of that.
 * 4. Nothing is sent on its own. A reminder exists only because a member
 *    clicked "Remind" or configured a schedule (`ReminderTrigger`).
 */

import { Money } from "@/lib/money";
import type { Expense, SplitShare } from "@/types/expense";
import type {
  ExternalReminderChannel,
  ReminderChannel,
  ReminderPreferences,
} from "@/types/reminder";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rate limits. Polite by default: one nudge per share per day. */
export const REMINDER_LIMITS = {
  /** Same sender, same recipient, same expense. */
  perShare: { limit: 1, windowMs: DAY_MS },
  /** Everything one sender sends. */
  perSender: { limit: 30, windowMs: DAY_MS },
  /** External messages a recipient receives on one channel. */
  externalPerRecipient: { limit: 3, windowMs: DAY_MS },
} as const;

export const MAX_NOTE_LENGTH = 280;
export const MIN_SCHEDULE_INTERVAL_DAYS = 1;
export const MAX_SCHEDULE_INTERVAL_DAYS = 30;

export type ReminderTargetResult =
  | { ok: true; share: SplitShare; recipientWallet: string; amount: string }
  | { ok: false; status: 400 | 403 | 404 | 409; message: string };

/** Decides whether `senderWallet` may ask the member `memberId` for their share. */
export function resolveReminderTarget(
  expense: Expense | null,
  memberId: string,
  senderWallet: string,
): ReminderTargetResult {
  if (!expense) return { ok: false, status: 404, message: "That expense is not available to you." };

  const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
  if (!payer?.walletAddress || payer.walletAddress !== senderWallet) {
    return { ok: false, status: 403, message: "Only the member who paid this expense can request it." };
  }

  const share = expense.shares.find((s) => s.memberId === memberId);
  if (!share) return { ok: false, status: 404, message: "That share is not on this expense." };
  if (share.memberId === expense.paidByMemberId) {
    return { ok: false, status: 400, message: "You cannot send a payment request to yourself." };
  }
  if (share.paid) return { ok: false, status: 409, message: "That share is already paid." };

  const recipientWallet =
    share.walletAddress || expense.members.find((m) => m.id === memberId)?.walletAddress || "";
  if (!recipientWallet) {
    return { ok: false, status: 409, message: `${share.name} has no wallet yet, so they cannot be reminded.` };
  }
  if (recipientWallet === senderWallet) {
    return { ok: false, status: 400, message: "You cannot send a payment request to yourself." };
  }

  const amount = Money.tryParse(share.amount);
  if (!amount || !amount.isPositive()) {
    return { ok: false, status: 409, message: "That share has nothing due." };
  }

  return { ok: true, share, recipientWallet, amount: amount.format() };
}

/** Trims and bounds an optional note; control characters are dropped. */
export function normalizeNote(raw: unknown): string | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  // eslint-disable-next-line no-control-regex
  const note = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!note) return null;
  if (note.length > MAX_NOTE_LENGTH) return "invalid";
  return note;
}

export function isMuted(
  prefs: ReminderPreferences | null,
  tripId: string,
  senderWallet: string,
): boolean {
  if (!prefs) return false;
  return prefs.mutedTripIds.includes(tripId) || prefs.mutedSenderWallets.includes(senderWallet);
}

export type ChannelDecision =
  | { channel: ExternalReminderChannel; send: true; address: string }
  | {
      channel: ExternalReminderChannel;
      send: false;
      reason: "not_opted_in" | "no_address" | "muted" | "rate_limited" | "unconfigured";
    };

/**
 * Which external channels a reminder may use. `underLimit` and `configured`
 * are answered by the caller (rate limiter, transport config).
 */
export function decideExternalChannels(
  prefs: ReminderPreferences | null,
  muted: boolean,
  configured: (channel: ExternalReminderChannel) => boolean,
  underLimit: (channel: ExternalReminderChannel) => boolean,
): ChannelDecision[] {
  const decisions: ChannelDecision[] = [];
  const candidates: Array<[ExternalReminderChannel, boolean, string | null]> = [
    ["email", prefs?.emailOptIn ?? false, prefs?.emailAddress ?? null],
    ["push", prefs?.pushOptIn ?? false, prefs?.pushEndpoint ?? null],
  ];

  for (const [channel, optedIn, address] of candidates) {
    if (!optedIn) decisions.push({ channel, send: false, reason: "not_opted_in" });
    else if (muted) decisions.push({ channel, send: false, reason: "muted" });
    else if (!address) decisions.push({ channel, send: false, reason: "no_address" });
    else if (!configured(channel)) decisions.push({ channel, send: false, reason: "unconfigured" });
    else if (!underLimit(channel)) decisions.push({ channel, send: false, reason: "rate_limited" });
    else decisions.push({ channel, send: true, address });
  }
  return decisions;
}

/** The deep link for a request. The id is opaque; the page requires sign-in. */
export function paymentRequestPath(reminderId: string): string {
  return `/requests/${encodeURIComponent(reminderId)}`;
}

export interface ExternalMessage {
  subject: string;
  text: string;
  link: string;
  unsubscribeLink: string;
}

/**
 * The only content that ever leaves the app. Deliberately generic: no trip
 * name, no expense, no amount, no sender — those are behind sign-in.
 */
export function buildExternalMessage(link: string, unsubscribeLink: string): ExternalMessage {
  return {
    subject: "You have a payment request on StellarStar",
    text:
      "A member of one of your groups has sent you a payment request. " +
      `Sign in with your wallet to see the details: ${link}\n\n` +
      `To stop these messages: ${unsubscribeLink}`,
    link,
    unsubscribeLink,
  };
}

export function isValidScheduleInterval(days: unknown): days is number {
  return (
    typeof days === "number" &&
    Number.isInteger(days) &&
    days >= MIN_SCHEDULE_INTERVAL_DAYS &&
    days <= MAX_SCHEDULE_INTERVAL_DAYS
  );
}

/** Next run strictly after `now`, so a late cron run never fires twice. */
export function nextScheduleRun(previous: Date, intervalDays: number, now: Date): Date {
  let next = previous.getTime() + intervalDays * DAY_MS;
  while (next <= now.getTime()) next += intervalDays * DAY_MS;
  return new Date(next);
}

export function rateLimitKeys(senderWallet: string, recipientWallet: string, expenseId: string) {
  return {
    perShare: `reminder:share:${senderWallet}:${recipientWallet}:${expenseId}`,
    perSender: `reminder:sender:${senderWallet}`,
    external: (channel: ReminderChannel) => `reminder:external:${channel}:${recipientWallet}`,
  };
}
