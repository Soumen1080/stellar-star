/**
 * lib/idempotency/store.ts
 *
 * Atomic Idempotency Management for Money-Adjacent Mutations (Issue #312 & Issue #411).
 *
 * Guarantees:
 *  1. Atomic claim in database/memory as one single transaction (no read-then-insert race).
 *  2. Deliberate four-outcome evaluation:
 *     - 'new_claim': Fresh lock acquired or recovered from expired lease.
 *     - 'completed_replay': Mutation already finished; cached result replayed without re-executing.
 *     - 'incompatible_key_conflict': Same key reused with different request payload (409 Conflict).
 *     - 'temporarily_locked': Mutation currently in progress by another worker (retryable 409/429).
 *  3. Leased locks for crash recovery: Storing completion occurs only after business execution,
 *     and expired locks can be safely recovered by retries.
 *  4. Tied to the authenticated wallet and request fingerprint.
 */

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ServerClient } from "@/lib/supabase/server";

export class IdempotencyConflictError extends Error {
  code = "IDEMPOTENCY_CONFLICT";
  status = 409;
  constructor(message = "Conflicting reuse of idempotency key with different request payload.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyLockedError extends Error {
  code = "IDEMPOTENCY_IN_PROGRESS";
  status = 409;
  constructor(message = "A mutation with this idempotency key is currently in progress. Please retry shortly.") {
    super(message);
    this.name = "IdempotencyLockedError";
  }
}

export type IdempotencyClaimOutcome =
  | "new_claim"
  | "completed_replay"
  | "incompatible_key_conflict"
  | "temporarily_locked";

export interface IdempotencyClaimResult {
  outcome: IdempotencyClaimOutcome;
  responseStatus?: number;
  responseBody?: any;
  lockedUntil?: string;
  recovered?: boolean;
  retryAfterSeconds?: number;
  error?: string;
}

export interface IdempotencyRecord {
  key: string;
  wallet_address: string;
  endpoint: string;
  request_fingerprint: string;
  status: "pending" | "completed" | "failed";
  response_status: number | null;
  response_body: any;
  created_at: string;
  locked_until: string;
}

// Global in-memory ledger for fast local development and process-level serialization
declare global {
  var stellarStarIdempotencyMem: Map<string, IdempotencyRecord> | undefined;
}

const memoryLedger =
  globalThis.stellarStarIdempotencyMem ?? new Map<string, IdempotencyRecord>();
globalThis.stellarStarIdempotencyMem = memoryLedger;

/**
 * Extracts the idempotency key from request headers or body.
 */
export function extractIdempotencyKey(request: NextRequest, body?: any): string | null {
  const headerKey =
    request.headers.get("idempotency-key") ||
    request.headers.get("x-idempotency-key") ||
    request.headers.get("Idempotency-Key");

  if (headerKey && headerKey.trim()) {
    return headerKey.trim();
  }

  if (body && typeof body === "object" && typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()) {
    return body.idempotencyKey.trim();
  }

  return null;
}

/**
 * Produces a deterministic canonical string representation of an object.
 */
function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  return `{${keys
    .filter((k) => k !== "idempotencyKey" && k !== "id") // Exclude client-generated identifiers from fingerprint
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * Computes a SHA-256 fingerprint from the wallet, endpoint path, and request payload.
 */
export function computeRequestFingerprint(
  walletAddress: string,
  endpoint: string,
  payload: any
): string {
  const normalized = `${walletAddress}:${endpoint}:${stableStringify(payload)}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * In-memory atomic claim logic for local development, unit tests, and non-database environments.
 * Deliberately evaluates the 4 outcomes and recovers expired leases.
 */
export function atomicClaimInMemory(
  walletAddress: string,
  key: string,
  endpoint: string,
  fingerprint: string,
  leaseSeconds = 60,
  now = Date.now(),
): IdempotencyClaimResult {
  const memKey = `${walletAddress}:${key}`;
  const existing = memoryLedger.get(memKey);

  if (!existing) {
    const lockedUntil = new Date(now + leaseSeconds * 1000).toISOString();
    const newRecord: IdempotencyRecord = {
      key,
      wallet_address: walletAddress,
      endpoint,
      request_fingerprint: fingerprint,
      status: "pending",
      response_status: null,
      response_body: null,
      created_at: new Date(now).toISOString(),
      locked_until: lockedUntil,
    };
    memoryLedger.set(memKey, newRecord);
    return { outcome: "new_claim", lockedUntil };
  }

  // 1. Incompatible-key conflict
  if (existing.request_fingerprint !== fingerprint) {
    return {
      outcome: "incompatible_key_conflict",
      error: "Conflicting reuse of idempotency key with different request payload.",
    };
  }

  // 2. Completed replay
  if (existing.status === "completed") {
    return {
      outcome: "completed_replay",
      responseStatus: existing.response_status ?? 200,
      responseBody: existing.response_body,
    };
  }

  // 3 & 4. Pending: evaluate lease expiration for crashed worker recovery
  if (existing.status === "pending") {
    const lockExpiry = new Date(existing.locked_until).getTime();
    if (lockExpiry > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lockExpiry - now) / 1000));
      return {
        outcome: "temporarily_locked",
        lockedUntil: existing.locked_until,
        retryAfterSeconds,
      };
    }

    // Lease expired: recover the lease!
    const lockedUntil = new Date(now + leaseSeconds * 1000).toISOString();
    existing.locked_until = lockedUntil;
    existing.endpoint = endpoint;
    existing.request_fingerprint = fingerprint;
    existing.created_at = new Date(now).toISOString();
    return { outcome: "new_claim", recovered: true, lockedUntil };
  }

  // Failed records can be re-claimed
  const lockedUntil = new Date(now + leaseSeconds * 1000).toISOString();
  existing.status = "pending";
  existing.locked_until = lockedUntil;
  existing.endpoint = endpoint;
  existing.request_fingerprint = fingerprint;
  return { outcome: "new_claim", recovered: true, lockedUntil };
}

