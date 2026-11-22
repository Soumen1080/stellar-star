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
  | "failed"
  /** Retries or lease recoveries exhausted; parked for an operator (#416). */
  | "dead_letter";

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
  /** Leased queue (#416). Absent on rows read before migration 0026. */
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  claimCount?: number;
  leaseRecoveries?: number;
  deadLetteredAt?: string | null;
  deadLetterReason?: string | null;
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
  code:
    | "PENDING_AGING_EXCEEDED"
    | "HIGH_PENDING_QUEUE"
    | "HIGH_FAILURE_RATE"
    | "AMBIGUOUS_PAYMENTS_ESCALATED"
    | "DEAD_LETTERED_JOBS";
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
  /** Jobs parked in the dead-letter state (#416). */
  deadLetter: number;
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
    deadLetterThreshold?: number;
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
  // Leased queue (#416). Optional so older worker stubs stay valid.
  /** Jobs this batch leased; fewer than the batch size means the queue is drained. */
  claimed?: number;
  /** Jobs moved to dead_letter in this batch. */
  deadLettered?: number;
  /** Jobs whose lease passed to another worker mid-processing; their writes were discarded. */
  leaseLost?: number;
  /** Claimed jobs handed back unprocessed because the run's deadline arrived. */
  released?: number;
  /** Lease owner this batch claimed as. */
  workerId?: string;
}
