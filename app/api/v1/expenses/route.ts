import { NextRequest } from "next/server";
import {
  apiIdempotencyClient,
  authenticateApiRequest,
  recordAuditLog,
} from "@/lib/api/middleware";
import { runIdempotentMutation } from "@/lib/idempotency/route";
import { EXPENSE_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";
import { fetchTripById, fetchExpensesForTrip, insertExpense } from "@/lib/api/data";
import { memberHasPermission } from "@/lib/trip/roles";
import { enqueueWebhookEvent } from "@/lib/api/webhooks";
import type { Expense } from "@/types/expense";
import { parseJsonBody, limitedJson, responseLimitFor } from "@/lib/api/bodyLimits";

/** Every JSON response here is size-capped (#418). */
const respond = (body: unknown, init?: ResponseInit) =>
  limitedJson(body, init, responseLimitFor("/api/v1/expenses"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["expenses:read"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const url = new URL(request.url);
  const tripId = url.searchParams.get("trip_id");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 100);

  if (!tripId) {
    return respond(
      {
        error: {
          code: "MISSING_PARAMETER",
          message: "Query parameter 'trip_id' is required.",
          status: 400,
        },
      },
      { status: 400 }
    );
  }

  const { expenses, hasMore } = await fetchExpensesForTrip(
    tripId,
    tokenPayload.walletAddress,
    limit
  );

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "GET",
    path: "/api/v1/expenses",
    statusCode: 200,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  return respond({
    data: expenses,
    pagination: {
      limit,
      has_more: hasMore,
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["expenses:write"],
    requireIdempotencyKey: true,
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const idempotencyKey = auth.context.idempotencyKey as string;

  let body: any;
  const parsedBody = await parseJsonBody(request, { route: "/api/v1/expenses", format: "v1" });
  if (!parsedBody.ok) return parsedBody.response;
  body = parsedBody.value;

  const { trip_id, title, total_amount, currency, split_mode } = body;

  if (!trip_id || !title || !total_amount) {
    return respond(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Fields 'trip_id', 'title', and 'total_amount' are required.",
          status: 400,
        },
      },
      { status: 400 }
    );
  }

  // Authorization check on trip
  const trip = await fetchTripById(trip_id, tokenPayload.walletAddress);
  if (!trip) {
    return respond(
      {
        error: {
          code: "NOT_FOUND",
          message: "Trip not found or caller lacks permission to add expenses to it.",
          status: 404,
        },
      },
      { status: 404 }
    );
  }
  const callerMember = trip.members.find(
    (member) => member.walletAddress?.trim().toUpperCase() === tokenPayload.walletAddress.trim().toUpperCase(),
  );
  if (!callerMember || !memberHasPermission(callerMember, "expenses.manage", trip)) {
    return respond(
      {
        error: {
          code: "FORBIDDEN",
          message: "Caller lacks permission to add expenses to this trip.",
          status: 403,
        },
      },
      { status: 403 },
    );
  }

  const expenseId = crypto.randomUUID();
  const expense: Expense = {
    id: expenseId,
    title: String(title).trim(),
    description: body.description ? String(body.description).trim() : undefined,
    totalAmount: String(total_amount),
    currency: (currency || "XLM").toUpperCase(),
    splitMode: split_mode === "custom" ? "custom" : "equal",
    paidByMemberId: trip.members[0]?.id || crypto.randomUUID(),
    members: trip.members,
    shares: trip.members.map((m) => ({
      memberId: m.id,
      name: m.name,
      amount: (parseFloat(total_amount) / (trip.members.length || 1)).toFixed(7),
      paid: m.walletAddress === tokenPayload.walletAddress,
    })),
    createdAt: new Date().toISOString(),
    settled: false,
  };

  const created = await insertExpense(expense, trip_id);

  // Trigger webhook event
  enqueueWebhookEvent({
    id: created.id,
    event: "expense.created",
    data: {
      expense_id: created.id,
      trip_id,
      title: created.title,
      total_amount: created.totalAmount,
      currency: created.currency,
      created_at: created.createdAt,
    },
  });

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "POST",
    path: "/api/v1/expenses",
    statusCode: response.status,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey,
  });

  return response;
}
