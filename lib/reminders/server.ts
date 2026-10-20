/**
 * Request plumbing shared by the /api/reminders routes (#326). Server only.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/auth/rateLimiter";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import {
  createServerClientForToken,
  createServiceRoleClient,
  isServerSupabaseConfigured,
} from "@/lib/supabase/server";
import type { StellarStarClient } from "@/lib/supabase/client";
import { webhookTransport } from "./delivery";
import { supabaseReminderRepository } from "./repository";
import type { ReminderDeps } from "./service";
import { createUnsubscribeToken } from "./unsubscribe";

export function json(body: unknown, status: number, requestId: string, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId, ...headers },
  });
}

/** Absolute origin for links that leave the app. */
export function appOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  return configured || request.nextUrl.origin;
}

export function buildDeps(
  request: NextRequest,
  clients: { user: StellarStarClient | null; service: StellarStarClient | null },
): ReminderDeps {
  const origin = appOrigin(request);
  return {
    repo: supabaseReminderRepository(clients),
    transport: webhookTransport,
    rateLimit: (key, limit, windowMs) => checkRateLimit(key, limit, windowMs),
    origin,
    unsubscribeLink: (wallet, channel) =>
      `${origin}/api/reminders/unsubscribe?token=${encodeURIComponent(createUnsubscribeToken(wallet, channel))}`,
  };
}

export type AuthedRequest =
  | { ok: true; wallet: string; requestId: string; deps: ReminderDeps }
  | { ok: false; response: NextResponse };

/** Every reminder route except unsubscribe and the cron runner requires a wallet session. */
export function authenticate(request: NextRequest): AuthedRequest {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;
  if (!session) {
    return { ok: false, response: json({ error: "Sign in with your wallet to continue." }, 401, requestId) };
  }
  if (!isServerSupabaseConfigured()) {
    return { ok: false, response: json({ error: "Database service is not configured on the server." }, 503, requestId) };
  }
  return {
    ok: true,
    wallet: session.wallet_address,
    requestId,
    deps: buildDeps(request, { user: createServerClientForToken(token), service: createServiceRoleClient() }),
  };
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    const body = text ? JSON.parse(text) : {};
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const ID_PATTERN = /^[\w-]{1,64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