export interface ClaimIdempotencyOptions {
  client?: ServerClient | null;
  walletAddress: string;
  key: string;
  endpoint: string;
  fingerprint: string;
  leaseSeconds?: number;
  now?: number;
}

/**
 * Performs an atomic idempotency claim as a single transaction (Issue #411).
 * Uses PostgreSQL RPC `claim_idempotency_key` when client is available,
 * and falls back to atomic in-memory claims in local development and test fixtures.
 */
export async function claimIdempotencyKey({
  client,
  walletAddress,
  key,
  endpoint,
  fingerprint,
  leaseSeconds = 60,
  now = Date.now(),
}: ClaimIdempotencyOptions): Promise<IdempotencyClaimResult> {
  const memKey = `${walletAddress}:${key}`;

  // 1. Try atomic claim in database via stored procedure
  if (client) {
    try {
      const { data, error } = await (client as any).rpc("claim_idempotency_key", {
        p_wallet_address: walletAddress,
        p_key: key,
        p_endpoint: endpoint,
        p_request_fingerprint: fingerprint,
        p_lease_seconds: leaseSeconds,
        p_now: new Date(now).toISOString(),
      });

      if (!error && data && typeof data === "object") {
        const parsed = data as Record<string, any>;
        const rawOutcome = parsed.outcome;
        let outcome: IdempotencyClaimOutcome;

        if (rawOutcome === "completed_replay" || rawOutcome === "replay") {
          outcome = "completed_replay";
        } else if (rawOutcome === "incompatible_key_conflict" || rawOutcome === "conflict") {
          outcome = "incompatible_key_conflict";
        } else if (rawOutcome === "temporarily_locked" || rawOutcome === "locked") {
          outcome = "temporarily_locked";
        } else {
          outcome = "new_claim";
        }

        const result: IdempotencyClaimResult = {
          outcome,
          responseStatus: parsed.response_status ? Number(parsed.response_status) : undefined,
          responseBody: parsed.response_body,
          lockedUntil: parsed.locked_until ? String(parsed.locked_until) : undefined,
          recovered: Boolean(parsed.recovered),
          retryAfterSeconds: parsed.retry_after_seconds ? Number(parsed.retry_after_seconds) : undefined,
          error: parsed.error ? String(parsed.error) : undefined,
        };

        // Sync to memory ledger
        if (outcome === "new_claim") {
          memoryLedger.set(memKey, {
            key,
            wallet_address: walletAddress,
            endpoint,
            request_fingerprint: fingerprint,
            status: "pending",
            response_status: null,
            response_body: null,
            created_at: new Date(now).toISOString(),
            locked_until: result.lockedUntil || new Date(now + leaseSeconds * 1000).toISOString(),
          });
        } else if (outcome === "completed_replay") {
          memoryLedger.set(memKey, {
            key,
            wallet_address: walletAddress,
            endpoint,
            request_fingerprint: fingerprint,
            status: "completed",
            response_status: result.responseStatus ?? 200,
            response_body: result.responseBody,
            created_at: new Date(now).toISOString(),
            locked_until: "",
          });
        }

        return result;
      }
    } catch {
      // Fall through to in-memory atomic claim if DB RPC is unconfigured or unavailable
    }
  }

  // 2. In-memory atomic claim
  return atomicClaimInMemory(walletAddress, key, endpoint, fingerprint, leaseSeconds, now);
}

export interface CompleteIdempotencyOptions {
  client?: ServerClient | null;
  walletAddress: string;
  key: string;
  fingerprint: string;
  responseStatus: number;
  responseBody: any;
}

/**
 * Stores completed idempotency result.
 * Called only AFTER business mutation finishes successfully.
 */
