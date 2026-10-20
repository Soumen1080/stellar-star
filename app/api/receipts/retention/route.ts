import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { purgeExpiredReceipts } from "@/lib/receipts/store";
import { errorResponse, receiptError, receiptJson } from "@/lib/receipts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Retention sweep for receipts (issue #318). Meant for a scheduler such as
 * Vercel Cron, which calls GET with `Authorization: Bearer $CRON_SECRET`.
 * Disabled (401) when CRON_SECRET is unset.
 */
async function sweep(request: NextRequest) {
  if (!authorized(request)) return receiptError("Unauthorized.", 401);
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) return receiptError("Receipt storage is not configured on this server.", 503);
  try {
    return receiptJson({ data: await purgeExpiredReceipts(serviceClient) });
  } catch (err) {
    return errorResponse(err);
  }
}

export const GET = sweep;
export const POST = sweep;
