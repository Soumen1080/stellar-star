/**
 * POST /api/exports/archive  (#324)
 *
 * Returns a portable JSON archive of the caller's trips: trips, expenses,
 * shares, exchange-rate provenance, per-asset balances and the full CSV.
 *
 * Body (optional): `{ "tripIds": ["…"] }` to export only some trips.
 *
 * Guarantees:
 *  - **Scoped.** Data is read with a client bound to the caller's session, so
 *    RLS returns only trips and expenses that wallet can already see. A
 *    requested trip id outside that set is refused (403) — never silently
 *    dropped, never revealed.
 *  - **Rate-limited** per wallet and per IP; exports are expensive.
 *  - **Audited.** Every request appends to `export_audit_events` (migration
 *    0011) with the caller's own session *before* data is returned. If the
 *    audit write fails the export is refused: no unaudited archive leaves.
 *  - **Exact.** Amounts stay decimal strings end to end.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";
import { buildArchive, exportFileStem } from "@/lib/export/tripExport";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { fetchExpenses, fetchTrips } from "@/lib/supabase/queries";
import type { StellarStarClient } from "@/lib/supabase/client";
import type { ExportAuditEventRow } from "@/types/supabase";
import { STELLAR_EXPLORER, STELLAR_NETWORK } from "@/lib/utils/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARCHIVE_LIMIT_PER_WALLET = 5;
const ARCHIVE_LIMIT_PER_IP = 20;
const ARCHIVE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTED_TRIPS = 100;

type AuditRecord = Pick<ExportAuditEventRow, "status"> &
  Partial<Pick<ExportAuditEventRow, "trip_ids" | "trip_count" | "expense_count" | "byte_size" | "content_sha256">>;

function hashIp(ip: string): string {
  const salt = process.env.EXPORT_AUDIT_IP_SALT || process.env.SUPABASE_JWT_SECRET || "";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

function json(body: unknown, status: number, requestId: string, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", [REQUEST_ID_HEADER]: requestId, ...headers },
  });
}

async function audit(
  client: StellarStarClient,
  wallet: string,
  requestId: string,
  ip: string,
  record: AuditRecord,
): Promise<boolean> {
  const { error } = await client.from("export_audit_events").insert({
    actor_wallet: wallet,
    export_kind: "archive",
    request_id: requestId,
    client_ip_hash: hashIp(ip),
    ...record,
  });
  return !error;
}

function parseTripIds(body: unknown): string[] | null | "invalid" {
  if (!body || typeof body !== "object" || !("tripIds" in body)) return null;
  const ids = (body as { tripIds: unknown }).tripIds;
  if (ids === undefined || ids === null) return null;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_REQUESTED_TRIPS ||
    !ids.every((id) => typeof id === "string" && /^[\w-]{1,64}$/.test(id))
  ) {
    return "invalid";
  }
  return [...new Set(ids as string[])];
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;
  if (!session) {
    return json({ error: "Sign in with your wallet to export your trips." }, 401, requestId);
  }
  if (!isServerSupabaseConfigured()) {
    return json({ error: "Database service is not configured on the server." }, 503, requestId);
  }

  let body: unknown = null;
  try {
    const textBody = await request.text();
    body = textBody ? JSON.parse(textBody) : null;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400, requestId);
  }
  const requested = parseTripIds(body);
  if (requested === "invalid") {
    return json({ error: `tripIds must be 1–${MAX_REQUESTED_TRIPS} trip ids.` }, 400, requestId);
  }

  const wallet = session.wallet_address;
  const ip = getClientIp(request);
  const client = createServerClientForToken(token);

  const [walletLimit, ipLimit] = await Promise.all([
    checkRateLimit(`export-archive:wallet:${wallet}`, ARCHIVE_LIMIT_PER_WALLET, ARCHIVE_WINDOW_MS),
    checkRateLimit(`export-archive:ip:${ip}`, ARCHIVE_LIMIT_PER_IP, ARCHIVE_WINDOW_MS),
  ]);
  if (!walletLimit.allowed || !ipLimit.allowed) {
    await audit(client, wallet, requestId, ip, { status: "rate_limited", trip_ids: requested ?? [] });
    const resetMs = Math.max(walletLimit.allowed ? 0 : walletLimit.resetMs, ipLimit.allowed ? 0 : ipLimit.resetMs);
    return json({ error: "Export limit reached. Please try again later." }, 429, requestId, {
      "Retry-After": String(Math.ceil(resetMs / 1000)),
    });
  }

  try {
    // RLS on this client is what scopes the archive to the caller.
    const [visibleTrips, visibleExpenses] = await Promise.all([fetchTrips(client), fetchExpenses(client)]);

    let trips = visibleTrips;
    if (requested) {
      const visibleIds = new Set(visibleTrips.map((t) => t.id));
      if (requested.some((id) => !visibleIds.has(id))) {
        await audit(client, wallet, requestId, ip, { status: "forbidden", trip_ids: requested });
        return json({ error: "One or more requested trips are not available to you." }, 403, requestId);
      }
      trips = visibleTrips.filter((t) => requested.includes(t.id));
    }

    const archive = buildArchive({
      wallet,
      network: STELLAR_NETWORK,
      explorerBase: STELLAR_EXPLORER,
      trips,
      expenses: visibleExpenses,
      includeUnassigned: !requested,
    });
    const payload = JSON.stringify(archive, null, 2);
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");

    const audited = await audit(client, wallet, requestId, ip, {
      status: "served",
      trip_ids: trips.map((t) => t.id),
      trip_count: archive.counts.trips,
      expense_count: archive.counts.expenses,
      byte_size: Buffer.byteLength(payload),
      content_sha256: sha256,
    });
    if (!audited) {
      // Fail closed: an export that cannot be recorded is not served.
      return json(
        { error: "The export could not be recorded, so it was not generated. Apply migrations/0011 and retry." },
        503,
        requestId,
      );
    }

    const fileName = `${exportFileStem(trips.length === 1 ? trips[0].name : "stellar-star-archive")}.json`;
    return new NextResponse(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Content-SHA256": sha256,
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  } catch (err) {
    await audit(client, wallet, requestId, ip, { status: "failed", trip_ids: requested ?? [] });
    const message = err instanceof Error ? err.message : "Failed to build the archive.";
    return json({ error: message }, 500, requestId);
  }
}
