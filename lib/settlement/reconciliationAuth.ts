/**
 * lib/settlement/reconciliationAuth.ts
 *
 * Who may run or read settlement reconciliation (Issue #415). Server only.
 *
 * Accepted identities, checked in this order:
 *   1. cron   `Authorization: Bearer $CRON_SECRET`, compared in constant time.
 *   2. staff  `x-staff-secret` = SUPPORT_STAFF_SECRET, or `x-operator-secret` =
 *             SPONSOR_OPERATOR_SECRET / OPERATOR_SECRET (constant time).
 *   3. staff  a verified wallet session whose wallet is on the explicit
 *             RECONCILIATION_STAFF_WALLETS (or SUPPORT_STAFF_WALLETS) list.
 *   4. wallet any other verified wallet session; may only read its own rows.
 *
 * Unlike the support console's helper there is no development fallback and
 * an empty allowlist admits nobody: a request without one of these
 * credentials is refused, whatever the environment.
 */

import { timingSafeEqual } from "crypto";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";

export type ReconciliationActorKind = "cron" | "staff" | "wallet";

export interface ReconciliationActor {
  kind: ReconciliationActorKind;
  /** Stable, non-secret identifier recorded with every run. */
  id: string;
  /** For wallet sessions: the bearer token, used to build an RLS client. */
  token?: string;
  wallet?: string;
}

export type ReconciliationAuthResult =
  | { ok: true; actor: ReconciliationActor }
  | { ok: false; status: 401 | 403; code: string; message: string };

function constantTimeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare against the expected value's length either way, so a length
  // mismatch costs the same as a content mismatch.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function configured(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function staffWallets(): Set<string> {
  const raw = process.env.RECONCILIATION_STAFF_WALLETS ?? process.env.SUPPORT_STAFF_WALLETS ?? "";
  return new Set(
    raw
      .split(",")
      .map((wallet) => wallet.trim().toUpperCase())
      .filter(Boolean),
  );
}

const UNAUTHENTICATED: ReconciliationAuthResult = {
  ok: false,
  status: 401,
  code: "RECONCILIATION_AUTH_REQUIRED",
  message: "Reconciliation requires the cron secret or staff credentials.",
};

/** Identifies the caller, or explains why it is refused. */
export function resolveReconciliationActor(request: { headers: { get(name: string): string | null } }): ReconciliationAuthResult {
  const headers = request.headers;
  const authorization = headers.get("authorization")?.trim() ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

  const cronSecret = configured("CRON_SECRET");
  if (cronSecret && bearer && constantTimeEqual(bearer, cronSecret)) {
    return { ok: true, actor: { kind: "cron", id: "cron" } };
  }

  const staffSecret = configured("SUPPORT_STAFF_SECRET");
  const providedStaff = headers.get("x-staff-secret")?.trim() ?? "";
  if (staffSecret && providedStaff && constantTimeEqual(providedStaff, staffSecret)) {
    return { ok: true, actor: { kind: "staff", id: "staff-secret" } };
  }

  const operatorSecret = configured("SPONSOR_OPERATOR_SECRET", "OPERATOR_SECRET");
  const providedOperator = headers.get("x-operator-secret")?.trim() ?? "";
  if (operatorSecret && providedOperator && constantTimeEqual(providedOperator, operatorSecret)) {
    return { ok: true, actor: { kind: "staff", id: "operator-secret" } };
  }

  if (bearer) {
    const session = verifyWalletSession(bearer);
    if (session?.wallet_address) {
      const wallet = session.wallet_address.trim().toUpperCase();
      if (staffWallets().has(wallet)) {
        return { ok: true, actor: { kind: "staff", id: `wallet:${wallet}`, token: bearer, wallet } };
      }
      return { ok: true, actor: { kind: "wallet", id: `wallet:${wallet}`, token: bearer, wallet } };
    }
  }

  return UNAUTHENTICATED;
}

/** Running the worker: cron or staff only. A plain wallet session is refused. */
export function authorizeReconciliationRun(request: { headers: { get(name: string): string | null } }): ReconciliationAuthResult {
  const result = resolveReconciliationActor(request);
  if (result.ok && result.actor.kind === "wallet") {
    return {
      ok: false,
      status: 403,
      code: "RECONCILIATION_STAFF_REQUIRED",
      message: "Only the scheduler or authorized staff can run reconciliation.",
    };
  }
  return result;
}

/** The scheduled entry point: the cron secret and nothing else. */
export function authorizeReconciliationCron(request: { headers: { get(name: string): string | null } }): ReconciliationAuthResult {
  const result = resolveReconciliationActor(request);
  if (result.ok && result.actor.kind === "cron") return result;
  return {
    ok: false,
    status: 401,
    code: "RECONCILIATION_CRON_REQUIRED",
    message: "The scheduled reconciliation entry point requires the cron secret.",
  };
}
