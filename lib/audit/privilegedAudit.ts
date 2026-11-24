/**
 * lib/audit/privilegedAudit.ts
 *
 * Issue #455: Tamper-Evident Privileged Audit Service.
 *
 * Appends actor, decision, target, request ID, and chained hash entries;
 * disallows mutation; and provides verifiable integrity anchors and chain verification.
 */

import crypto from "node:crypto";
import type {
  PrivilegedAuditEntry,
  PrivilegedAuditEntryInput,
  AuditIntegrityAnchor,
  AuditVerificationReport,
  AuditVerificationFailure,
} from "@/types/audit";
import type { StellarStarClient } from "@/lib/supabase/client";

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// In-memory fallback ledger for tests and environments without full DB connection
declare global {
  var stellarStarPrivilegedAudits: PrivilegedAuditEntry[] | undefined;
  var stellarStarAuditAnchors: AuditIntegrityAnchor[] | undefined;
}

const memoryAudits: PrivilegedAuditEntry[] = globalThis.stellarStarPrivilegedAudits ?? [];
globalThis.stellarStarPrivilegedAudits = memoryAudits;

const memoryAnchors: AuditIntegrityAnchor[] = globalThis.stellarStarAuditAnchors ?? [];
globalThis.stellarStarAuditAnchors = memoryAnchors;

/**
 * Deterministically computes the SHA-256 hash of an audit entry.
 */
export function computeEntryHash(
  payload: {
    sequenceId: number;
    id: string;
    actorWallet: string;
    actorRole: string;
    action: string;
    decision: string;
    targetType: string;
    targetId: string;
    requestId: string | null;
    causationId: string | null;
    ipAddress: string | null;
    metadata: Record<string, unknown>;
    prevEntryHash: string;
    createdAt: string;
  }
): string {
  // Sort metadata keys deterministically
  const sortedMetadata = Object.keys(payload.metadata || {})
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = payload.metadata[key];
      return acc;
    }, {});

  const canonicalRepresentation = JSON.stringify({
    sequenceId: payload.sequenceId,
    id: payload.id,
    actorWallet: payload.actorWallet.trim().toUpperCase(),
    actorRole: payload.actorRole,
    action: payload.action,
    decision: payload.decision,
    targetType: payload.targetType,
    targetId: payload.targetId,
    requestId: payload.requestId ?? null,
    causationId: payload.causationId ?? null,
    ipAddress: payload.ipAddress ?? null,
    metadata: sortedMetadata,
    prevEntryHash: payload.prevEntryHash,
    createdAt: payload.createdAt,
  });

  return crypto.createHash("sha256").update(canonicalRepresentation).digest("hex");
}

/**
 * Builds a Merkle root or combined digest from a sequence of entry hashes.
 */
export function computeDigestForEntries(hashes: string[]): string {
  if (hashes.length === 0) return GENESIS_HASH;
  if (hashes.length === 1) return hashes[0];

  let currentLevel = [...hashes];
  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        const combined = crypto
          .createHash("sha256")
          .update(currentLevel[i] + currentLevel[i + 1])
          .digest("hex");
        nextLevel.push(combined);
      } else {
        // Odd node duplicated to keep balanced Merkle tree
        const combined = crypto
          .createHash("sha256")
          .update(currentLevel[i] + currentLevel[i])
          .digest("hex");
        nextLevel.push(combined);
      }
    }
    currentLevel = nextLevel;
  }
  return currentLevel[0];
}

/**
 * Appends a privileged audit entry with cryptographic hash chaining.
 */
