/**
 * types/reconciliation.ts
 *
 * Types for the automated on-chain reconciliation worker, queue,
 * anti-ambiguity evaluation, and operator dashboard reports.
 */

export type ReconciliationJobStatus =
  | "not_submitted"
  | "submitted_not_confirmed"
  | "confirmed_not_recorded"
  | "recorded"
  | "escalated"
  | "failed";

export interface ReconciliationJob {
  id: string;
  intentId: string | null;
  tripId: string;
  expenseId: string;
  memberId: string;
  payerWallet: string;
  memberWallet: string;
  asset: string;
  amount: string;
  amountStroops: string;
  expectedMemo: string | null;
  requestId: string | null;
  txHash: string | null;
  ledger: number | null;
  status: ReconciliationJobStatus;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string;
  escalationReason: string | null;
  errorMessage: string | null;
  verifiedAt: string | null;
  recordedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationCheckResult {
  ok: boolean;
  escalated: boolean;
  failureReason?: string;
  escalationReason?: string;
  verifiedPayment?: {
    source: string;
    destination: string;
    asset: string;
    amountStroops: bigint;
    ledger: number;
    closedAt: string;
    memo: string | null;
  };
}

export interface ReconciliationAlert {
  code: "PENDING_AGING_EXCEEDED" | "HIGH_PENDING_QUEUE" | "HIGH_FAILURE_RATE" | "AMBIGUOUS_PAYMENTS_ESCALATED";
  level: "info" | "warning" | "critical";
  message: string;
  count: number;
  threshold: number;
}

export interface ReconciliationAgingReport {
  under5m: number;
  from5mTo15m: number;
  over15m: number;
}

export interface ReconciliationSummary {
  total: number;
  notSubmitted: number;
  submittedNotConfirmed: number;
  confirmedNotRecorded: number;
  recorded: number;
  escalated: number;
  failed: number;
  totalPending: number;
  pendingAging: ReconciliationAgingReport;
  failureRatePercent: number;
}

export interface ReconciliationReport {
  summary: ReconciliationSummary;
  alerts: ReconciliationAlert[];
  thresholds: {
    maxPendingAgeMinutes: number;
    maxPendingQueue: number;
    maxFailureRatePercent: number;
    escalationThreshold: number;
  };
  jobs: ReconciliationJob[];
  totalFiltered: number;
}

export interface ReconciliationWorkerRunResult {
  processed: number;
  recorded: number;
  escalated: number;
  pending: number;
  failed: number;
  durationMs: number;
  errors: Array<{ jobId: string; error: string }>;
}
