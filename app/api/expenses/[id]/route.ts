/**
 * app/api/expenses/[id]/route.ts
 *
 * Expense Retrieval and Version-Controlled Editing Endpoint (Issue #315).
 *
 * Acceptance Criteria:
 * 1. Only authorized trip members can edit an unsettled expense.
 * 2. Displays latest version and supports reload/merge on concurrent conflict (409 Conflict).
 * 3. Recomputes shares using exact money arithmetic and blocks invalid totals.
 * 4. Settled or partially settled amounts cannot be changed in place.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { fetchExpenseById, updateExpenseRow } from "@/lib/supabase/queries";
import {
  mergeExpenseUpdates,
  ExpenseConflictError,
  recomputeSharesWithSettled,
} from "@/lib/expense/conflictResolver";
import { Money } from "@/lib/money";
import type { Expense } from "@/types/expense";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized: Sign in with your wallet." }, { status: 401 });
  }

  const client = isServerSupabaseConfigured()
    ? createServerClientForToken(token)
    : undefined;

  const expense = await fetchExpenseById(id, client as any);
  if (!expense) {
    return NextResponse.json({ error: "Expense not found." }, { status: 404 });
  }

  // Authorization check: User must be in expense members
  const callerWallet = session.wallet_address.toUpperCase();
  const isMember = expense.members.some(
    (m) => m.walletAddress && m.walletAddress.toUpperCase() === callerWallet
  );

  if (!isMember) {
    return NextResponse.json(
      { error: "Forbidden: You are not a participant in this expense." },
      { status: 403 }
    );
  }

  return NextResponse.json({ ok: true, data: expense }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Expense ID is required." }, { status: 400 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized: Sign in with your wallet." }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const client = isServerSupabaseConfigured()
    ? createServerClientForToken(token)
    : undefined;

  const existing = await fetchExpenseById(id, client as any);
  if (!existing) {
    return NextResponse.json({ error: "Expense not found." }, { status: 404 });
  }

  // Acceptance criteria 1: Only authorized trip members can edit
  const callerWallet = session.wallet_address.toUpperCase();
  const isMember = existing.members.some(
    (m) => m.walletAddress && m.walletAddress.toUpperCase() === callerWallet
  );

  if (!isMember) {
    return NextResponse.json(
      { error: "Forbidden: Only authorized expense participants can modify this expense." },
      { status: 403 }
    );
  }

  // Acceptance criteria 4: Settled expenses cannot be edited in place
  if (existing.settled) {
    return NextResponse.json(
      {
        error: "This expense is settled and cannot be edited in place. See the corrective adjustment flow.",
        code: "EXPENSE_SETTLED_IMMUTABLE",
      },
      { status: 400 }
    );
  }

  const { updates, expectedVersion, baseExpense } = body;
  if (!updates || typeof updates !== "object") {
    return NextResponse.json({ error: "Missing updates object." }, { status: 400 });
  }

  // Acceptance criteria 3: Exact money arithmetic & block invalid total
  if (updates.totalAmount !== undefined) {
    const parsedTotal = Money.tryParse(String(updates.totalAmount));
    if (!parsedTotal || parsedTotal.isZero() || parsedTotal.isNegative()) {
      return NextResponse.json(
        { error: "Total amount must be a valid number greater than zero.", code: "INVALID_TOTAL_AMOUNT" },
        { status: 400 }
      );
    }
  }

  // Check version conflict using OCC
  const base: Expense = baseExpense ?? {
    ...existing,
    version: expectedVersion !== undefined ? expectedVersion : existing.version,
  };

  const mergeResult = mergeExpenseUpdates(base, existing, updates);
  if (!mergeResult.success) {
    // Return HTTP 409 Conflict with full conflict details for the client reload/merge modal
    return NextResponse.json(
      {
        error: mergeResult.conflict.reason,
        code: "CONCURRENT_MODIFICATION",
        conflict: mergeResult.conflict,
      },
      { status: 409 }
    );
  }

  try {
    const saved = await updateExpenseRow(id, mergeResult.merged, existing, client as any);
    return NextResponse.json(
      { ok: true, data: saved, autoMerged: mergeResult.autoMerged },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    if (err instanceof ExpenseConflictError) {
      return NextResponse.json(
        {
          error: err.reason,
          code: err.code,
          conflict: {
            fields: err.conflicts,
            reason: err.reason,
            serverExpense: err.serverExpense,
            proposedUpdates: updates,
          },
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: err?.message || "Failed to update expense." },
      { status: 500 }
    );
  }
}
