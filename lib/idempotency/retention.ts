/**
 * lib/idempotency/retention.ts
 *
 * Retention policy for idempotency records (Issue #414). Mirrored in
 * migrations/0024_idempotency_retention.sql and docs/IDEMPOTENCY.md.
 *
 * Isomorphic: no Node or Next.js imports.
 */

/** A completed response is replayable for this long; afterwards the key is free again. */
export const IDEMPOTENCY_REPLAY_TTL_SECONDS = 24 * 60 * 60;

/** Minimal audit facts (no body) are kept this long after completion, then deleted. */
export const IDEMPOTENCY_AUDIT_RETENTION_DAYS = 30;

/** A pending claim whose lease ended this long ago was abandoned and is deleted. */
export const IDEMPOTENCY_STALE_PENDING_HOURS = 24;

/** Largest stored replay summary, in bytes of its JSON encoding. Matches the SQL CHECK. */
export const IDEMPOTENCY_MAX_REPLAY_BYTES = 16 * 1024;

/** Upper bound on the process-local ledger, so a long-lived instance cannot grow without limit. */
export const IDEMPOTENCY_MAX_MEMORY_RECORDS = 10_000;

/** Rows each cleanup pass touches per category. */
export const IDEMPOTENCY_PURGE_BATCH_SIZE = 1000;
