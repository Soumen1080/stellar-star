/**
 * lib/idempotency/policy.ts
 *
 * Which mutating API routes require an Idempotency-Key (Issue #412).
 *
 * Every exported POST/PUT/PATCH/DELETE handler under app/api must appear in
 * exactly one of the two tables below. __tests__/security/requiredIdempotencyKeys.test.ts
 * scans the route tree and fails when a handler is unlisted, so a new
 * mutation cannot ship without an explicit decision.
 *
 * Paths use the app/api directory layout, with dynamic segments as written
 * on disk (e.g. `/api/expenses/[id]/void`). The human-readable version of
 * this file is docs/IDEMPOTENCY.md.
 */

export type MutatingMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export type RequiredCategory =
  | "money"
  | "invitation"
  | "receipt"
  | "recurring"
  | "support"
  | "trip-governance"
  | "account"
  | "developer-api";

export interface RequiredRoute {
  methods: MutatingMethod[];
  category: RequiredCategory;
}

/** Public mutations: 400 without a valid key, replay on retry. */
export const IDEMPOTENCY_REQUIRED_ROUTES: Record<string, RequiredRoute> = {
  // ── Money ──────────────────────────────────────────────────────────────────
  "/api/expenses": { methods: ["POST"], category: "money" },
  "/api/expenses/[id]": { methods: ["PATCH"], category: "money" },
  "/api/expenses/[id]/correct": { methods: ["POST"], category: "money" },
  "/api/expenses/[id]/void": { methods: ["POST"], category: "money" },
  "/api/trips": { methods: ["POST"], category: "money" },
  "/api/settlement/attest": { methods: ["POST"], category: "money" },
  "/api/onboarding/sponsor": { methods: ["POST"], category: "money" },
  "/api/onboarding/revoke": { methods: ["POST"], category: "money" },
  // ── Invitations ────────────────────────────────────────────────────────────
  "/api/invitations/create": { methods: ["POST"], category: "invitation" },
  "/api/invitations/claim": { methods: ["POST"], category: "invitation" },
  "/api/invitations/revoke": { methods: ["POST"], category: "invitation" },
  // ── Receipts ───────────────────────────────────────────────────────────────
  "/api/expenses/[id]/receipts": { methods: ["POST"], category: "receipt" },
  "/api/receipts/[receiptId]": { methods: ["DELETE"], category: "receipt" },
  // ── Recurring work (payment reminders and their schedules) ────────────────
  "/api/reminders": { methods: ["POST"], category: "recurring" },
  "/api/reminders/[id]": { methods: ["PATCH"], category: "recurring" },
  "/api/reminders/schedules": { methods: ["POST", "DELETE"], category: "recurring" },
  // ── Support operations ─────────────────────────────────────────────────────
  "/api/support/actions/propose": { methods: ["POST"], category: "support" },
  "/api/support/actions/approve": { methods: ["POST"], category: "support" },
  // ── Trip governance ────────────────────────────────────────────────────────
  "/api/trips/[id]/members/[memberId]/role": { methods: ["PATCH"], category: "trip-governance" },
  "/api/trips/[id]/transfer-ownership": { methods: ["POST"], category: "trip-governance" },
  // ── Account ────────────────────────────────────────────────────────────────
  "/api/account/delete": { methods: ["POST", "DELETE"], category: "account" },
  // ── Public developer API (v1) ──────────────────────────────────────────────
  "/api/v1/trips": { methods: ["POST"], category: "developer-api" },
  "/api/v1/expenses": { methods: ["POST"], category: "developer-api" },
  "/api/v1/tokens": { methods: ["POST"], category: "developer-api" },
  "/api/v1/tokens/[id]": { methods: ["DELETE"], category: "developer-api" },
  "/api/v1/webhooks": { methods: ["POST"], category: "developer-api" },
  "/api/v1/webhooks/[id]": { methods: ["DELETE"], category: "developer-api" },
  "/api/v1/webhooks/test": { methods: ["POST"], category: "developer-api" },
};

export type ExemptionKind =
  /** Cron-authenticated scheduled job; deduplicated by a natural key instead. */
  | "scheduled-job"
  /** Server derives its own idempotency key from on-chain facts. */
  | "derived-key"
  /** Establishes or refreshes a session; the challenge nonce is single-use. */
  | "session"
  /** Fire-and-forget telemetry; duplicates are harmless and expected. */
  | "telemetry"
  /** Operator diagnostics that flip process-local state; repeat calls converge. */
  | "operator-diagnostic"
  /** Uses a mutating verb but changes no business state. */
  | "read-only"
  /** Full replacement of a value, so a repeat converges (HTTP PUT semantics). */
  | "naturally-idempotent";

