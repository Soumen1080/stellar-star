import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import {
  fetchExpensesPaginated,
  insertExpense,
  parsePaginationParams,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/supabase/queries";
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

  const { searchParams } = request.nextUrl;
  const rawLimit = searchParams.get("limit");
  const rawCursor = searchParams.get("cursor");
  const rawOffset = searchParams.get("offset");
  const tripId = searchParams.get("tripId") || undefined;

  let parsed;
  try {
    parsed = parsePaginationParams({
      limit: rawLimit,
      cursor: rawCursor,
      offset: rawOffset,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid pagination parameters.";
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
    const result = await fetchExpensesPaginated(parsed, client, { tripId });
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

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServerClientForToken(token);
    const expenseToSave: Expense = {
      id: body.id || crypto.randomUUID(),
      title: title.trim(),
      description: body.description?.trim() || undefined,
      totalAmount,
      currency: currency || "XLM",
      exchangeRate: body.exchangeRate,
      exchangeRateTimestamp: body.exchangeRateTimestamp,
      splitMode: splitMode || "equal",
      paidByMemberId,
      members,
      shares: shares ?? [],
      settled: false,
      version: 1,
      createdAt: new Date().toISOString(),
    };

    const saved = await insertExpense(expenseToSave, session.wallet_address, client);
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
