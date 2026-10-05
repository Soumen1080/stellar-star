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
  upsertSettlementIntentRow,
  updateSettlementIntentRow,
  fetchActiveSettlementIntents,
  fetchSettlementIntentByIdempotencyKey,
  fetchSettlementIntentByExpenseAndMember,
  fetchSettlementIntentByTxHash,
  fetchSettlementIntentByPayment,
  DatabaseError,
} from "@/lib/supabase/queries";
import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { getOrCreateRequestId } from "@/lib/observability/requestId";

export interface SettlementIntent {
  id: string;
  idempotencyKey: string;
  requestId: string;
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
    requestId: row.request_id,
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

export interface IdempotencyKeyParams {
  tripId?: string;
  expenseId: string;
  memberId: string;
  txHash?: string | null;
  assetCode?: string | null;
}

/**
 * Derives a deterministic idempotency key for an expense share settlement.
 *
 * When txHash is available (e.g. during reconciliation, network retry of a submitted
 * payment, or webhook reprocessing), the key is deterministically derived from:
 *   txHash + expenseId + memberId + assetCode
 *
 * Before a transaction is submitted to Horizon, falls back to:
 *   settle:tripId:expenseId:memberId
 */
export function deriveIdempotencyKey(
  tripIdOrParams: string | IdempotencyKeyParams,
  expenseId?: string,
  memberId?: string,
  txHash?: string | null,
  assetCode?: string | null,
): string {
  if (typeof tripIdOrParams === "object" && tripIdOrParams !== null) {
    const p = tripIdOrParams;
    return deriveIdempotencyKey(p.tripId ?? "none", p.expenseId, p.memberId, p.txHash, p.assetCode);
  }

  const exp = expenseId ?? "";
  const mem = memberId ?? "";
  const cleanAsset = (assetCode || "XLM").trim().toUpperCase();

  if (txHash && txHash.trim()) {
    const cleanHash = txHash.trim().toLowerCase();
    return `settle:${cleanHash}:${exp}:${mem}:${cleanAsset}`;
  }

  const trip = tripIdOrParams || "none";
  return `settle:${trip}:${exp}:${mem}`;
}

/**
 * Convenience helper to derive a payment-level deterministic idempotency key
 * from txHash + expenseId + memberId + assetCode.
 */
export function derivePaymentIdempotencyKey(
  txHash: string,
  expenseId: string,
  memberId: string,
  assetCode: string = "XLM",
): string {
  return deriveIdempotencyKey("none", expenseId, memberId, txHash, assetCode);
}

export interface AcquireIntentParams {
  requestId?: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  amount: string;
  currency?: string;
  assetCode?: string;
  txHash?: string | null;
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
  const asset = (params.assetCode ?? params.currency ?? "XLM").trim().toUpperCase();
  const idempotencyKey = deriveIdempotencyKey(
    params.tripId,
    params.expenseId,
    params.memberId,
    params.txHash,
    params.txHash ? asset : undefined,
  );
  const requestId = getOrCreateRequestId(params.requestId);

