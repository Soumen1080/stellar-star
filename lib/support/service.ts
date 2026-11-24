/**
 * lib/support/service.ts
 *
 * Core incident lookup, timeline assembly, and audit logging engine
 * for the Support and Incident-Response Console (Issue #314).
 *
 * Invariants:
 * 1. Read-only by default: Lookups never mutate financial state.
 * 2. Complete timeline: Unifies expense, settlement intent, Horizon ledger,
 *    and Soroban contract events into a coherent chronological sequence.
 * 3. Secrets redacted: Redacts all private keys, secrets, and auth tokens.
 * 4. Audited: Every staff lookup is recorded with staff identifier, query type, and IP.
 * 5. Network-correct: Explorer links match the deployment's configured Stellar network.
 */

import { timingSafeEqual } from "crypto";
import { type NextRequest } from "next/server";
import { STELLAR_EXPLORER, NETWORK_LABEL, CONTRACT_ID } from "@/lib/utils/constants";
import {
  type SupportQueryType,
  type SupportSearchParams,
  type SupportIncidentView,
  type TimelineEvent,
  type HorizonVerificationSummary,
  type ContractEventSummary,
  type SupportAuditLogEntry,
} from "./types";
import { redactObject, maskQueryForAudit } from "./redact";
import {
  fetchSettlementIntentByTxHash,
  fetchSettlementIntentByExpenseAndMember,
  DatabaseError,
} from "@/lib/supabase/queries";
import { rowToSettlementIntent, type SettlementIntent } from "@/lib/settlement/intent";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { checkIsPaid } from "@/lib/stellar/contract";
import { type StellarStarClient } from "@/lib/supabase/client";
import { type SettlementIntentRow } from "@/types/supabase";
import { type Expense } from "@/types/expense";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";

// Global in-memory audit log ring-buffer (persists across hot reloads in dev / serverless process)
declare global {
  var stellarStarSupportAuditLogs: SupportAuditLogEntry[] | undefined;
}

const auditLogBuffer: SupportAuditLogEntry[] = globalThis.stellarStarSupportAuditLogs ?? [];
globalThis.stellarStarSupportAuditLogs = auditLogBuffer;
const MAX_AUDIT_LOG_ENTRIES = 500;

/**
 * Automatically detects the search query type from pattern heuristics.
 */
export function detectQueryType(query: string): SupportQueryType {
  const trimmed = query.trim();

  // 64-character hex string -> Stellar transaction hash
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return "tx_hash";
  }

  // Starts with 'G' and exactly 56 chars -> Stellar Public Key
  if (/^G[A-Z0-9]{55}$/.test(trimmed)) {
    return "wallet";
  }

  // Correlation ID / Request ID format
  if (
    trimmed.startsWith("req-") ||
    trimmed.startsWith("req_") ||
    trimmed.includes("req-") ||
    trimmed.includes("corr-") ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) && trimmed.startsWith("r")
  ) {
    return "correlation_id";
  }

  // Trip ID indicator
  if (trimmed.startsWith("trip_") || trimmed.startsWith("trip-")) {
    return "trip_id";
  }

  // Expense ID indicator
  if (trimmed.startsWith("exp_") || trimmed.startsWith("expense_")) {
    return "expense_id";
  }

  // Default fallback
  return "expense_id";
}

/**
 * Validates whether the incoming request is from authorized support staff.
 */
