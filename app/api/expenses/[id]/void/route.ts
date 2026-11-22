import { NextRequest, NextResponse } from "next/server";
import { isServerSupabaseConfigured } from "@/lib/supabase/server";
import { voidExpenseRow, fetchExpenseById } from "@/lib/supabase/queries";
import { canVoidExpense, validateAuditReason } from "@/lib/expense/corrections";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { EXPENSE_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: Sign in with your wallet to void an expense." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  let body: any;
  const parsedBody = await parseJsonBody(request, { route: "/api/expenses/[id]/void" });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;

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
    const client = auth.ctx.db();
    // The "already voided?" check runs inside the claim, so a retry of a void
    // that succeeded replays its 200 instead of failing that check.
    return await runIdempotentMutation({
      request,
      client,
      key: idempotency.key,
      replayFields: ["message", ...replayFieldsUnder("data", EXPENSE_REPLAY_FIELDS)],
      principal: session.wallet_address,
      payload: { reason: auditReason },
      execute: async () => {
        const expense = await fetchExpenseById(id, client);
        if (!expense) {
          return NextResponse.json({ error: "Expense not found." }, { status: 404 });
        }

        const check = canVoidExpense(expense, session.wallet_address);
        if (!check.allowed) {
          return NextResponse.json({ error: check.reason || "Expense cannot be voided." }, { status: 400 });
        }

        const voided = await voidExpenseRow(id, auditReason, client);
        return NextResponse.json(
          { data: voided, message: "Expense voided successfully." },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Failed to void expense.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
