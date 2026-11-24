# API Error Handling & Information Disclosure Prevention (Issue #420)

## Overview & Threat Model

Returning raw `error.message` to API clients exposes critical internal infrastructure details to callers and potential attackers:
- **Database Schema Disclosures**: PostgreSQL errors leak relation (table) names, column names, schema namespaces, constraint names, and query structures (e.g. `relation "trips" does not exist`, `column "secret_token" does not exist`, `violates foreign key constraint`).
- **Internal Provider & Network Leaks**: Upstream RPC provider endpoints, internal hostnames, IP addresses, ports, and connection strings (`postgres://user:pass@host:5432/db`).
- **Credential & Token Exposure**: Secret keys (Stellar seed `S...`), JWT session tokens, Authorization headers, and API keys embedded in exception messages or payloads.
- **Accidental Coupling**: External clients coupling their business logic to brittle, internal error strings rather than stable, documented error codes.

To prevent information disclosure, all public API route handlers map internal failures to stable public error codes and sanitized, safe messages. Detailed causes and unredacted stack traces are logged exclusively to server-side telemetry correlated by a unique `requestId`.

---

## Stable Public Error Taxonomy

Server-side failures are mapped to the following canonical error codes:

| Code | HTTP Status | Client-Safe Message | Cause / When Returned |
| :--- | :--- | :--- | :--- |
| `INTERNAL_ERROR` | 500 | `An unexpected internal error occurred.` | Unhandled runtime exceptions, unexpected system failures. |
| `DATABASE_ERROR` | 500 | `A database error occurred while processing your request.` | General database query failures, unhandled SQL exceptions. |
| `DATABASE_TIMEOUT` | 504 | `Database operation timed out. Please retry with a narrower query.` | Query deadline or statement timeout (`57014`), lock timeout (`55P03`), query budget exceeded. |
| `DATABASE_UNAVAILABLE` | 503 | `Database service is temporarily unavailable.` | Connection refused, connection reset, schema cache missing (`PGRST205`), database offline. |
| `PROVIDER_UNAVAILABLE` | 503 | `An upstream service is temporarily unavailable. Please retry shortly.` | Horizon or Soroban RPC node unavailable, bad gateway, 503 from Stellar network. |
| `PROVIDER_TIMEOUT` | 504 | `Upstream Stellar provider timed out. Please try again.` | Stellar Horizon/Soroban provider request timeout. |
| `STELLAR_CIRCUIT_OPEN` | 503 | `Upstream Stellar service is temporarily unavailable. Please retry shortly.` | Circuit breaker tripped due to consecutive provider failures (includes `Retry-After`). |
| `STELLAR_BULKHEAD_REJECTED` | 503 | `Service concurrency limit reached. Please try again shortly.` | Provider concurrency bulkhead saturation. |
| `ACCESS_DENIED` | 403 | `You do not have permission to perform this action.` | Row-level security (RLS) policy violation (`42501`), permission denied. |
| `RESOURCE_CONFLICT` | 409 | `A conflict occurred with an existing record.` | Unique key violation (`23505`), duplicate record conflict. |
| `INVALID_REQUEST` | 400 | Context-specific safe validation message | Malformed JSON, body too large, missing required fields. |

---

## Response Envelopes & Headers

### 1. Standard Flat Envelope (Default)

Used by standard application routes (`/api/*`):

```json
{
  "error": "Database service is temporarily unavailable.",
  "code": "DATABASE_UNAVAILABLE",
  "requestId": "req_01h8abc123456789"
}
```

### 2. Developer v1 Envelope

Used by developer v1 API routes (`/api/v1/*`):

```json
{
  "error": {
    "code": "DATABASE_ERROR",
    "message": "A database error occurred while processing your request.",
    "status": 500,
    "requestId": "req_01h8abc123456789"
  }
}
```

### HTTP Headers

All error responses include:
- `X-Request-Id`: Unique request ID for client support correlation.
- `Cache-Control: no-store`: Prevents intermediate proxies and browsers from caching error responses.
- `Retry-After`: Included on transient 503 / 429 errors when a retry window is known.

---

## Server-Side Telemetry & Correlation

While clients receive only sanitized messages, operators need full debugging context. When an error is caught:
1. `toPublicErrorResponse(err, options)` extracts or generates a `requestId`.
2. Telemetry is dispatched via `reportError(context, err, meta, severity, requestId)` correlated with `requestId`.
3. Sensitive tokens (Stellar seeds, JWTs, database URLs, passwords) are automatically redacted in the telemetry pipeline.
4. Support inquiries provide the `requestId` from the response body or `X-Request-Id` header, enabling immediate log lookup without client-side disclosure.

---

## Usage in API Routes

Route handlers should catch errors and delegate to `toPublicErrorResponse`:

```typescript
import { toPublicErrorResponse } from "@/lib/api/errors";

export async function POST(request: NextRequest) {
  try {
    // route logic...
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: request.headers.get("x-request-id"),
      fallbackMessage: "Failed to process expense.",
      route: "/api/expenses",
      method: "POST",
    });
  }
}
```

For developer routes requiring the v1 envelope, specify `format: "v1"`:

```typescript
return toPublicErrorResponse(err, {
  format: "v1",
  fallbackMessage: "Failed to create trip.",
  route: "/api/v1/trips",
  method: "POST",
});
```

---

## Verification & Fault-Injection Tests

- `__tests__/security/hideInternalErrors.test.ts`:
  - Injects simulated database faults (relation does not exist, connection drop, statement timeout, unique constraint violations).
  - Injects simulated provider faults (Horizon 503, RPC timeouts, circuit breaker open).
  - Verifies no database names, SQL keywords, secret seeds (`S...`), or stack traces are present in response bodies.
  - Verifies presence of stable `code`, safe `message`, and `requestId`.
  - Static code audit scanning all routes in `app/api/**/route.ts` to ensure no raw `error.message` leaks in 5xx error responses.
