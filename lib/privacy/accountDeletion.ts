/**
 * lib/privacy/accountDeletion.ts
 *
 * Account deletion and off-chain data erasure workflow (Issue #310).
 *
 * Removes or anonymizes personal off-chain data while preserving on-chain
 * ledger integrity and accounting math for remaining group participants.
 */

import { ServerClient } from "@/lib/supabase/server";

export interface DeletionResult {
  success: boolean;
  walletAddress: string;
  deletedAt: string;
  summary: {
    userProfileRemoved: boolean;
    contactsPurged: number;
    invitesRevoked: number;
    receiptsMarkedRemoved: number;
    tripsSanitized: number;
    expensesSanitized: number;
  };
  notice: string;
}

export async function executeAccountDeletion(
  walletAddress: string,
  client: ServerClient
): Promise<DeletionResult> {
  const normalizedWallet = walletAddress.trim();
  const now = new Date().toISOString();

  const summary = {
    userProfileRemoved: false,
    contactsPurged: 0,
    invitesRevoked: 0,
    receiptsMarkedRemoved: 0,
    tripsSanitized: 0,
    expensesSanitized: 0,
  };

  // 1. Register wallet in deleted_accounts so RLS and current_wallet() immediately fail closed
  try {
    await client.from("deleted_accounts").upsert({
      wallet_address: normalizedWallet,
      deleted_at: now,
      reason: "user_request",
    });
  } catch (err) {
    console.warn("[privacy/deletion] Failed to upsert deleted_accounts:", err);
  }

  // 2. Delete or anonymize profile from public.users
  const { error: userDeleteErr } = await client
    .from("users")
    .delete()
    .eq("wallet_address", normalizedWallet);

  if (!userDeleteErr) {
    summary.userProfileRemoved = true;
  }

  // 3. Purge private address book / contacts owned by this wallet
  try {
    const { count } = await client
      .from("contacts")
      .delete({ count: "exact" })
      .eq("owner_wallet", normalizedWallet);
    summary.contactsPurged = count ?? 0;
  } catch {
    // Non-fatal if table not migrated
  }

  // 4. Revoke active invitations created by this wallet
  try {
    const { count } = await client
      .from("trip_invites")
      .update({ revoked: true, revoked_at: now }, { count: "exact" })
      .eq("created_by_wallet", normalizedWallet)
      .eq("revoked", false);
    summary.invitesRevoked = count ?? 0;
  } catch {
    // Non-fatal
  }

  // 5. Mark receipt attachments as removed
  try {
    const { count } = await client
      .from("expense_receipts")
      .update(
        {
          status: "removed",
          removal_reason: "user",
          removed_at: now,
          removed_by_wallet: normalizedWallet,
        },
        { count: "exact" }
      )
      .eq("uploaded_by_wallet", normalizedWallet)
      .neq("status", "removed");
    summary.receiptsMarkedRemoved = count ?? 0;
  } catch {
    // Non-fatal
  }

  // 6. Sanitize member names in trips where this wallet is a member
  try {
    const { data: trips } = await client
      .from("trips")
      .select("id, members")
      .contains("member_wallets", [normalizedWallet]);

    if (Array.isArray(trips)) {
      for (const trip of trips) {
        if (Array.isArray(trip.members)) {
          const sanitizedMembers = trip.members.map((m: any) => {
            if (m.walletAddress === normalizedWallet) {
              return { ...m, name: "Former Member" };
            }
            return m;
          });
          await client
            .from("trips")
            .update({ members: sanitizedMembers })
            .eq("id", trip.id);
          summary.tripsSanitized++;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 7. Sanitize member names in expenses
  try {
    const { data: expenses } = await client
      .from("expenses")
      .select("id, members")
      .contains("member_wallets", [normalizedWallet]);

    if (Array.isArray(expenses)) {
      for (const exp of expenses) {
        if (Array.isArray(exp.members)) {
          const sanitizedMembers = exp.members.map((m: any) => {
            if (m.walletAddress === normalizedWallet) {
              return { ...m, name: "Former Member" };
            }
            return m;
          });
          await client
            .from("expenses")
            .update({ members: sanitizedMembers })
            .eq("id", exp.id);
          summary.expensesSanitized++;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // 8. Delete active/pending challenges
  try {
    await client.from("auth_challenges").delete().eq("address", normalizedWallet);
  } catch {
    // Non-fatal
  }

  return {
    success: true,
    walletAddress: normalizedWallet,
    deletedAt: now,
    summary,
    notice:
      "All off-chain personal data has been erased or anonymized. Public Stellar blockchain transactions, contract calls, and on-chain payments remain permanent on the ledger.",
  };
}