export function checkStaffAuthorization(request: NextRequest | Request): {
  authorized: boolean;
  staffIdentifier: string;
  role: string;
} {
  const headers = request.headers;

  // 1. Staff or Operator shared secret check
  const staffSecretProvided = headers.get("x-staff-secret")?.trim() || "";
  const operatorSecretProvided = headers.get("x-operator-secret")?.trim() || "";

  const configuredStaffSecret = process.env.SUPPORT_STAFF_SECRET?.trim();
  const configuredOperatorSecret =
    process.env.SPONSOR_OPERATOR_SECRET?.trim() || process.env.OPERATOR_SECRET?.trim();

  if (configuredStaffSecret && staffSecretProvided) {
    const expected = Buffer.from(configuredStaffSecret);
    const actual = Buffer.from(staffSecretProvided);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { authorized: true, staffIdentifier: "staff-secret-key", role: "support_agent" };
    }
  }

  if (configuredOperatorSecret && operatorSecretProvided) {
    const expected = Buffer.from(configuredOperatorSecret);
    const actual = Buffer.from(operatorSecretProvided);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { authorized: true, staffIdentifier: "operator-secret-key", role: "operator" };
    }
  }

  // 2. Bearer token / Wallet session check
  const authHeader = headers.get("authorization")?.trim() || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();

    // Check if token matches staff secret directly
    if (configuredStaffSecret) {
      const expected = Buffer.from(configuredStaffSecret);
      const actual = Buffer.from(token);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return { authorized: true, staffIdentifier: "staff-bearer-token", role: "support_agent" };
      }
    }

    // Check wallet session token
    const session = verifyWalletSession(token);
    if (session) {
      const allowedWallets = (process.env.SUPPORT_STAFF_WALLETS ?? "")
        .split(",")
        .map((w) => w.trim().toUpperCase())
        .filter(Boolean);

      const wallet = session.wallet_address.toUpperCase();
      if (allowedWallets.length === 0 || allowedWallets.includes(wallet)) {
        return { authorized: true, staffIdentifier: session.wallet_address, role: "support_staff" };
      }
    }
  }

  // Development/Test fallback: if no secrets are configured in environment, permit authenticated development inspect
  if (
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" ||
    (!configuredStaffSecret && !configuredOperatorSecret)
  ) {
    const fallbackStaffId = headers.get("x-staff-id") || "dev-support-staff";
    return { authorized: true, staffIdentifier: fallbackStaffId, role: "developer" };
  }

  return { authorized: false, staffIdentifier: "anonymous", role: "none" };
}

/**
 * Records an entry into the staff support lookup audit trail.
 */
export async function recordSupportLookupAudit(
  entry: Omit<SupportAuditLogEntry, "id" | "timestamp">,
  client?: StellarStarClient
): Promise<SupportAuditLogEntry> {
  const fullEntry: SupportAuditLogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
    queryValueMasked: maskQueryForAudit(entry.queryValueMasked),
  };

  // 1. In-memory circular buffer
  auditLogBuffer.unshift(fullEntry);
  if (auditLogBuffer.length > MAX_AUDIT_LOG_ENTRIES) {
    auditLogBuffer.pop();
  }

  // 2. Durable Supabase storage (best-effort)
  if (client) {
    try {
      await client.from("support_audit_logs").insert({
        id: fullEntry.id,
        staff_identifier: fullEntry.staffIdentifier,
        query_type: fullEntry.queryType,
        query_value: fullEntry.queryValueMasked,
        results_count: fullEntry.resultsCount,
        ip_address: fullEntry.ipAddress,
        user_agent: fullEntry.userAgent ?? null,
        created_at: fullEntry.timestamp,
      });
    } catch {
      // Non-fatal if table doesn't exist yet; memory buffer is retained
    }
  }

  return fullEntry;
}

/**
 * Fetches recent support lookup audit logs.
 */