export async function appendPrivilegedAudit(
  input: PrivilegedAuditEntryInput,
  client?: StellarStarClient
): Promise<PrivilegedAuditEntry> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const actorRole = input.actorRole ?? "user";
  const metadata = input.metadata ?? {};

  let prevEntryHash = GENESIS_HASH;
  let sequenceId = 1;

  if (client) {
    try {
      const { data: latest } = await client
        .from("privileged_audit_log")
        .select("sequence_id, entry_hash")
        .order("sequence_id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest) {
        sequenceId = Number(latest.sequence_id) + 1;
        prevEntryHash = latest.entry_hash;
      }
    } catch {
      // Fallback to memory sequence if query fails
      if (memoryAudits.length > 0) {
        const last = memoryAudits[memoryAudits.length - 1];
        sequenceId = last.sequenceId + 1;
        prevEntryHash = last.entryHash;
      }
    }
  } else if (memoryAudits.length > 0) {
    const last = memoryAudits[memoryAudits.length - 1];
    sequenceId = last.sequenceId + 1;
    prevEntryHash = last.entryHash;
  }

  const entryHash = computeEntryHash({
    sequenceId,
    id,
    actorWallet: input.actorWallet,
    actorRole,
    action: input.action,
    decision: input.decision,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: input.requestId ?? null,
    causationId: input.causationId ?? null,
    ipAddress: input.ipAddress ?? null,
    metadata,
    prevEntryHash,
    createdAt,
  });

  const entry: PrivilegedAuditEntry = {
    sequenceId,
    id,
    actorWallet: input.actorWallet,
    actorRole,
    action: input.action,
    decision: input.decision,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: input.requestId ?? null,
    causationId: input.causationId ?? null,
    ipAddress: input.ipAddress ?? null,
    metadata,
    prevEntryHash,
    entryHash,
    createdAt,
  };

  // 1. In-memory append
  memoryAudits.push(entry);

  // 2. Database append (if client configured)
  if (client) {
    try {
      await client.from("privileged_audit_log").insert({
        id: entry.id,
        sequence_id: entry.sequenceId,
        actor_wallet: entry.actorWallet,
        actor_role: entry.actorRole,
        action: entry.action,
        decision: entry.decision,
        target_type: entry.targetType,
        target_id: entry.targetId,
        request_id: entry.requestId,
        causation_id: entry.causationId,
        ip_address: entry.ipAddress,
        metadata: entry.metadata,
        prev_entry_hash: entry.prevEntryHash,
        entry_hash: entry.entryHash,
        created_at: entry.createdAt,
      });
    } catch (err) {
      console.error("[PrivilegedAudit] Database persistence failed, kept in-memory:", err);
    }
  }

  return entry;
}

/**
 * Creates and stores an anchor digest covering entries up to the current head.
 */
export async function createAuditIntegrityAnchor(
  options: {
    anchoredBy?: string;
    metadata?: Record<string, unknown>;
  } = {},
  client?: StellarStarClient
): Promise<AuditIntegrityAnchor | null> {
  let entries: PrivilegedAuditEntry[] = [];

  if (client) {
    try {
      const { data } = await client
        .from("privileged_audit_log")
        .select("*")
        .order("sequence_id", { ascending: true });

      if (data && data.length > 0) {
        entries = data.map((row: any) => ({
          sequenceId: Number(row.sequence_id),
          id: row.id,
          actorWallet: row.actor_wallet,
          actorRole: row.actor_role,
          action: row.action,
          decision: row.decision,
          targetType: row.target_type,
          targetId: row.target_id,
          requestId: row.request_id,
          causationId: row.causation_id,
          ipAddress: row.ip_address,
          metadata: row.metadata || {},
          prevEntryHash: row.prev_entry_hash,
          entryHash: row.entry_hash,
          createdAt: row.created_at,
        }));
      }
    } catch {
      entries = memoryAudits;
    }
  } else {
    entries = memoryAudits;
  }

  if (entries.length === 0) return null;

  const startSequenceId = entries[0].sequenceId;
  const endSequenceId = entries[entries.length - 1].sequenceId;
  const hashes = entries.map((e) => e.entryHash);
  const merkleRoot = computeDigestForEntries(hashes);

  const anchorHash = crypto
    .createHash("sha256")
    .update(`${startSequenceId}:${endSequenceId}:${entries.length}:${merkleRoot}`)
    .digest("hex");

  const anchor: AuditIntegrityAnchor = {
    id: crypto.randomUUID(),
    startSequenceId,
    endSequenceId,
    entriesCount: entries.length,
    merkleRoot,
    anchorHash,
    anchoredBy: options.anchoredBy ?? "system",
    metadata: options.metadata ?? {},
    createdAt: new Date().toISOString(),
  };

  memoryAnchors.push(anchor);

  if (client) {
    try {
      await client.from("audit_integrity_anchors").insert({
        id: anchor.id,
        start_sequence_id: anchor.startSequenceId,
        end_sequence_id: anchor.endSequenceId,
        entries_count: anchor.entriesCount,
        merkle_root: anchor.merkleRoot,
        anchor_hash: anchor.anchorHash,
        anchored_by: anchor.anchoredBy,
        metadata: anchor.metadata,
        created_at: anchor.createdAt,
      });
    } catch (err) {
      console.error("[PrivilegedAudit] Failed to persist anchor digest:", err);
    }
  }

  return anchor;
}

/**
 * Validates the entire cryptographic hash chain and verifies anchors.
 * Returns detailed verification report identifying any tampering or missing links.
 */
