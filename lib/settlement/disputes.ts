import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { toDatabaseError } from "@/lib/supabase/queries";
import type { ExpenseDisputeEventRow, ExpenseDisputeRow } from "@/types/supabase";
import { disputeKey } from "./proposal";

export type DisputeCategory = ExpenseDisputeRow["category"];
export type DisputeAction = ExpenseDisputeEventRow["action"];
export const DISPUTE_CATEGORIES: readonly DisputeCategory[] = [
  "incorrect_amount", "incorrect_split", "not_shared", "duplicate", "already_paid", "missing_context", "other",
];
export const MAX_DISPUTE_COMMENT = 2000;
export const MAX_DISPUTE_EVIDENCE = 5;

export function unresolvedDisputedShares(rows: Pick<ExpenseDisputeRow, "expense_id" | "share_member_id" | "status">[]): Set<string> {
  return new Set(rows.filter((d) => d.status === "open" || d.status === "upheld").map((d) => disputeKey(d.expense_id, d.share_member_id)));
}

export async function listTripDisputes(tripId: string, client: StellarStarClient = requireAuthenticatedClient()) {
  const { data, error } = await client.from("expense_disputes").select("*").eq("trip_id", tripId).order("created_at", { ascending: false });
  if (error) throw toDatabaseError(error, "load expense disputes");
  return (data ?? []) as ExpenseDisputeRow[];
}

export async function openExpenseDispute(input: {
  tripId: string; expenseId: string; shareMemberId: string; wallet: string;
  category: DisputeCategory; comment: string; evidenceReceiptIds?: string[];
}, client: StellarStarClient = requireAuthenticatedClient()) {
  const comment = input.comment.trim();
  const evidence = [...new Set(input.evidenceReceiptIds ?? [])];
  if (!DISPUTE_CATEGORIES.includes(input.category)) throw new Error("Choose a valid dispute category.");
  if (!comment || comment.length > MAX_DISPUTE_COMMENT) throw new Error("Add a comment of up to 2,000 characters.");
  if (evidence.length > MAX_DISPUTE_EVIDENCE) throw new Error("Attach up to five existing private receipts.");
  const { data, error } = await client.from("expense_disputes").insert({
    trip_id: input.tripId, expense_id: input.expenseId, share_member_id: input.shareMemberId,
    opened_by_wallet: input.wallet, category: input.category, comment, evidence_receipt_ids: evidence,
  }).select("*").single();
  if (error || !data) throw toDatabaseError(error!, "open the dispute");
  return data as ExpenseDisputeRow;
}

export async function resolveExpenseDispute(input: {
  dispute: ExpenseDisputeRow; wallet: string; action: Exclude<DisputeAction, "opened">; reason: string;
}, client: StellarStarClient = requireAuthenticatedClient()) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 1000) throw new Error("A resolution reason is required (up to 1,000 characters).");
  const { error } = await client.rpc("resolve_expense_dispute", {
    p_dispute_id: input.dispute.id, p_action: input.action, p_reason: reason,
  });
  if (error) throw toDatabaseError(error, "resolve the dispute");
}
