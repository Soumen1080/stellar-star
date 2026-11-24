/**
 * lib/auth/routeCatalog.ts
 *
 * Issue #456: Canonical Route Authorization Metadata Catalog.
 *
 * Every API route in app/api/ MUST be registered here with its authorization contract.
 * Any route missing from this catalog will cause CI to reject the build.
 */

import type { RouteAuthorizationMetadata } from "@/types/authContract";

export const ROUTE_AUTHORIZATION_CATALOG: RouteAuthorizationMetadata[] = [
  // ─── 1. PUBLIC ROUTES ───────────────────────────────────────────────────────
  {
    path: "/api/status",
    methods: ["GET"],
    authCategory: "public",
    description: "System health check and operational status",
  },
  {
    path: "/api/csp/report",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Content Security Policy (CSP) violation ingestion and diagnostics",
  },
  {
    path: "/api/auth/challenge",
    methods: ["GET"],
    authCategory: "public",
    description: "Cryptographic login challenge generation for wallet auth",
  },
  {
    path: "/api/auth/verify",
    methods: ["POST"],
    authCategory: "public",
    description: "Cryptographic signature verification returning session JWT",
  },
  {
    path: "/api/auth/refresh",
    methods: ["POST"],
    authCategory: "public",
    description: "Session token refresh (handles both anonymous reject and token swap)",
  },
  {
    path: "/api/fx/rate",
    methods: ["GET"],
    authCategory: "public",
    description: "Public foreign exchange rate lookups",
  },
  {
    path: "/api/error-report",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Client-side error telemetry ingest",
  },
  {
    path: "/api/analytics/events",
    methods: ["POST"],
    authCategory: "public",
    description: "Sanitized client behavioral analytics event ingest",
  },
  {
    path: "/api/analytics/metrics",
    methods: ["GET"],
    authCategory: "public",
    description: "Aggregated behavioral metrics summary",
  },
  {
    path: "/api/analytics/database-performance",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Public database performance benchmarks and fixture telemetry",
  },
  {
    path: "/api/invitations/verify",
    methods: ["GET"],
    authCategory: "public",
    description: "Public verification of invitation token validity before claiming",
  },
  {
    path: "/api/v1/openapi.json",
    methods: ["GET", "OPTIONS"],
    authCategory: "public",
    description: "Public OpenAPI schema documentation for developer API",
  },
  {
    path: "/api/reminders/unsubscribe",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Public cryptographic token-based unsubscribe from email reminders",
  },
  {
    path: "/api/developer/stellar-cache",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Diagnostic Stellar chain cache summaries and cache resets",
  },
  {
    path: "/api/developer/stellar-resilience",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Diagnostic Stellar circuit breaker telemetry and resets",
  },
  {
    path: "/api/developer/providers",
    methods: ["GET", "POST"],
    authCategory: "public",
    description: "Routing provider diagnostic lists and feature toggles",
  },
  {
    path: "/api/settlement/reconcile",
    methods: ["POST"],
    authCategory: "public",
    description: "Public on-chain settlement reconciliation fallback with optional wallet session",
  },

  // ─── 2. WALLET-AUTHENTICATED ROUTES ─────────────────────────────────────────
  {
    path: "/api/account/delete",
    methods: ["POST", "DELETE"],
    authCategory: "wallet",
    description: "Authenticated user self-service account deletion",
  },
  {
    path: "/api/account/export",
    methods: ["GET"],
    authCategory: "wallet",
    description: "Authenticated user personal data export",
  },
  {
    path: "/api/trips",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "List and create group trips",
  },
  {
    path: "/api/trips/[id]/members/[memberId]/role",
    methods: ["PATCH"],
    authCategory: "wallet",
    description: "Trip member role management (requires trip owner session)",
  },
  {
    path: "/api/trips/[id]/roles/history",
    methods: ["GET"],
    authCategory: "wallet",
    description: "Audit history of role changes within a trip",
  },
  {
    path: "/api/trips/[id]/transfer-ownership",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Transfer trip ownership to another member",
  },
  {
    path: "/api/expenses",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "Query and create shared expenses",
  },
  {
    path: "/api/expenses/[id]",
    methods: ["GET", "PATCH"],
    authCategory: "wallet",
    description: "Fetch single expense and update splits/amounts",
  },
  {
    path: "/api/expenses/[id]/correct",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Audited financial correction of an existing expense",
  },
  {
    path: "/api/expenses/[id]/void",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Void an erroneous expense with audited justification",
  },
  {
    path: "/api/expenses/[id]/receipts",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "Upload and list receipt attachments for an expense",
  },
  {
    path: "/api/expenses/[id]/receipts/intent",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Create short-lived upload intent for scanned receipts",
  },
  {
    path: "/api/receipts/capabilities",
    methods: ["GET"],
    authCategory: "wallet",
    description: "Inspect receipt upload limits and quota status for caller",
  },
  {
    path: "/api/receipts/[receiptId]",
    methods: ["GET", "DELETE"],
    authCategory: "wallet",
    description: "Fetch and delete receipt attachment object",
  },
  {
    path: "/api/receipts/[receiptId]/metadata",
    methods: ["GET"],
    authCategory: "wallet",
    description: "Retrieve verified encryption and storage metadata for receipt",
  },
  {
    path: "/api/receipts/[receiptId]/ocr",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "Submit receipt to quota-controlled OCR queue and inspect result",
  },
  {
    path: "/api/receipts/[receiptId]/ocr/review",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Human review approval of OCR data before financial write",
  },
  {
    path: "/api/ocr/quota",
    methods: ["GET"],
    authCategory: "wallet",
    description: "Check user OCR concurrency and processing quota",
  },
  {
    path: "/api/exports/archive",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Generate portable JSON archive of user trips and expenses",
  },
  {
    path: "/api/invitations/create",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Generate invite token for adding members to a trip",
  },
  {
    path: "/api/invitations/claim",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Claim an invitation token and join a group trip",
  },
  {
    path: "/api/invitations/revoke",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Revoke an outstanding trip invitation token",
  },
  {
    path: "/api/reminders",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "List and send debt settlement reminders",
  },
  {
    path: "/api/reminders/[id]",
    methods: ["GET", "PATCH"],
    authCategory: "wallet",
    description: "Inspect single reminder and update delivery status",
  },
  {
    path: "/api/reminders/preferences",
    methods: ["GET", "PUT"],
    authCategory: "wallet",
    description: "User notification preferences and quiet hours",
  },
  {
    path: "/api/reminders/schedules",
    methods: ["GET", "POST", "DELETE"],
    authCategory: "wallet",
    description: "Scheduled recurring reminder configuration",
  },
  {
    path: "/api/settlement/attest",
    methods: ["POST"],
    authCategory: "wallet",
    description: "Attest settlement intent with on-chain Soroban contract",
  },
  {
    path: "/api/onboarding/sponsor",
    methods: ["GET", "POST", "DELETE"],
    authCategory: "wallet",
    description: "Fee sponsorship onboarding requests and status",
  },
  {
    path: "/api/onboarding/revoke",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "Revocation of Stellar reserve sponsorship",
  },
  {
    path: "/api/v1/tokens",
    methods: ["GET", "POST"],
    authCategory: "wallet",
    description: "Developer API token self-service management for user wallet",
  },
  {
    path: "/api/v1/tokens/[id]",
    methods: ["DELETE"],
    authCategory: "wallet",
    description: "Revoke user-scoped developer API token",
  },

  // ─── 3. STAFF / OPERATOR ROUTES ─────────────────────────────────────────────
  {
    path: "/api/support/lookup",
    methods: ["GET", "POST"],
    authCategory: "staff",
    description: "Staff incident lookup and customer support timeline assembly",
  },
  {
    path: "/api/support/audit-logs",
    methods: ["GET"],
    authCategory: "staff",
    description: "Staff audit query log inspection",
  },
  {
    path: "/api/support/actions",
    methods: ["GET"],
    authCategory: "staff",
    description: "List dual-control corrective actions",
  },
  {
    path: "/api/support/actions/propose",
    methods: ["POST"],
    authCategory: "staff",
    description: "Propose dual-control corrective financial action",
  },
  {
    path: "/api/support/actions/approve",
    methods: ["POST"],
    authCategory: "staff",
    description: "Approve and execute dual-control corrective action (Four-Eyes Principle)",
  },

  // ─── 4. CRON / WORKER ROUTES ────────────────────────────────────────────────
  {
    path: "/api/idempotency/cleanup",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Daily automated purge of expired idempotency records",
  },
  {
    path: "/api/outbox/worker",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Leased transactional outbox worker batch processor",
  },
  {
    path: "/api/ocr/worker",
    methods: ["POST"],
    authCategory: "cron",
    description: "Quota-controlled background worker for receipt OCR",
  },
  {
    path: "/api/receipts/retention",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Automated purge of expired receipt uploads and quarantine files",
  },
  {
    path: "/api/recurring/run",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Recurring expense schedule generation and dispatch",
  },
  {
    path: "/api/reminders/run",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Automated dispatch of scheduled debt reminders",
  },
  {
    path: "/api/settlement/reconciliation-worker/cron",
    methods: ["GET"],
    authCategory: "cron",
    description: "Automated cron execution of settlement reconciliation passes",
  },
  {
    path: "/api/webhooks/dispatch",
    methods: ["GET", "POST"],
    authCategory: "cron",
    description: "Outbox webhook dispatch batch worker",
  },

  // ─── 5. HYBRID ROUTES (STAFF OR WALLET / CRON) ──────────────────────────────
  {
    path: "/api/admin/objects/rotate",
    methods: ["POST"],
    authCategory: "wallet_or_staff",
    description: "Staging key rotation for private encrypted objects",
  },
  {
    path: "/api/admin/objects/crypto-erase",
    methods: ["POST"],
    authCategory: "wallet_or_staff",
    description: "Cryptographic erasure of master keys or private objects",
  },
  {
    path: "/api/admin/audit/verify",
    methods: ["GET", "POST"],
    authCategory: "wallet_or_staff",
    description: "Privileged audit hash-chain integrity verification and anchoring",
  },
  {
    path: "/api/settlement/reconciliation-worker",
    methods: ["GET", "POST"],
    authCategory: "wallet_or_cron",
    description: "Query reconciliation reports (wallet sees own; cron/staff sees all)",
  },
  {
    path: "/api/developer/reconciliation",
    methods: ["GET", "POST"],
    authCategory: "wallet_or_cron",
    description: "Developer alias to settlement/reconciliation-worker",
  },

  // ─── 6. DEVELOPER API V1 (API TOKEN AUTHENTICATED) ──────────────────────────
  {
    path: "/api/v1/trips",
    methods: ["GET", "POST"],
    authCategory: "api_token",
    description: "Developer API v1 group trips resource",
    requiredScopes: ["trips:read", "trips:write"],
  },
  {
    path: "/api/v1/trips/[id]",
    methods: ["GET"],
    authCategory: "api_token",
    description: "Developer API v1 single trip detail",
    requiredScopes: ["trips:read"],
  },
  {
    path: "/api/v1/expenses",
    methods: ["GET", "POST"],
    authCategory: "api_token",
    description: "Developer API v1 expenses resource",
    requiredScopes: ["expenses:read", "expenses:write"],
  },
  {
    path: "/api/v1/settlements",
    methods: ["GET"],
    authCategory: "api_token",
    description: "Developer API v1 settlement intent queries",
    requiredScopes: ["settlement:read"],
  },
  {
    path: "/api/v1/webhooks",
    methods: ["GET", "POST"],
    authCategory: "api_token",
    description: "Developer API v1 webhook endpoint management",
    requiredScopes: ["webhooks:manage"],
  },
  {
    path: "/api/v1/webhooks/[id]",
    methods: ["DELETE"],
    authCategory: "api_token",
    description: "Developer API v1 delete webhook subscription",
    requiredScopes: ["webhooks:manage"],
  },
  {
    path: "/api/v1/webhooks/deliveries",
    methods: ["GET"],
    authCategory: "api_token",
    description: "Developer API v1 webhook delivery logs",
    requiredScopes: ["webhooks:manage"],
  },
  {
    path: "/api/v1/webhooks/test",
    methods: ["POST"],
    authCategory: "api_token",
    description: "Developer API v1 webhook test ping dispatch",
    requiredScopes: ["webhooks:manage"],
  },
  {
    path: "/api/v1/audit-logs",
    methods: ["GET"],
    authCategory: "api_token",
    description: "Developer API v1 audit trail for scoped token usage",
  },
];

/** Quick path-to-metadata lookup map */
export const ROUTE_AUTH_MAP = new Map<string, RouteAuthorizationMetadata>(
  ROUTE_AUTHORIZATION_CATALOG.map((meta) => [meta.path, meta])
);
