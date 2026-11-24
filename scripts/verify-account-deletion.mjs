#!/usr/bin/env node
/** Read-only staging proof for a completed synthetic account deletion. */
const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const wallet = process.env.DELETE_VERIFY_WALLET?.trim().toUpperCase();
if (!baseUrl || !key || !wallet) {
  process.stderr.write("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and DELETE_VERIFY_WALLET for the staging check.\n");
  process.exit(2);
}

async function rows(table, filters = {}) {
  const url = new URL(`${baseUrl}/rest/v1/${table}`);
  url.searchParams.set("select", "*");
  url.searchParams.set("limit", "1000");
  for (const [column, value] of Object.entries(filters)) url.searchParams.set(column, value);
  const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`Staging query failed for ${table} (${response.status}).`);
  return response.json();
}

try {
  const [request, marker] = await Promise.all([
    rows("account_deletion_requests", { wallet_address: `eq.${wallet}` }),
    rows("deleted_accounts", { wallet_address: `eq.${wallet}` }),
  ]);
  if (request.length !== 1 || request[0].state !== "completed" || marker.length !== 1) throw new Error("Deletion request is not completed or its access-revocation marker is missing.");

  const personal = [
    ["users", { wallet_address: `eq.${wallet}` }],
    ["contacts", { owner_wallet: `eq.${wallet}` }],
    ["trip_invites", { created_by_wallet: `eq.${wallet}` }],
    ["expense_receipts", { uploaded_by_wallet: `eq.${wallet}` }],
    ["webhook_endpoints", { wallet_address: `eq.${wallet}` }],
    ["reminder_preferences", { wallet: `eq.${wallet}` }],
    ["reminder_schedules", { owner_wallet: `eq.${wallet}` }],
    ["recurring_expense_templates", { created_by_wallet: `eq.${wallet}` }],
    ["expense_drafts", { member_wallets: `cs.{${wallet}}` }],
    ["trip_templates", { owner_wallet: `eq.${wallet}` }],
    ["payment_reminders", { or: `(sender_wallet.eq.${wallet},recipient_wallet.eq.${wallet})` }],
    ["idempotency_records", { wallet_address: `eq.${wallet}` }],
    ["auth_challenges", { address: `eq.${wallet}` }],
    ["export_audit_events", { actor_wallet: `eq.${wallet}` }],
    ["trip_copy_events", { actor_wallet: `eq.${wallet}` }],
    ["trip_role_audit", { changed_by_wallet: `eq.${wallet}` }],
    ["trip_budgets", { created_by_wallet: `eq.${wallet}` }],
    ["settlement_proposals", { creator_wallet: `eq.${wallet}` }],
    ["settlement_proposal_responses", { wallet: `eq.${wallet}` }],
    ["expense_disputes", { opened_by_wallet: `eq.${wallet}` }],
    ["expense_dispute_events", { actor_wallet: `eq.${wallet}` }],
  ];
  for (const [table, filters] of personal) {
    const remaining = await rows(table, filters);
    if (remaining.length) throw new Error(`Personal rows remain in ${table}.`);
  }

  const evidence = await rows("account_deletion_evidence", { request_id: `eq.${request[0].id}` });
  const receiptStep = evidence.find((entry) => entry.step === "erase_receipts" && entry.outcome === "completed");
  if (!receiptStep || typeof receiptStep.counts?.receipt_objects !== "number") throw new Error("Receipt-object erasure evidence is missing.");
  process.stdout.write("Staging account deletion is complete: personal rows are absent, receipt-object erasure is recorded, and the minimal deletion evidence remains.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Staging deletion verification failed."}\n`);
  process.exit(1);
}
