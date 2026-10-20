/**
 * One-click unsubscribe links for external reminders (#326). Server only.
 *
 * The link must work from an email client without signing in, so it carries
 * an HMAC-signed `(wallet, channel, expiry)` instead of a session. It can only
 * ever turn a channel *off* — it grants nothing else.
 */

import crypto from "node:crypto";
import type { ExternalReminderChannel } from "@/types/reminder";

const TTL_SECONDS = 60 * 60 * 24 * 90;

function secret(): string {
  const value = process.env.REMINDER_UNSUBSCRIBE_SECRET || process.env.SUPABASE_JWT_SECRET || "";
  if (!value) throw new Error("No secret configured for reminder unsubscribe links.");
  return value;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(`reminder-unsubscribe:${payload}`).digest("base64url");
}

export function createUnsubscribeToken(
  wallet: string,
  channel: ExternalReminderChannel,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.from(JSON.stringify({ w: wallet, c: channel, e: nowSeconds + TTL_SECONDS })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload)}`;
}

export function verifyUnsubscribeToken(
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { wallet: string; channel: ExternalReminderChannel } | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      w?: unknown;
      c?: unknown;
      e?: unknown;
    };
    if (typeof parsed.w !== "string" || (parsed.c !== "email" && parsed.c !== "push")) return null;
    if (typeof parsed.e !== "number" || parsed.e < nowSeconds) return null;
    return { wallet: parsed.w, channel: parsed.c };
  } catch {
    return null;
  }
}
