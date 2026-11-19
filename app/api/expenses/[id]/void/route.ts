import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { voidExpenseRow, fetchExpenseById } from "@/lib/supabase/queries";
import { canVoidExpense, validateAuditReason } from "@/lib/expense/corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to void an expense." },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  let auditReason: string;
  try {
    auditReason = validateAuditReason(body?.reason);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "A valid audit reason is required." }, { status: 400 });
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServerClientForToken(token);
    const expense = await fetchExpenseById(id, client);
    if (!expense) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }

    const check = canVoidExpense(expense, session.wallet_address);
    if (!check.allowed) {
      return NextResponse.json({ error: check.reason || "Expense cannot be voided." }, { status: 400 });
    }

    const voided = await voidExpenseRow(id, auditReason, client);
    return NextResponse.json({ data: voided, message: "Expense voided successfully." });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Failed to void expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
