/**
 * lib/settlement/intent.ts
 *
 * Durable settlement intent store and idempotency management.
 *
 * Settlement spans Horizon, Soroban, Supabase, and client state. Before taking
 * any irreversible action (such as submitting an XLM payment to Horizon), an
 * intent must be durably recorded in Supabase. This guarantees:
 *  1. Two clients cannot simultaneously pay the same debt (Invariant 3).
 *  2. If the browser crashes mid-flow, any device can look up the intent, verify
 *     Horizon/contract state, and complete recording (Invariants 1 & 5).
 *  3. Retrying never produces duplicate transfers (Invariant 2).
 */

import {
  type SettlementIntentRow,
  type SettlementIntentInsert,
  type SettlementIntentUpdate,
} from "@/types/supabase";
import {
  createSettlementIntentRow,
  updateSettlementIntentRow,
  fetchActiveSettlementIntents,
  fetchSettlementIntentByIdempotencyKey,
  fetchSettlementIntentByExpenseAndMember,
  DatabaseError,
} from "@/lib/supabase/queries";
import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";

export interface SettlementIntent {
  id: string;
  idempotencyKey: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  amount: string;
  currency: string;
  status: "pending" | "submitting" | "submitted" | "recorded" | "failed" | "cancelled";
  txHash: string | null;
  ledger: number | null;
  onChain: boolean;
  errorMessage: string | null;
  createdByWallet: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function rowToSettlementIntent(row: SettlementIntentRow): SettlementIntent {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    tripId: row.trip_id,
    expenseId: row.expense_id,
    memberId: row.member_id,
    payerWallet: row.payer_wallet,
    memberWallet: row.member_wallet,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    txHash: row.tx_hash,
    ledger: row.ledger !== null ? Number(row.ledger) : null,
    onChain: row.on_chain,
    errorMessage: row.error_message,
    createdByWallet: row.created_by_wallet,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Derives a deterministic idempotency key for an expense share settlement.
 */
export function deriveIdempotencyKey(tripId: string, expenseId: string, memberId: string): string {
  return `settle:${tripId || "none"}:${expenseId}:${memberId}`;
}

export interface AcquireIntentParams {
  tripId: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  amount: string;
  currency?: string;
}

export type AcquireIntentResult =
  | { ok: true; intent: SettlementIntent }
  | {
      ok: false;
      code: "IN_PROGRESS" | "ALREADY_RECORDED" | "SUBMITTED_NEEDS_RECONCILIATION";
      intent: SettlementIntent;
      message: string;
    };

/**
 * Checks for existing intents and acquires an intent lock before starting payment.
 *
 * Prevents race conditions where two clients attempt to settle the same share concurrently.
 */
export async function acquireSettlementIntent(
  params: AcquireIntentParams,
  client?: StellarStarClient,
): Promise<AcquireIntentResult> {
  const idempotencyKey = deriveIdempotencyKey(params.tripId, params.expenseId, params.memberId);

  // Check if an existing intent row exists
  let existing: SettlementIntent | null = null;
  try {
    existing = await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client);
  } catch {
    // Non-fatal if table read fails; will attempt insert
  }

  if (existing) {
    const isExpired = new Date(existing.expiresAt).getTime() <= Date.now();

    // If recorded on chain or paid in Supabase
    if (existing.status === "recorded") {
      return {
        ok: false,
        code: "ALREADY_RECORDED",
        intent: existing,
        message: "This share has already been settled and recorded.",
      };
    }

    // If submitted with a txHash, the payment already occurred on Stellar!
    if (existing.txHash && (existing.status === "submitted" || existing.status === "submitting")) {
      return {
        ok: false,
        code: "SUBMITTED_NEEDS_RECONCILIATION",
        intent: existing,
        message: "A payment was already submitted on Stellar for this share. Reconciling...",
      };
    }

    // If in progress and not yet expired, lock out concurrent payers
    if (!isExpired && (existing.status === "pending" || existing.status === "submitting")) {
      // If created by the same wallet very recently, allow resuming the intent
      if (existing.createdByWallet === params.memberWallet) {
        return { ok: true, intent: existing };
      }
      return {
        ok: false,
        code: "IN_PROGRESS",
        intent: existing,
        message: "Another client is currently settling this share. Please wait a moment.",
      };
    }

    // Otherwise the prior intent failed or expired without moving money; renew it
    try {
      const updated = await updateSettlementIntentRow(
        existing.id,
        {
          status: "submitting",
          amount: params.amount,
          currency: params.currency ?? "XLM",
          error_message: null,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        },
        client,
      );
      return { ok: true, intent: updated };
    } catch {
      // Fall through to insert if update fails
    }
  }

  // Create new intent
  try {
    const insertPayload: SettlementIntentInsert = {
      idempotency_key: idempotencyKey,
      trip_id: params.tripId || "none",
      expense_id: params.expenseId,
      member_id: params.memberId,
      payer_wallet: params.payerWallet,
      member_wallet: params.memberWallet,
      amount: params.amount,
      currency: params.currency ?? "XLM",
      status: "submitting",
      created_by_wallet: params.memberWallet,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    const created = await createSettlementIntentRow(insertPayload, client);
    return { ok: true, intent: created };
  } catch (err) {
    // If unique constraint collided with a concurrent request that won the race
    if (err instanceof DatabaseError && err.code === "23505") {
      const fresh = await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client);
      if (fresh) {
        return {
          ok: false,
          code: "IN_PROGRESS",
          intent: fresh,
          message: "Another client is currently settling this share.",
        };
      }
    }
    throw err;
  }
}

/**
 * Updates intent immediately after Horizon transaction submission succeeds.
 */
export async function markIntentSubmitted(
  intentId: string,
  txHash: string,
  ledger?: number,
  client?: StellarStarClient,
): Promise<SettlementIntent> {
  return updateSettlementIntentRow(
    intentId,
    {
      status: "submitted",
      tx_hash: txHash,
      ledger: ledger ?? null,
      error_message: null,
    },
    client,
  );
}

/**
 * Updates intent when Soroban contract and Supabase writes have completed.
 */
export async function markIntentRecorded(
  intentId: string,
  ledger?: number,
  onChain: boolean = true,
  client?: StellarStarClient,
): Promise<SettlementIntent> {
  return updateSettlementIntentRow(
    intentId,
    {
      status: "recorded",
      ledger: ledger ?? null,
      on_chain: onChain,
      error_message: null,
    },
    client,
  );
}

/**
 * Updates intent when settlement encounters a fatal failure prior to money moving.
 */
export async function markIntentFailed(
  intentId: string,
  errorMessage: string,
  client?: StellarStarClient,
): Promise<SettlementIntent> {
  return updateSettlementIntentRow(
    intentId,
    {
      status: "failed",
      error_message: errorMessage,
    },
    client,
  );
}
