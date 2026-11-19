import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { insertExpense, fetchExpenseById, addExpenseIdToTrip } from "@/lib/supabase/queries";
import {
  canCorrectExpense,
  buildLinkedReversal,
  buildLinkedAdjustment,
  validateAuditReason,
} from "@/lib/expense/corrections";

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
      { error: "Unauthorized: Sign in with your wallet to correct an expense." },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { correctionType, reason, adjustedTotalAmount, title, newSplitMode, customWeights, tripId } = body ?? {};

  if (!["reversal", "adjustment", "offset"].includes(correctionType)) {
    return NextResponse.json(
      { error: "Choose a valid correction type: reversal, adjustment, or offset." },
      { status: 400 }
    );
  }

  let auditReason: string;
  try {
    auditReason = validateAuditReason(reason);
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
    const originalExpense = await fetchExpenseById(id, client);
    if (!originalExpense) {
      return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    }

    const check = canCorrectExpense(originalExpense, session.wallet_address);
    if (!check.allowed) {
      return NextResponse.json({ error: check.reason || "Expense cannot be corrected." }, { status: 400 });
    }

    let correctionRecord;
    if (correctionType === "reversal") {
      correctionRecord = buildLinkedReversal({
        originalExpense,
        reason: auditReason,
        actorWallet: session.wallet_address,
      });
    } else {
      if (!adjustedTotalAmount || typeof adjustedTotalAmount !== "string") {
        return NextResponse.json({ error: "Adjusted total amount is required for adjustments." }, { status: 400 });
      }
      correctionRecord = buildLinkedAdjustment({
        originalExpense,
        reason: auditReason,
        adjustmentType: correctionType,
        actorWallet: session.wallet_address,
        title,
        adjustedTotalAmount,
        newSplitMode,
        customWeights,
      });
    }

    const saved = await insertExpense(correctionRecord, session.wallet_address, client);

    if (tripId && typeof tripId === "string") {
      try {
        await addExpenseIdToTrip(tripId, saved.id, client);
      } catch {
        // Linking failure non-fatal if already added
      }
    }

    return NextResponse.json(
      { data: saved, message: "Linked correction created successfully." },
      { status: 201 }
    );
  } catch (err: any) {
    const message = err instanceof Error ? err.message : "Failed to create correction.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
