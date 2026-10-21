import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import {
  searchExpenseHistory,
  insertExpense,
  parsePaginationParams,
} from "@/lib/supabase/queries";
import {
  decodeHistoryCursor,
  parseHistoryFilters,
  parseTimezoneOffset,
  parseTripIdFilter,
} from "@/lib/expense/historyFilters";
import { normalizeCategory } from "@/lib/expense/categories";
import { normalizeTags, validateTags } from "@/lib/expense/tags";
import {
  extractIdempotencyKey,
  withIdempotency,
  idempotentJsonResponse,
  IdempotencyConflictError,
  IdempotencyLockedError,
} from "@/lib/idempotency/store";
import type { Expense } from "@/types/expense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to view expenses." },
      { status: 401 }
    );
  }

  // History is keyset-paginated and filtered in the database, so a trip with
  // thousands of expenses is still served one page at a time. See
  // lib/expense/historyFilters.ts for the filter keys.
  const { searchParams } = request.nextUrl;

  let query;
  try {
    const { limit } = parsePaginationParams({ limit: searchParams.get("limit") });
    query = {
      limit,
      cursor: decodeHistoryCursor(searchParams.get("cursor")),
      tripId: parseTripIdFilter(searchParams.get("tripId")),
      tzOffsetMinutes: parseTimezoneOffset(searchParams.get("tzOffset")),
      filters: parseHistoryFilters(searchParams, { strict: true }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid query parameters.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServerClientForToken(token);
    const result = await searchExpenseHistory(query, client);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load expenses.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to create an expense." },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { title, totalAmount, currency, splitMode, paidByMemberId, members, shares } = body ?? {};
  if (!title || typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: "Expense title is required." }, { status: 400 });
  }

  if (!totalAmount || typeof totalAmount !== "string" || Number.isNaN(parseFloat(totalAmount))) {
    return NextResponse.json({ error: "Valid totalAmount is required." }, { status: 400 });
  }

  if (!paidByMemberId || typeof paidByMemberId !== "string") {
    return NextResponse.json({ error: "paidByMemberId is required." }, { status: 400 });
  }

  if (!Array.isArray(members) || members.length < 2) {
    return NextResponse.json(
      { error: "Expense must have at least two members." },
      { status: 400 }
    );
  }

  let category: Expense["category"];
  let tags: string[];
  try {
    category = normalizeCategory(body.category);
    if (body.tags !== undefined && !Array.isArray(body.tags)) {
      throw new Error("tags must be an array of strings.");
    }
    tags = normalizeTags(body.tags);
    const tagError = validateTags(tags);
    if (tagError) throw new Error(tagError);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid category or tags.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServerClientForToken(token);
    const idempotencyKey = extractIdempotencyKey(request, body);

    const expenseToSave: Expense = {
      id: body.id || crypto.randomUUID(),
      title: title.trim(),
      description: body.description?.trim() || undefined,
      totalAmount,
      currency: currency || "XLM",
      exchangeRate: body.exchangeRate,
      exchangeRateTimestamp: body.exchangeRateTimestamp,
      category,
      tags,
      splitMode: splitMode || "equal",
      paidByMemberId,
      members,
      shares: shares ?? [],
      settled: false,
      version: 1,
      createdAt: new Date().toISOString(),
    };

    const idempotentResult = await withIdempotency({
      client,
      key: idempotencyKey,
      walletAddress: session.wallet_address,
      endpoint: "/api/expenses",
      payload: body,
      execute: async () => {
        const saved = await insertExpense(expenseToSave, session.wallet_address, client);
        return { data: saved, status: 201 };
      },
    });

    return idempotentJsonResponse(idempotentResult);
  } catch (err) {
    if (err instanceof IdempotencyConflictError || err instanceof IdempotencyLockedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 }
      );
    }
    const message = err instanceof Error ? err.message : "Failed to create expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
