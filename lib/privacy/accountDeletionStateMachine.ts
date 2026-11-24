import type { ServerClient } from "@/lib/supabase/server";
import { RECEIPT_BUCKET } from "@/lib/receipts/policy";
import { revokeTokensForWallet } from "@/lib/api/tokens";
import { anonymizeApiAuditLogsForWallet } from "@/lib/api/middleware";

type DeletionState = "held" | "erasing" | "completed";

export interface AccountDeletionStateResult {
  success: boolean;
  state: DeletionState;
  requestId: string;
  deletedAt: string;
  summary?: Record<string, number>;
  notice: string;
}

const NOTICE = "Off-chain personal data has been erased or anonymized. Public Stellar blockchain transactions and contract records remain permanent.";

/**
 * Starts or resumes a durable, stepwise deletion request. Every phase is
 * idempotent and its completion is recorded before the next phase begins.
 */
export async function executeAccountDeletionStateMachine(walletAddress: string, client: ServerClient): Promise<AccountDeletionStateResult> {
  const wallet = walletAddress.trim().toUpperCase();
  const db = client as any;
  const { data: begin, error: beginError } = await db.rpc("begin_account_deletion", { p_wallet: wallet });
  if (beginError || !begin?.request_id) throw new Error("Could not start the account deletion workflow.");
  const requestId = String(begin.request_id);
  const deletedAt = new Date().toISOString();
  if (begin.state === "held") {
    return { success: false, state: "held", requestId, deletedAt, notice: "Deletion is paused under a legal hold. Access is revoked while the required evidence is retained." };
  }
  if (begin.state === "completed") return { success: true, state: "completed", requestId, deletedAt, summary: {}, notice: NOTICE };
  const done = new Set<string>(Array.isArray(begin.completed_steps) ? begin.completed_steps : []);
  const recordStep = async (step: string, counts: Record<string, number> = {}, complete = false) => {
    const { error } = await db.rpc("record_account_deletion_step", { p_request_id: requestId, p_step: step, p_counts: counts, p_complete: complete });
    if (error) throw new Error(`Deletion step failed: ${step}`);
    done.add(step);
  };

  try {
    revokeTokensForWallet(wallet);
    anonymizeApiAuditLogsForWallet(wallet);

    let summary: Record<string, number> = {};
    if (!done.has("cancel_work")) {
      const { data, error } = await db.rpc("cancel_account_background_work", { p_wallet: wallet });
      if (error) throw new Error("Deletion step failed: cancel_work");
      summary = { ...summary, ...(data ?? {}) };
      await recordStep("cancel_work", summary);
    }

    if (!done.has("erase_receipts")) {
      let receiptObjects = 0;
      let receiptRecords = 0;
      let lastId: string | null = null;
      while (true) {
        let query = db.from("expense_receipts").select("id,storage_path").eq("uploaded_by_wallet", wallet).order("id").limit(500);
        if (lastId) query = query.gt("id", lastId);
        const { data, error } = await query;
        if (error) throw new Error("Deletion step failed: erase_receipts");
        const batch = data ?? [];
        if (!batch.length) break;
        const bucket = client.storage.from(RECEIPT_BUCKET);
        for (let offset = 0; offset < batch.length; offset += 100) {
          const paths = batch.slice(offset, offset + 100).map((row: { storage_path: string }) => row.storage_path);
          const { error: storageError } = await bucket.remove(paths);
          if (storageError) throw new Error("Deletion step failed: erase_receipts");
        }
        const ids = batch.map((row: { id: string }) => row.id);
        const removedAt = new Date().toISOString();
        const { error: updateError, count } = await db.from("expense_receipts").update({ status: "removed", file_name: null, caption: null, scan_result: {}, uploaded_by_wallet: "FORMER_ACCOUNT", removed_at: removedAt, removed_by_wallet: null, removal_reason: "user" }, { count: "exact" }).in("id", ids);
        if (updateError) throw new Error("Deletion step failed: erase_receipts");
        receiptObjects += batch.length;
        receiptRecords += count ?? batch.length;
        lastId = batch[batch.length - 1].id;
        if (batch.length < 500) break;
      }
      summary = { ...summary, receipt_objects: receiptObjects, receipt_records: receiptRecords };
      await recordStep("erase_receipts", summary);
    }

    if (!done.has("sanitize_shared_records")) {
      const trips = await anonymizeMemberNames(db, "trips", wallet);
      const expenses = await anonymizeMemberNames(db, "expenses", wallet);
      summary = { ...summary, trips_sanitized: trips, expenses_sanitized: expenses };
      await recordStep("sanitize_shared_records", summary);
    }

    if (!done.has("purge_profiles")) {
      const [profile, contacts] = await Promise.all([
        db.from("users").delete({ count: "exact" }).eq("wallet_address", wallet),
        db.from("contacts").delete({ count: "exact" }).eq("owner_wallet", wallet),
      ]);
      if (profile.error || contacts.error) throw new Error("Deletion step failed: purge_profiles");
      summary = { ...summary, profiles_removed: profile.count ?? 0, contacts_purged: contacts.count ?? 0 };
      await recordStep("purge_profiles", summary);
    }

    if (!done.has("anonymize_lawful_logs")) {
      const { data, error } = await db.rpc("anonymize_account_lawful_logs", { p_wallet: wallet });
      if (error) throw new Error("Deletion step failed: anonymize_lawful_logs");
      summary = { ...summary, ...(data ?? {}) };
      await recordStep("anonymize_lawful_logs", summary);
    }

    await recordStep("completed", summary, true);
    return { success: true, state: "completed", requestId, deletedAt, summary, notice: NOTICE };
  } catch (error) {
    await db.rpc("fail_account_deletion", { p_request_id: requestId });
    throw error instanceof Error ? error : new Error("Account deletion can be resumed after a temporary failure.");
  }
}

async function anonymizeMemberNames(db: any, table: "trips" | "expenses", wallet: string): Promise<number> {
  let changed = 0;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await db.from(table).select("id,members").contains("member_wallets", [wallet]).order("id").range(offset, offset + 499);
    if (error) throw new Error(`Deletion step failed: sanitize ${table}`);
    const rows = data ?? [];
    for (const row of rows) {
      if (!Array.isArray(row.members)) continue;
      let modified = false;
      const members = row.members.map((member: any) => {
        if (member?.walletAddress?.trim().toUpperCase() !== wallet || member.name === "Former Member") return member;
        modified = true;
        return { ...member, name: "Former Member" };
      });
      if (modified) {
        const { error: updateError } = await db.from(table).update({ members }).eq("id", row.id);
        if (updateError) throw new Error(`Deletion step failed: sanitize ${table}`);
        changed++;
      }
    }
    if (rows.length < 500) break;
  }
  return changed;
}
