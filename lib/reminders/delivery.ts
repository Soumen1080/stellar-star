/**
 * lib/reminders/delivery.ts — external transports for reminders (#326).
 *
 * Email and push are handed to an operator-configured relay (an email API or
 * a push service) as a small JSON webhook, so no provider SDK is bundled:
 *
 *   REMINDER_EMAIL_WEBHOOK_URL   POST { channel, to, subject, text, link, unsubscribeLink }
 *   REMINDER_PUSH_WEBHOOK_URL    same body; `to` is the push endpoint
 *   REMINDER_WEBHOOK_SECRET      sent as `Authorization: Bearer <secret>`
 *
 * A channel without a URL is "unconfigured": the reminder is still delivered
 * in-app and the skip is recorded in its history.
 */

import type { ExternalReminderChannel } from "@/types/reminder";
import type { ExternalMessage } from "./policy";

export interface ReminderTransport {
  isConfigured(channel: ExternalReminderChannel): boolean;
  send(channel: ExternalReminderChannel, to: string, message: ExternalMessage): Promise<void>;
}

const DELIVERY_TIMEOUT_MS = 5_000;

function webhookUrl(channel: ExternalReminderChannel): string | undefined {
  const raw =
    channel === "email" ? process.env.REMINDER_EMAIL_WEBHOOK_URL : process.env.REMINDER_PUSH_WEBHOOK_URL;
  const url = raw?.trim();
  return url && /^https:\/\//i.test(url) ? url : undefined;
}

export const webhookTransport: ReminderTransport = {
  isConfigured(channel) {
    return Boolean(webhookUrl(channel));
  },
  async send(channel, to, message) {
    const url = webhookUrl(channel);
    if (!url) throw new Error(`${channel} delivery is not configured.`);
    const secret = process.env.REMINDER_WEBHOOK_SECRET?.trim();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ channel, to, ...message }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${channel} relay responded ${response.status}.`);
  },
};