export async function completeIdempotencyClaim({
  client,
  walletAddress,
  key,
  fingerprint,
  responseStatus,
  responseBody,
}: CompleteIdempotencyOptions): Promise<void> {
  const memKey = `${walletAddress}:${key}`;

  // Update memory
  const existing = memoryLedger.get(memKey);
  const completedRecord: IdempotencyRecord = {
    key,
    wallet_address: walletAddress,
    endpoint: existing?.endpoint || "",
    request_fingerprint: fingerprint,
    status: "completed",
    response_status: responseStatus,
    response_body: responseBody,
    created_at: existing?.created_at || new Date().toISOString(),
    locked_until: "",
  };
  memoryLedger.set(memKey, completedRecord);

  // Update database
  if (client) {
    try {
      const { error } = await (client as any).rpc("complete_idempotency_key", {
        p_wallet_address: walletAddress,
        p_key: key,
        p_request_fingerprint: fingerprint,
        p_response_status: responseStatus,
        p_response_body: responseBody as any,
      });

      if (error) {
        // Fallback update directly if RPC not available
        await client
          .from("idempotency_records")
          .update({
            status: "completed",
            response_status: responseStatus,
            response_body: responseBody as any,
          })
          .eq("wallet_address", walletAddress)
          .eq("key", key)
          .eq("request_fingerprint", fingerprint);
      }
    } catch {
      // Non-fatal
    }
  }
}

export interface ReleaseIdempotencyOptions {
  client?: ServerClient | null;
  walletAddress: string;
  key: string;
}

/**
 * Releases a pending idempotency lock on business mutation failure
 * so that subsequent retries can re-claim immediately.
 */
export async function releaseIdempotencyClaim({
  client,
  walletAddress,
  key,
}: ReleaseIdempotencyOptions): Promise<void> {
  const memKey = `${walletAddress}:${key}`;
  memoryLedger.delete(memKey);

  if (client) {
    try {
      const { error } = await (client as any).rpc("release_idempotency_key", {
        p_wallet_address: walletAddress,
        p_key: key,
      });

      if (error) {
        await client
          .from("idempotency_records")
          .delete()
          .eq("wallet_address", walletAddress)
          .eq("key", key)
          .eq("status", "pending");
      }
    } catch {
      // Non-fatal
    }
  }
}

export interface WithIdempotencyOptions<T> {
  client?: ServerClient | null;
  key: string | null;
  walletAddress: string;
  endpoint: string;
  payload: any;
  execute: () => Promise<{ data: T; status: number }>;
  leaseSeconds?: number;
}

export interface IdempotentResult<T> {
  data: T;
  status: number;
  replayed: boolean;
}

/**
 * Wraps a mutating action with atomic idempotency enforcement.
 *
 * Prevents race conditions by claiming the idempotency key in one atomic transaction.
 * Deliberately handles:
 * - 'new_claim': Executes the business mutation once, then stores the completed result.
 * - 'completed_replay': Replays the cached response without re-executing.
 * - 'incompatible_key_conflict': Throws IdempotencyConflictError (409).
 * - 'temporarily_locked': Throws IdempotencyLockedError (409/429 retryable).
 */
export async function withIdempotency<T>({
  client,
  key,
  walletAddress,
  endpoint,
  payload,
  execute,
  leaseSeconds = 60,
}: WithIdempotencyOptions<T>): Promise<IdempotentResult<T>> {
  // If no idempotency key provided, execute normally
  if (!key) {
    const result = await execute();
    return { data: result.data, status: result.status, replayed: false };
  }

  const cleanKey = key.trim();
  const fingerprint = computeRequestFingerprint(walletAddress, endpoint, payload);

  // 1. Atomically claim idempotency key (1 transaction)
  const claim = await claimIdempotencyKey({
    client,
    walletAddress,
    key: cleanKey,
    endpoint,
    fingerprint,
    leaseSeconds,
  });

  // Handle outcome: Incompatible-key conflict
  if (claim.outcome === "incompatible_key_conflict") {
    throw new IdempotencyConflictError(claim.error);
  }

  // Handle outcome: Temporarily locked (in-flight parallel request)
  if (claim.outcome === "temporarily_locked") {
    throw new IdempotencyLockedError();
  }

  // Handle outcome: Completed replay (exact result without re-executing)
  if (claim.outcome === "completed_replay") {
    return {
      data: claim.responseBody as T,
      status: claim.responseStatus ?? 200,
      replayed: true,
    };
  }

  // Handle outcome: New claim (or recovered expired lease)
  // Execute the business mutation
  let mutationResult: { data: T; status: number };
  try {
    mutationResult = await execute();
  } catch (err) {
    // Release pending lock so retry can claim immediately
    await releaseIdempotencyClaim({ client, walletAddress, key: cleanKey });
    throw err;
  }

  // Store completion only after business operation completes successfully
  await completeIdempotencyClaim({
    client,
    walletAddress,
    key: cleanKey,
    fingerprint,
    responseStatus: mutationResult.status,
    responseBody: mutationResult.data,
  });

  return {
    data: mutationResult.data,
    status: mutationResult.status,
    replayed: false,
  };
}

/**
 * Helper to construct an idempotent API response with replay header.
 */
export function idempotentJsonResponse<T>(result: IdempotentResult<T>): NextResponse {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
  };
  if (result.replayed) {
    headers["Idempotent-Replayed"] = "true";
  }
  return NextResponse.json(result.data, {
    status: result.status,
    headers,
  });
}

/** Helper to reset in-memory idempotency ledger for tests */
export function __resetIdempotencyForTests(): void {
  memoryLedger.clear();
}
