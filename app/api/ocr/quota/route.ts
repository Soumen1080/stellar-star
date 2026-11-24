/**
 * GET /api/ocr/quota — Returns the caller's current OCR quota usage.
 *
 * Query params:
 *   - tripId (optional): also return per-trip usage.
 */

import { type NextRequest } from "next/server";
import { receiptClients, receiptError, receiptJson, isUuid } from "@/lib/receipts/http";
import { getQuotaUsage } from "@/lib/receipts/ocr/quota";

export async function GET(request: NextRequest) {
  const auth = receiptClients(request);
  if ("response" in auth) return auth.response;
  const { wallet, serviceClient } = auth;

  const { searchParams } = new URL(request.url);
  const tripId = searchParams.get("tripId");
  if (tripId && !isUuid(tripId)) return receiptError("Invalid trip ID.", 400);

  try {
    const usage = await getQuotaUsage(serviceClient, wallet, tripId);
    return receiptJson({ data: usage });
  } catch {
    return receiptError("Could not check quota usage.", 500);
  }
}
