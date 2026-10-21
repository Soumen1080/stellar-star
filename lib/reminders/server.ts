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
import { isTripPermission, memberHasPermission, normalizeRole } from "@/lib/trip/roles";
import type { Trip } from "@/types/trip";
import type { Member } from "@/types/expense";

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
  const canManageReminders = async (tripId: string, wallet: string): Promise<boolean> => {
    if (clients.user) {
      const { data, error } = await clients.user.rpc("trip_has_permission", {
        p_trip_id: tripId,
        p_permission: "reminders.manage",
      });
      if (error) throw new Error(`Failed to check reminder permissions: ${error.message}`);
      return data === true;
    }

    if (!clients.service) return false;
    const { data, error } = await clients.service
      .from("trips")
      .select("id, name, members, expense_ids, settled, created_by_wallet, created_at")
      .eq("id", tripId)
      .maybeSingle();
    if (error) throw new Error(`Failed to check reminder permissions: ${error.message}`);
    if (!data) return false;
    const members: Member[] = Array.isArray(data.members)
      ? data.members.flatMap((entry): Member[] => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          if (typeof entry.id !== "string" || typeof entry.name !== "string") return [];
          const role = typeof entry.role === "string" ? normalizeRole(entry.role) : undefined;
          const customPermissions = Array.isArray(entry.customPermissions)
            ? entry.customPermissions.filter(isTripPermission)
            : undefined;
          return [{
            id: entry.id,
            name: entry.name,
            ...(typeof entry.walletAddress === "string" ? { walletAddress: entry.walletAddress } : {}),
            ...(role ? { role } : {}),
            ...(role === "custom" && customPermissions ? { customPermissions } : {}),
          }];
        })
      : [];
    const trip: Trip = {
      id: data.id,
      name: data.name,
      members,
      expenseIds: data.expense_ids ?? [],
      settled: data.settled,
      createdAt: data.created_at,
      createdByWallet: data.created_by_wallet,
    };
    const member = trip.members.find(
      (candidate) => candidate.walletAddress?.trim().toUpperCase() === wallet.trim().toUpperCase(),
    );
    return member ? memberHasPermission(member, "reminders.manage", trip) : false;
  };
  return {
    repo: supabaseReminderRepository(clients),
    canManageReminders,
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
