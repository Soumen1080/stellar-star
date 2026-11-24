/**
 * lib/support/types.ts
 *
 * Types and interfaces for the Incident-Response and Support Console (Issue #314).
 *
 * Provides structured types for:
 * 1. Search queries across txHash, wallet, tripId, expenseId, correlationId.
 * 2. Redacted incident timeline models.
 * 3. Unified read-only payment, expense, intent, and contract state views.
 * 4. Staff lookup audit logs.
 * 5. Dual-control corrective actions (Four-Eyes Principle).
 */

import type { SettlementIntent } from "@/lib/settlement/intent";
import type { Expense } from "@/types/expense";

export type SupportQueryType =
  | "tx_hash"
  | "wallet"
  | "trip_id"
  | "expense_id"
  | "correlation_id";

export interface SupportSearchParams {
  query: string;
  queryType?: SupportQueryType;
}

export type TimelineEventType =
  | "INTENT_CREATED"
  | "PAYMENT_SUBMITTED"
  | "LEDGER_CONFIRMED"
  | "ATTESTATION_GENERATED"
  | "CONTRACT_RECORDED"
  | "STATE_SETTLED"
  | "PAYMENT_DELAYED"
  | "PAYMENT_FAILED"
  | "AMBIGUOUS_PAYMENT"
  | "CORRECTIVE_ACTION";

export type TimelineEventStatus = "success" | "pending" | "failed" | "warning" | "info";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  description: string;
  timestamp: string;
  status: TimelineEventStatus;
  metadata?: Record<string, unknown>;
  explorerUrl?: string | null;
}

export interface SupportExplorerLinks {
  txUrl: string | null;
  payerWalletUrl: string | null;
  memberWalletUrl: string | null;
  contractUrl: string | null;
  networkName: string;
}

export interface HorizonVerificationSummary {
  verified: boolean;
  ledger: number | null;
  closedAt: string | null;
  source: string | null;
  destination: string | null;
  amountStroops: string | null;
  amountXlm: string | null;
  memo: string | null;
  viaPath: boolean;
  error?: string | null;
}

export interface ContractEventSummary {
  found: boolean;
  contractId: string | null;
  eventTopic: string | null;
  claimId: string | null;
  ledger: number | null;
  recordedOnChain: boolean;
}

export interface SupportIncidentView {
  query: string;
  detectedType: SupportQueryType;
  found: boolean;
  readOnly: true;
  correlationId: string | null;
  expense: Expense | null;
  trip: {
    id: string;
    title: string;
    ownerWallet: string;
    createdAt: string;
  } | null;
  settlementIntents: SettlementIntent[];
  activeIntent: SettlementIntent | null;
  horizonVerification: HorizonVerificationSummary | null;
  contractEvent: ContractEventSummary | null;
  timeline: TimelineEvent[];
  explorerLinks: SupportExplorerLinks;
  redactedFields: string[];
}

export interface SupportAuditLogEntry {
  id: string;
  staffIdentifier: string;
  queryType: SupportQueryType;
  queryValueMasked: string;
  resultsCount: number;
  ipAddress: string;
  userAgent?: string | null;
  timestamp: string;
}

export type CorrectiveActionType =
  | "FORCE_RECONCILE"
  | "MARK_INTENT_FAILED"
  | "FLAG_AMBIGUOUS_INVESTIGATION";

export type CorrectiveActionStatus =
  | "pending_approval"
  | "approved"
  | "executed"
  | "rejected"
  | "expired";

export interface CorrectiveActionProposal {
  id: string;
  actionType: CorrectiveActionType;
  targetId: string;
  targetType: "intent" | "expense";
  ticketRef: string;
  reason: string;
  details: Record<string, unknown>;
  proposedBy: string;
  proposedAt: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  status: CorrectiveActionStatus;
  executionResult?: Record<string, unknown> | null;
  expiresAt: string;
}
