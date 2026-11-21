import { NextRequest, NextResponse } from "next/server";
import {
  apiIdempotencyClient,
  authenticateApiRequest,
  recordAuditLog,
} from "@/lib/api/middleware";
import { runIdempotentMutation } from "@/lib/idempotency/route";
import { fetchTripById, fetchExpensesForTrip, insertExpense } from "@/lib/api/data";
import { memberHasPermission } from "@/lib/trip/roles";
import { dispatchWebhookEvent } from "@/lib/api/webhooks";
import { enqueueOutboxEvent, completeOutboxEvent } from "@/lib/outbox";
import type { Expense } from "@/types/expense";

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
    return NextResponse.json(
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

  return NextResponse.json({
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
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body.", status: 400 } },
      { status: 400 }
    );
  }

  const { trip_id, title, total_amount, currency, split_mode } = body;

  if (!trip_id || !title || !total_amount) {
    return NextResponse.json(
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
    return NextResponse.json(
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
    return NextResponse.json(
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

  // Creation, outbox enqueue and eager dispatch run once per key; a retry
  // replays the 201 instead of inserting a second expense.
  const response = await runIdempotentMutation({
    request,
    client: apiIdempotencyClient(),
    key: idempotencyKey,
    principal: tokenPayload.walletAddress,
    payload: body,
    format: "v1",
    execute: async () => {
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

      // Transactional outbox durable promise (#425):
      // Persist outbox event in the same transaction to guarantee eventual delivery
      // even if synchronous webhook dispatch fails or network disconnects.
      const traceId = crypto.randomUUID();
      const outboxEvent = await enqueueOutboxEvent({
        aggregateType: "expense",
        aggregateId: created.id,
        eventType: "expense.created",
        channel: "webhook",
        payload: {
          expense_id: created.id,
          trip_id,
          title: created.title,
          total_amount: created.totalAmount,
          currency: created.currency,
          created_at: created.createdAt,
        },
        traceId,
        deduplicationKey: `outbox:webhook:expense:${created.id}:created`,
        createdByWallet: tokenPayload.walletAddress,
      });

      // Attempt eager dispatch; on failure or timeout, outbox worker handles retry
      dispatchWebhookEvent({
        event: "expense.created",
        data: {
          expense_id: created.id,
          trip_id,
          title: created.title,
          total_amount: created.totalAmount,
          currency: created.currency,
          created_at: created.createdAt,
          _outboxId: outboxEvent.id,
          _traceId: traceId,
        },
        walletAddress: tokenPayload.walletAddress,
      })
        .then(() => {
          completeOutboxEvent(outboxEvent.id, "inline-dispatch");
        })
        .catch(() => {
          // Post-commit failure safely retained in outbox table for worker retry
        });

      return NextResponse.json({ data: created }, { status: 201 });
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
