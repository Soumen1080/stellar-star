/**
 * lib/reminders/delivery.ts — external transports for reminders (#326, #428).
 *
 * Email and push are handed to an operator-configured relay (an email API or
 * a push service) as a small JSON webhook, with ordered compatible fallback
 * routing to a secondary relay when the primary is degraded or down.
 *
 *   REMINDER_EMAIL_WEBHOOK_URL   POST { channel, to, subject, text, link, unsubscribeLink }
 *   REMINDER_PUSH_WEBHOOK_URL    same body; `to` is the push endpoint
 *   REMINDER_BACKUP_WEBHOOK_URL  backup relay endpoint during primary outage
 *   REMINDER_WEBHOOK_SECRET      sent as `Authorization: Bearer <secret>`
 *
 * A channel without a URL is "unconfigured": the reminder is still delivered
 * in-app and the skip is recorded in its history.
 */

import type { ExternalReminderChannel } from "@/types/reminder";
import type { ExternalMessage } from "./policy";
import { executeWithFailover } from "@/lib/routing";

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
    const primaryUrl = webhookUrl(channel);
    if (!primaryUrl) throw new Error(`${channel} delivery is not configured.`);
    const backupUrl = process.env.REMINDER_BACKUP_WEBHOOK_URL?.trim();
    const secret = process.env.REMINDER_WEBHOOK_SECRET?.trim();
    const capability = channel === "email" ? "notification:email" : "notification:push";

    await executeWithFailover(
      {
        domain: "notification",
        capability,
      },
      async (provider) => {
        const targetUrl =
          provider.id === "notification-relay-backup" && backupUrl ? backupUrl : primaryUrl;

        const response = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify({ channel, to, ...message }),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });

        if (!response.ok) {
          throw new Error(`${channel} relay (${provider.name}) responded ${response.status}.`);
        }
      },
    );
  },
};
