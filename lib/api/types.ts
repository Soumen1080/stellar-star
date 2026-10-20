/**
 * Types and interfaces for the StellarStar Developer API v1,
 * scoped tokens, webhooks framework, and audit logging.
 */

export const API_VERSION = "v1";

export type ApiScope =
  | "trips:read"
  | "trips:write"
  | "expenses:read"
  | "expenses:write"
  | "settlement:read"
  | "webhooks:manage";

export const ALL_API_SCOPES: ApiScope[] = [
  "trips:read",
  "trips:write",
  "expenses:read",
  "expenses:write",
  "settlement:read",
  "webhooks:manage",
];

export interface ScopedTokenPayload {
  tokenId: string;
  walletAddress: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  expiresAt: string | null;
}

export interface ApiTokenRecord extends ScopedTokenPayload {
  tokenMasked: string; // e.g. "stk_live_...a8f2"
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    limit: number;
    cursor: string | null;
    hasMore: boolean;
    total?: number;
  };
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
  };
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  tokenId: string | null;
  walletAddress: string;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  ip: string;
  userAgent: string;
  idempotencyKey?: string | null;
}

export type WebhookEventName =
  | "trip.created"
  | "trip.updated"
  | "expense.created"
  | "expense.updated"
  | "settlement.started"
  | "settlement.completed"
  | "settlement.failed"
  | "ping";

export interface WebhookEndpoint {
  id: string;
  walletAddress: string;
  url: string;
  secret: string; // "whsec_..."
  events: WebhookEventName[];
  active: boolean;
  createdAt: string;
  description?: string;
}

export interface WebhookDeliveryLog {
  id: string;
  webhookId: string;
  event: WebhookEventName;
  payload: Record<string, unknown>;
  statusCode: number | null;
  attempt: number;
  latencyMs: number;
  success: boolean;
  error?: string | null;
  timestamp: string;
  signature: string;
}