export async function fetchSupportAuditLogs(
  limit = 50,
  client?: StellarStarClient
): Promise<SupportAuditLogEntry[]> {
  const boundedLimit = Math.min(Math.max(1, limit), 200);

  if (client) {
    try {
      const { data, error } = await client
        .from("support_audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(boundedLimit);

      if (!error && data && data.length > 0) {
        return data.map((row: any) => ({
          id: row.id,
          staffIdentifier: row.staff_identifier,
          queryType: row.query_type,
          queryValueMasked: row.query_value,
          resultsCount: row.results_count,
          ipAddress: row.ip_address,
          userAgent: row.user_agent,
          timestamp: row.created_at,
        }));
      }
    } catch {
      // Fallback to in-memory
    }
  }

  return auditLogBuffer.slice(0, boundedLimit);
}

/**
 * Look up full incident data and assemble a chronological timeline.
 */
export async function lookupIncident(
  params: SupportSearchParams,
  client?: StellarStarClient
): Promise<SupportIncidentView> {
  const cleanQuery = params.query.trim();
  const detectedType = params.queryType || detectQueryType(cleanQuery);

  let settlementIntents: SettlementIntent[] = [];
  let expense: Expense | null = null;
  let tripData: SupportIncidentView["trip"] = null;

  // 1. Fetch matching Settlement Intents
  if (client) {
    try {
      let queryBuilder = client.from("settlement_intents").select("*");

      if (detectedType === "tx_hash") {
        queryBuilder = queryBuilder.eq("tx_hash", cleanQuery.toLowerCase());
      } else if (detectedType === "wallet") {
        queryBuilder = queryBuilder.or(
          `member_wallet.eq.${cleanQuery},payer_wallet.eq.${cleanQuery},created_by_wallet.eq.${cleanQuery}`
        );
      } else if (detectedType === "trip_id") {
        queryBuilder = queryBuilder.eq("trip_id", cleanQuery);
      } else if (detectedType === "expense_id") {
        queryBuilder = queryBuilder.eq("expense_id", cleanQuery);
      } else if (detectedType === "correlation_id") {
        queryBuilder = queryBuilder.eq("request_id", cleanQuery);
      }

      const { data, error } = await queryBuilder.order("created_at", { ascending: false }).limit(20);

      if (!error && data) {
        settlementIntents = (data as SettlementIntentRow[]).map(rowToSettlementIntent);
      }
    } catch {
      // Non-fatal
    }
  }

  // Fallback direct helper checks if direct query returned empty
  if (settlementIntents.length === 0 && client) {
    if (detectedType === "tx_hash") {
      try {
        const found = await fetchSettlementIntentByTxHash(cleanQuery.toLowerCase(), client);
        if (found) settlementIntents.push(found);
      } catch {}
    }
  }

  const activeIntent = settlementIntents[0] ?? null;
  const targetExpenseId = activeIntent?.expenseId || (detectedType === "expense_id" ? cleanQuery : null);
  const targetTripId = activeIntent?.tripId || (detectedType === "trip_id" ? cleanQuery : null);

  // 2. Fetch associated Expense
  if (targetExpenseId && client) {
    try {
      const { data } = await client.from("expenses").select("*").eq("id", targetExpenseId).maybeSingle();
      if (data) {
        expense = data as unknown as Expense;
      }
    } catch {}
  }

  // 3. Fetch associated Trip
  const effectiveTripId = targetTripId || (expense as any)?.trip_id || (expense as any)?.tripId;
  if (effectiveTripId && client) {
    try {
      const { data } = await client.from("trips").select("id, name, created_by_wallet, created_at").eq("id", effectiveTripId).maybeSingle();
      if (data) {
        tripData = {
          id: data.id,
          title: (data as any).name || "Untitled Trip",
          ownerWallet: data.created_by_wallet,
          createdAt: data.created_at,
        };
      }
    } catch {}
  }

  // 4. Horizon On-Chain Verification
  const txHashToVerify = activeIntent?.txHash || (detectedType === "tx_hash" ? cleanQuery : null);
  let horizonSummary: HorizonVerificationSummary | null = null;

  if (txHashToVerify && /^[0-9a-fA-F]{64}$/.test(txHashToVerify)) {
    try {
      const payment = await verifyPaymentByHash(txHashToVerify.toLowerCase());
      horizonSummary = {
        verified: true,
        ledger: payment.ledger,
        closedAt: payment.closedAt,
        source: payment.source,
        destination: payment.destination,
        amountStroops: payment.amountStroops.toString(),
        amountXlm: (Number(payment.amountStroops) / 10_000_000).toFixed(7),
        memo: payment.memo,
        viaPath: payment.viaPath,
      };
    } catch (err: any) {
      horizonSummary = {
        verified: false,
        ledger: null,
        closedAt: null,
        source: null,
        destination: null,
        amountStroops: null,
        amountXlm: null,
        memo: null,
        viaPath: false,
        error: err?.message || "Transaction not found on Stellar network",
      };
    }
  }

  // 5. Soroban Contract Event Check
  let contractSummary: ContractEventSummary | null = null;
  if (CONTRACT_ID && activeIntent) {
    try {
      const isPaidResult = await checkIsPaid(
        activeIntent.memberWallet,
        activeIntent.expenseId,
        activeIntent.memberWallet
      );
      contractSummary = {
        found: isPaidResult.paid,
        contractId: CONTRACT_ID,
        eventTopic: "payment_recorded",
        claimId: activeIntent.expenseId,
        ledger: activeIntent.ledger ?? null,
        recordedOnChain: isPaidResult.paid,
      };
    } catch {
      contractSummary = {
        found: false,
        contractId: CONTRACT_ID,
        eventTopic: null,
        claimId: activeIntent.expenseId,
        ledger: null,
        recordedOnChain: activeIntent.onChain,
      };
    }
  }

  // 6. Chronological Timeline Assembly
  const timeline: TimelineEvent[] = [];

  if (activeIntent) {
    // Stage 1: Intent Created
    timeline.push({
      id: "ev-intent-created",
      type: "INTENT_CREATED",
      title: "Settlement Intent Created",
      description: `Payment intent created for ${activeIntent.amount} ${activeIntent.currency} (Idempotency Key: ${activeIntent.idempotencyKey})`,
      timestamp: activeIntent.createdAt,
      status: "success",
      metadata: {
        amount: activeIntent.amount,
        currency: activeIntent.currency,
        payerWallet: activeIntent.payerWallet,
        memberWallet: activeIntent.memberWallet,
      },
    });

    // Stage 2: Payment Broadcast / Submitted
    if (activeIntent.txHash || activeIntent.status === "submitting" || activeIntent.status === "submitted" || activeIntent.status === "recorded") {
      timeline.push({
        id: "ev-payment-submitted",
        type: "PAYMENT_SUBMITTED",
        title: "Transaction Broadcast to Stellar Network",
        description: activeIntent.txHash
          ? `Submitted with hash: ${activeIntent.txHash}`
          : "Transaction submission initiated by wallet",
        timestamp: activeIntent.updatedAt,
        status: activeIntent.txHash ? "success" : "pending",
        explorerUrl: activeIntent.txHash ? `${STELLAR_EXPLORER}/tx/${activeIntent.txHash}` : null,
      });
    }

    // Stage 3: Horizon Ledger Consensus
    if (horizonSummary) {
      if (horizonSummary.verified) {
        timeline.push({
          id: "ev-ledger-confirmed",
          type: "LEDGER_CONFIRMED",
          title: "Confirmed on Stellar Ledger",
          description: `Transaction validated in ledger sequence #${horizonSummary.ledger} (${horizonSummary.amountXlm} XLM delivered)`,
          timestamp: horizonSummary.closedAt || activeIntent.updatedAt,
          status: "success",
          explorerUrl: activeIntent.txHash ? `${STELLAR_EXPLORER}/tx/${activeIntent.txHash}` : null,
          metadata: {
            ledger: horizonSummary.ledger,
            source: horizonSummary.source,
            destination: horizonSummary.destination,
            viaPath: horizonSummary.viaPath,
          },
        });
      } else {
        timeline.push({
          id: "ev-ledger-unconfirmed",
          type: "PAYMENT_DELAYED",
          title: "Ledger Confirmation Pending or Failed",
          description: horizonSummary.error || "Transaction hash not yet confirmed in a closed ledger",
          timestamp: activeIntent.updatedAt,
          status: "warning",
        });
      }
    }

    // Stage 4: Attestation & Oracle
    if (activeIntent.status === "recorded" || activeIntent.onChain) {
      timeline.push({
        id: "ev-attestation",
        type: "ATTESTATION_GENERATED",
        title: "Attestation Oracle Proof Generated",
        description: `Server-side oracle verified payment proof for expense ${activeIntent.expenseId}`,
        timestamp: activeIntent.updatedAt,
        status: "success",
      });
    }

    // Stage 5: Contract Recorded
    if (contractSummary && contractSummary.recordedOnChain) {
      timeline.push({
        id: "ev-contract-recorded",
        type: "CONTRACT_RECORDED",
        title: "Recorded on Soroban Smart Contract",
        description: `Immutable payment record anchored in contract ${CONTRACT_ID?.slice(0, 8)}...`,
        timestamp: activeIntent.updatedAt,
        status: "success",
        explorerUrl: CONTRACT_ID ? `${STELLAR_EXPLORER}/contract/${CONTRACT_ID}` : null,
      });
    } else if (activeIntent.status === "recorded" && !activeIntent.onChain) {
      timeline.push({
        id: "ev-contract-pending",
        type: "PAYMENT_DELAYED",
        title: "Contract Recording Pending",
        description: "Payment confirmed on Stellar Horizon; contract attestation proof is pending signature or submission.",
        timestamp: activeIntent.updatedAt,
        status: "warning",
      });
    }

    // Stage 6: Database State Settled
    if (activeIntent.status === "recorded") {
      timeline.push({
        id: "ev-state-settled",
        type: "STATE_SETTLED",
        title: "Settlement Fully Recorded",
        description: "Expense share marked paid and reconciled in application state.",
        timestamp: activeIntent.updatedAt,
        status: "success",
      });
    } else if (activeIntent.status === "failed") {
      timeline.push({
        id: "ev-payment-failed",
        type: "PAYMENT_FAILED",
        title: "Settlement Failed",
        description: activeIntent.errorMessage || "Settlement failed or expired.",
        timestamp: activeIntent.updatedAt,
        status: "failed",
      });
    }
  }

  // 7. Network Explorer Links
  const cleanTxHash = activeIntent?.txHash || (detectedType === "tx_hash" ? cleanQuery : null);
  const effectivePayer = activeIntent?.payerWallet || (detectedType === "wallet" ? cleanQuery : null);
  const effectiveMember = activeIntent?.memberWallet;

  const explorerLinks: SupportIncidentView["explorerLinks"] = {
    txUrl: cleanTxHash ? `${STELLAR_EXPLORER}/tx/${cleanTxHash}` : null,
    payerWalletUrl: effectivePayer ? `${STELLAR_EXPLORER}/account/${effectivePayer}` : null,
    memberWalletUrl: effectiveMember ? `${STELLAR_EXPLORER}/account/${effectiveMember}` : null,
    contractUrl: CONTRACT_ID ? `${STELLAR_EXPLORER}/contract/${CONTRACT_ID}` : null,
    networkName: NETWORK_LABEL,
  };

  const found = Boolean(expense || settlementIntents.length > 0 || horizonSummary?.verified);

  const rawIncidentView: SupportIncidentView = {
    query: cleanQuery,
    detectedType,
    found,
    readOnly: true,
    correlationId: activeIntent?.requestId ?? null,
    expense,
    trip: tripData,
    settlementIntents,
    activeIntent,
    horizonVerification: horizonSummary,
    contractEvent: contractSummary,
    timeline,
    explorerLinks,
    redactedFields: [
      "private_keys",
      "stellar_secret_keys",
      "auth_bearer_tokens",
      "session_cookies",
    ],
  };

  // Strictly apply deep recursive redaction before returning
  return redactObject(rawIncidentView);
}
