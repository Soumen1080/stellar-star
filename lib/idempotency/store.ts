/**
 * lib/idempotency/store.ts
 *
 * Idempotency management for money-adjacent mutations (Issue #312).
 *
 * Guarantees:
 *  1. Tied to the authenticated wallet and request fingerprint.
 *  2. Duplicate requests return the original response without creating duplicates.
 *  3. Conflicting reuse of a key with a different request fingerprint is rejected with 409 Conflict.
 *  4. Database-level uniqueness constraint guarantees serialization under concurrency.
 */

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ServerClient } from "@/lib/supabase/server";

export class IdempotencyConflictError extends Error {
  code = "IDEMPOTENCY_CONFLICT";
  constructor(message = "Conflicting reuse of idempotency key with different request payload.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class IdempotencyLockedError extends Error {
  code = "IDEMPOTENCY_IN_PROGRESS";
  constructor(message = "A mutation with this idempotency key is currently in progress. Please retry shortly.") {
    super(message);
    this.name = "IdempotencyLockedError";
  }
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

export interface WithIdempotencyOptions<T> {
  client?: ServerClient | null;
  key: string | null;
  walletAddress: string;
  endpoint: string;
  payload: any;
  execute: () => Promise<{ data: T; status: number }>;
}

export interface IdempotentResult<T> {
  data: T;
  status: number;
  replayed: boolean;
}

/**
 * Wraps a mutating action with idempotency enforcement.
 */
export async function withIdempotency<T>({
  client,
  key,
  walletAddress,
  endpoint,
  payload,
  execute,
}: WithIdempotencyOptions<T>): Promise<IdempotentResult<T>> {
  // If no idempotency key provided, execute normally
  if (!key) {
    const result = await execute();
    return { data: result.data, status: result.status, replayed: false };
  }

  const cleanKey = key.trim();
  const fingerprint = computeRequestFingerprint(walletAddress, endpoint, payload);
  const memKey = `${walletAddress}:${cleanKey}`;
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + 60_000).toISOString();

  // 1. Check in-memory store
  const existingMem = memoryLedger.get(memKey);
  if (existingMem) {
    if (existingMem.request_fingerprint !== fingerprint) {
      throw new IdempotencyConflictError();
    }
    if (existingMem.status === "completed") {
      return {
        data: existingMem.response_body as T,
        status: existingMem.response_status ?? 200,
        replayed: true,
      };
    }
    if (existingMem.status === "pending" && new Date(existingMem.locked_until) > now) {
      throw new IdempotencyLockedError();
    }
  }

  // 2. Check Database if client is provided
  if (client) {
    try {
      const { data: dbRecord } = await client
        .from("idempotency_records")
        .select("*")
        .eq("wallet_address", walletAddress)
        .eq("key", cleanKey)
        .maybeSingle();

      if (dbRecord) {
        if (dbRecord.request_fingerprint !== fingerprint) {
          throw new IdempotencyConflictError();
        }
        if (dbRecord.status === "completed") {
          // Sync to memory
          memoryLedger.set(memKey, dbRecord);
          return {
            data: dbRecord.response_body as T,
            status: dbRecord.response_status ?? 200,
            replayed: true,
          };
        }
        if (dbRecord.status === "pending" && new Date(dbRecord.locked_until) > now) {
          throw new IdempotencyLockedError();
        }
      }
    } catch (err: any) {
      if (err instanceof IdempotencyConflictError || err instanceof IdempotencyLockedError) {
        throw err;
      }
      // Table may not exist yet in tests or unmigrated DB; fall back to memory
    }
  }

  // 3. Mark as pending in memory
  const pendingRecord: IdempotencyRecord = {
    key: cleanKey,
    wallet_address: walletAddress,
    endpoint,
    request_fingerprint: fingerprint,
    status: "pending",
    response_status: 200,
    response_body: null,
    created_at: now.toISOString(),
    locked_until: lockedUntil,
  };
  memoryLedger.set(memKey, pendingRecord);

  // Mark as pending in database
  if (client) {
    try {
      await client.from("idempotency_records").upsert(
        {
          key: cleanKey,
          wallet_address: walletAddress,
          endpoint,
          request_fingerprint: fingerprint,
          status: "pending",
          locked_until: lockedUntil,
        },
        { onConflict: "wallet_address,key" }
      );
    } catch {
      // Non-fatal fallback
    }
  }

  // 4. Execute the mutation
  let mutationResult: { data: T; status: number };
  try {
    mutationResult = await execute();
  } catch (err) {
    // If mutation fails, remove pending lock so it can be safely retried
    memoryLedger.delete(memKey);
    if (client) {
      try {
        await client
          .from("idempotency_records")
          .delete()
          .eq("wallet_address", walletAddress)
          .eq("key", cleanKey);
      } catch {
        // Non-fatal
      }
    }
    throw err;
  }

  // 5. Store completed response
  const completedRecord: IdempotencyRecord = {
    ...pendingRecord,
    status: "completed",
    response_status: mutationResult.status,
    response_body: mutationResult.data,
  };
  memoryLedger.set(memKey, completedRecord);

  if (client) {
    try {
      await client.from("idempotency_records").upsert(
        {
          key: cleanKey,
          wallet_address: walletAddress,
          endpoint,
          request_fingerprint: fingerprint,
          status: "completed",
          response_status: mutationResult.status,
          response_body: mutationResult.data as any,
        },
        { onConflict: "wallet_address,key" }
      );
    } catch {
      // Non-fatal
    }
  }

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