export interface ExemptRoute {
  methods: MutatingMethod[];
  kind: ExemptionKind;
  /** What protects this route against duplicate effects instead. */
  reason: string;
}

/** Narrow, documented exemptions. Each says what protects it instead. */
export const IDEMPOTENCY_EXEMPT_ROUTES: Record<string, ExemptRoute> = {
  "/api/recurring/run": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason:
      "Vercel Cron with CRON_SECRET. Drafts are unique on (template_id, occurrence_date), so overlapping or repeated runs create nothing new.",
  },
  "/api/idempotency/cleanup": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason:
      "Vercel Cron with CRON_SECRET. The retention sweep is batched and convergent: re-running only finds less to redact or delete.",
  },
  "/api/reminders/run": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason:
      "Vercel Cron with CRON_SECRET. Each schedule's next_run_at advances after a send, and per-pair rate limits suppress duplicates.",
  },
  "/api/receipts/retention": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason: "Vercel Cron with CRON_SECRET. Purging an already-purged receipt is a no-op.",
  },
  "/api/outbox/worker": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason: "CRON_SECRET-authenticated worker. Outbox rows are claimed with leases and delivered at least once by design.",
  },
  "/api/settlement/reconciliation-worker": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason:
      "Cron secret or explicit staff credentials only (#415); runs are bounded and recorded, and every intent it touches is keyed by the derived settlement idempotency key. Jobs are leased (#416), so overlapping runs never process one job; enqueue dedupes per intent and requeue only moves a job out of dead_letter.",
  },
  "/api/developer/reconciliation": {
    methods: ["POST"],
    kind: "scheduled-job",
    reason: "Re-export of POST /api/settlement/reconciliation-worker for the developer dashboard; same protection.",
  },
  "/api/settlement/reconcile": {
    methods: ["POST"],
    kind: "derived-key",
    reason:
      "Deduplicates on a server-derived key (txHash + expenseId + memberId + asset) backed by a unique constraint; also serves anonymous webhook re-syncs, which have no principal to scope a client key to.",
  },
  "/api/auth/verify": {
    methods: ["POST"],
    kind: "session",
    reason: "Exchanges a single-use signed challenge for a session; a replayed challenge is rejected.",
  },
  "/api/auth/refresh": {
    methods: ["POST"],
    kind: "session",
    reason: "Re-issues a session token; repeating it only yields another valid token.",
  },
  "/api/analytics/events": {
    methods: ["POST"],
    kind: "telemetry",
    reason: "Best-effort analytics beacon; duplicates are tolerated by aggregation.",
  },
  "/api/error-report": {
    methods: ["POST"],
    kind: "telemetry",
    reason: "Best-effort error telemetry; duplicates are tolerated.",
  },
  "/api/analytics/database-performance": {
    methods: ["POST"],
    kind: "operator-diagnostic",
    reason: "Runs a simulated query for the budgets panel; changes no business data.",
  },
  "/api/developer/providers": {
    methods: ["POST"],
    kind: "operator-diagnostic",
    reason:
      "Process-local operator controls: set a provider's enabled flag to an explicit value, run a health check, or reset its stats; repeats converge.",
  },
  "/api/developer/stellar-cache": {
    methods: ["POST"],
    kind: "operator-diagnostic",
    reason: "Clears or invalidates a process-local cache; repeats converge.",
  },
  "/api/developer/stellar-resilience": {
    methods: ["POST"],
    kind: "operator-diagnostic",
    reason: "Resets process-local circuit breakers; repeats converge.",
  },
  "/api/support/lookup": {
    methods: ["POST"],
    kind: "read-only",
    reason: "Read-only incident lookup sent as POST to keep identifiers out of URLs; only appends an audit entry.",
  },
  "/api/exports/archive": {
    methods: ["POST"],
    kind: "read-only",
    reason: "Builds a download of the caller's own data; only appends an export audit entry.",
  },
  "/api/onboarding/sponsor": {
    methods: ["DELETE"],
    kind: "read-only",
    reason: "Despite the verb, lists the caller's revocable sponsorships; the revocation itself is POST /api/onboarding/revoke.",
  },
  "/api/reminders/preferences": {
    methods: ["PUT"],
    kind: "naturally-idempotent",
    reason: "Sets preference fields to the given values; repeating the same PUT converges.",
  },
  "/api/reminders/unsubscribe": {
    methods: ["POST"],
    kind: "naturally-idempotent",
    reason: "One-click e-mail unsubscribe (RFC 8058) authorized by a signed token; mail clients cannot add headers, and opting out twice converges.",
  },
};

export function requiresIdempotencyKey(route: string, method: string): boolean {
  const entry = IDEMPOTENCY_REQUIRED_ROUTES[route];
  return Boolean(entry && entry.methods.includes(method.toUpperCase() as MutatingMethod));
}