  // Check if an existing intent row exists
  let existing: SettlementIntent | null = null;
  try {
    existing = await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client);
    if (!existing && params.txHash) {
      existing = await fetchSettlementIntentByPayment(params.txHash, params.expenseId, params.memberId, client);
    }
    // Also check pre-submit key if txHash was not found
    if (!existing) {
      const fallbackKey = deriveIdempotencyKey(params.tripId, params.expenseId, params.memberId);
      if (fallbackKey !== idempotencyKey) {
        existing = await fetchSettlementIntentByIdempotencyKey(fallbackKey, client);
      }
    }
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
          request_id: requestId,
          amount: params.amount,
          currency: asset,
          tx_hash: params.txHash ?? existing.txHash,
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
      request_id: requestId,
      trip_id: params.tripId || "none",
      expense_id: params.expenseId,
      member_id: params.memberId,
      payer_wallet: params.payerWallet,
      member_wallet: params.memberWallet,
      amount: params.amount,
      currency: asset,
      status: "submitting",
      tx_hash: params.txHash ?? null,
      created_by_wallet: params.memberWallet,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    const created = await createSettlementIntentRow(insertPayload, client);
    return { ok: true, intent: created };
  } catch (err) {
    // If unique constraint collided with a concurrent request that won the race
    if (err instanceof DatabaseError && err.code === "23505") {
      const fresh =
        (await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client)) ||
        (params.txHash ? await fetchSettlementIntentByPayment(params.txHash, params.expenseId, params.memberId, client) : null);
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

export interface UpsertIntentParams {
  idempotencyKey?: string;
  requestId?: string;
  tripId?: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  amount: string;
  currency?: string;
  assetCode?: string;
  status?: "pending" | "submitting" | "submitted" | "recorded" | "failed" | "cancelled";
  txHash: string;
  ledger?: number | null;
  onChain?: boolean;
  createdByWallet?: string;
}

/**
 * Upserts a settlement intent using a deterministic idempotency key.
 *
 * Guarantees that re-syncing the same payment from network retries or webhooks
 * updates the single existing intent row instead of creating duplicates.
 */
export async function upsertSettlementIntent(
  params: UpsertIntentParams,
  client?: StellarStarClient,
): Promise<SettlementIntent> {
  const asset = (params.assetCode ?? params.currency ?? "XLM").trim().toUpperCase();
  const cleanTxHash = params.txHash.trim().toLowerCase();
  const idempotencyKey =
    params.idempotencyKey ??
    deriveIdempotencyKey(params.tripId ?? "none", params.expenseId, params.memberId, cleanTxHash, asset);
  const requestId = getOrCreateRequestId(params.requestId);

  // Check if an existing intent row exists
  let existing: SettlementIntent | null = null;
  try {
    existing = await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client);
    if (!existing) {
      existing = await fetchSettlementIntentByPayment(cleanTxHash, params.expenseId, params.memberId, client);
    }
    if (!existing) {
      // Check pre-submit key
      const preSubmitKey = deriveIdempotencyKey(params.tripId ?? "none", params.expenseId, params.memberId);
      existing = await fetchSettlementIntentByIdempotencyKey(preSubmitKey, client);
    }
  } catch {
    // Non-fatal
  }

  if (existing) {
    const updatePayload: SettlementIntentUpdate = {
      request_id: requestId,
      amount: params.amount,
      currency: asset,
      status: params.status ?? existing.status,
      tx_hash: cleanTxHash,
      ledger: params.ledger !== undefined ? params.ledger : existing.ledger,
      on_chain: params.onChain !== undefined ? params.onChain : existing.onChain,
      updated_at: new Date().toISOString(),
    };
    try {
      return await updateSettlementIntentRow(existing.id, updatePayload, client);
    } catch {
      // If update fails, fall through to upsert
    }
  }

  const insertPayload: SettlementIntentInsert = {
    idempotency_key: idempotencyKey,
    request_id: requestId,
    trip_id: params.tripId || "none",
    expense_id: params.expenseId,
    member_id: params.memberId,
    payer_wallet: params.payerWallet,
    member_wallet: params.memberWallet,
    amount: params.amount,
    currency: asset,
    status: params.status ?? "submitted",
    tx_hash: cleanTxHash,
    ledger: params.ledger ?? null,
    on_chain: params.onChain ?? false,
    created_by_wallet: params.createdByWallet ?? params.memberWallet,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };

  try {
    return await upsertSettlementIntentRow(insertPayload, client);
  } catch (err) {
    if (err instanceof DatabaseError && err.code === "23505") {
      const fresh =
        (await fetchSettlementIntentByIdempotencyKey(idempotencyKey, client)) ||
        (await fetchSettlementIntentByPayment(cleanTxHash, params.expenseId, params.memberId, client));
      if (fresh) return fresh;
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

// ─── Trustline idempotency ────────────────────────────────────────────────────

/**
 * Module-level in-process lock for trustline setup attempts.
 *
 * Key: `trustline:<publicKey>:<assetCode>:<assetIssuer>`
 * Value: the in-flight Promise<boolean> for that wallet+asset pair.
 *
 * When two code paths try to set up the same trustline concurrently (e.g. the
 * user opens two tabs, or a React strict-mode double-effect fires), the second
 * caller receives the same promise as the first and waits for it to settle
 * rather than submitting a duplicate ChangeTrust transaction to Horizon.
 *
 * The entry is deleted from the Map once the attempt settles, so a genuine
 * retry after failure is not blocked.
 */
const trustlineInflight = new Map<string, Promise<boolean>>();

export interface AcquireTrustlineParams {
  publicKey: string;
  assetCode: string;
  assetIssuer: string;
  /** The async work to perform when no equivalent attempt is in-flight. */
  work: () => Promise<boolean>;
}

/**
 * Ensures at most one trustline-setup attempt is active per (wallet, asset).
 *
 * Returns the result of `params.work` for the first caller. Any concurrent
 * callers sharing the same key receive the same promise and therefore the same
 * result without triggering duplicate Horizon submissions.
 *
 * Usage:
 * ```ts
 * const ok = await acquireTrustlineIntent({
 *   publicKey,
 *   assetCode: asset.code,
 *   assetIssuer: asset.issuer,
 *   work: () => submitChangeTrustTransaction(publicKey, asset),
 * });
 * ```
 */
export function acquireTrustlineIntent(params: AcquireTrustlineParams): Promise<boolean> {
  const key = `trustline:${params.publicKey}:${params.assetCode}:${params.assetIssuer}`;

  const existing = trustlineInflight.get(key);
  if (existing) return existing;

  const promise = params.work().finally(() => {
    // Release the lock unconditionally so a retry is never permanently blocked.
    trustlineInflight.delete(key);
  });

  trustlineInflight.set(key, promise);
  return promise;
}
