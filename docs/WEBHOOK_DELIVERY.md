# Webhook delivery

Webhook creation and event delivery require the server-side `SUPABASE_SERVICE_ROLE_KEY`; this key must never be exposed as a `NEXT_PUBLIC_` variable. Apply migration `0019_durable_webhook_delivery.sql` before enabling the API. Configure `WEBHOOK_DISPATCH_SECRET` as a high entropy deployment secret and configure the scheduled caller to send `Authorization: Bearer <secret>` to `/api/webhooks/dispatch` once per minute.

Event producers enqueue a canonical JSON envelope using a stable event UUID. PostgreSQL uniqueness makes producer retries idempotent. The worker claims at most ten rows using `FOR UPDATE SKIP LOCKED`, applies a five second request timeout, retries at most eight times with exponential backoff and jitter, and disables endpoints after ten consecutive failures. HTTP 429 and 5xx responses follow the same bounded retry policy. Redirects are rejected.

Signatures use `t=<unix-seconds>,v1=<hex-hmac-sha256>` over `<timestamp>.<exact UTF-8 request body>`. Delivery diagnostics contain status and a coarse error only; request bodies, signatures, endpoint secrets, and full exception messages are not returned.