export async function verifyAuditChainIntegrity(
  client?: StellarStarClient
): Promise<AuditVerificationReport> {
  let entries: PrivilegedAuditEntry[] = [];
  let anchors: AuditIntegrityAnchor[] = [];

  if (client) {
    try {
      const { data: logData } = await client
        .from("privileged_audit_log")
        .select("*")
        .order("sequence_id", { ascending: true });

      if (logData && logData.length > 0) {
        entries = logData.map((row: any) => ({
          sequenceId: Number(row.sequence_id),
          id: row.id,
          actorWallet: row.actor_wallet,
          actorRole: row.actor_role,
          action: row.action,
          decision: row.decision,
          targetType: row.target_type,
          targetId: row.target_id,
          requestId: row.request_id,
          causationId: row.causation_id,
          ipAddress: row.ip_address,
          metadata: row.metadata || {},
          prevEntryHash: row.prev_entry_hash,
          entryHash: row.entry_hash,
          createdAt: row.created_at,
        }));
      }

      const { data: anchorData } = await client
        .from("audit_integrity_anchors")
        .select("*")
        .order("end_sequence_id", { ascending: true });

      if (anchorData && anchorData.length > 0) {
        anchors = anchorData.map((row: any) => ({
          id: row.id,
          startSequenceId: Number(row.start_sequence_id),
          endSequenceId: Number(row.end_sequence_id),
          entriesCount: Number(row.entries_count),
          merkleRoot: row.merkle_root,
          anchorHash: row.anchor_hash,
          anchoredBy: row.anchored_by,
          metadata: row.metadata || {},
          createdAt: row.created_at,
        }));
      }
    } catch {
      entries = memoryAudits;
      anchors = memoryAnchors;
    }
  } else {
    entries = memoryAudits;
    anchors = memoryAnchors;
  }

  const failures: AuditVerificationFailure[] = [];

  if (entries.length === 0) {
    return {
      valid: true,
      totalEntriesChecked: 0,
      anchorsChecked: anchors.length,
      failures: [],
    };
  }

  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // 1. Verify previous hash chaining
    if (entry.prevEntryHash !== expectedPrevHash) {
      failures.push({
        sequenceId: entry.sequenceId,
        id: entry.id,
        expectedHash: expectedPrevHash,
        actualHash: entry.prevEntryHash,
        reason: "CHAIN_BROKEN",
      });
    }

    // 2. Recompute current hash
    const recomputedHash = computeEntryHash({
      sequenceId: entry.sequenceId,
      id: entry.id,
      actorWallet: entry.actorWallet,
      actorRole: entry.actorRole,
      action: entry.action,
      decision: entry.decision,
      targetType: entry.targetType,
      targetId: entry.targetId,
      requestId: entry.requestId,
      causationId: entry.causationId,
      ipAddress: entry.ipAddress,
      metadata: entry.metadata,
      prevEntryHash: entry.prevEntryHash,
      createdAt: entry.createdAt,
    });

    if (entry.entryHash !== recomputedHash) {
      failures.push({
        sequenceId: entry.sequenceId,
        id: entry.id,
        expectedHash: recomputedHash,
        actualHash: entry.entryHash,
        reason: "HASH_MISMATCH",
      });
    }

    expectedPrevHash = entry.entryHash;
  }

  // 3. Verify Anchors
  for (const anchor of anchors) {
    const coveredEntries = entries.filter(
      (e) => e.sequenceId >= anchor.startSequenceId && e.sequenceId <= anchor.endSequenceId
    );

    if (coveredEntries.length === anchor.entriesCount) {
      const hashes = coveredEntries.map((e) => e.entryHash);
      const computedRoot = computeDigestForEntries(hashes);
      if (computedRoot !== anchor.merkleRoot) {
        failures.push({
          sequenceId: anchor.endSequenceId,
          id: anchor.id,
          expectedHash: anchor.merkleRoot,
          actualHash: computedRoot,
          reason: "ANCHOR_MISMATCH",
        });
      }
    }
  }

  return {
    valid: failures.length === 0,
    totalEntriesChecked: entries.length,
    anchorsChecked: anchors.length,
    failures,
    firstSequenceId: entries[0]?.sequenceId,
    lastSequenceId: entries[entries.length - 1]?.sequenceId,
    headHash: entries[entries.length - 1]?.entryHash,
  };
}

/**
 * Resets the in-memory log buffer (useful for isolated unit testing).
 */
export function resetMemoryAuditLogs(): void {
  memoryAudits.length = 0;
  memoryAnchors.length = 0;
}
