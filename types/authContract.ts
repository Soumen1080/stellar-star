/**
 * types/authContract.ts
 *
 * Issue #456: Route Authorization Classification Metadata & Contract Specifications.
 *
 * Route classification categories:
 *  - "public": Unauthenticated routes open to all callers (e.g. status, challenge, login/verify, openapi).
 *  - "wallet": Requires valid signed wallet session JWT (`Authorization: Bearer <wallet_jwt>`).
 *  - "staff": Requires valid staff identifier or operator credentials (`x-staff-identifier` or staff secret).
 *  - "cron": Requires valid CRON secret header (`Authorization: Bearer <CRON_SECRET>`).
 *  - "api_token": Requires valid scoped developer API token (`Authorization: Bearer <stk_...>`).
 *  - "wallet_or_staff": Accepts either an authorized staff caller or a valid wallet session.
 *  - "wallet_or_cron": Accepts either a valid cron secret or a signed-in wallet session (e.g. reconciliation query).
 */

export type RouteAuthCategory =
  | "public"
  | "wallet"
  | "staff"
  | "cron"
  | "api_token"
  | "wallet_or_staff"
  | "wallet_or_cron";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface RouteAuthorizationMetadata {
  /** Relative route path normalized with leading slash, e.g. "/api/trips" */
  path: string;
  /** Supported HTTP methods under this classification */
  methods: HttpMethod[];
  /** Expected authorization contract category */
  authCategory: RouteAuthCategory;
  /** Human-readable explanation of access scope */
  description?: string;
  /** Specific scopes needed for api_token endpoints */
  requiredScopes?: string[];
  /** Optional allowed deviations / notes */
  notes?: string;
}

export interface RouteAuthMatrixTestCase {
  route: string;
  method: HttpMethod;
  category: RouteAuthCategory;
  scenario: "anonymous" | "wrong_wallet" | "expired_token" | "malformed_token" | "authorized";
  expectedStatus: number | number[]; // e.g. 401, 403, or 200..299
  description: string;
}
