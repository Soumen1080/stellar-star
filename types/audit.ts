/**
 * types/audit.ts
 *
 * Issue #455: Types and interfaces for Tamper-Evident Privileged Audits.
 */

export type AuditDecision = "allow" | "deny" | "propose" | "approve" | "execute";

export type AuditActorRole = "admin" | "support" | "owner" | "organizer" | "system" | "user";

export type AuditTargetType =
  | "user"
  | "role"
  | "export"
  | "storage_object"
  | "support_action"
  | "support_lookup"
  | "config"
  | "system";

export interface PrivilegedAuditEntryInput {
  actorWallet: string;
  actorRole?: AuditActorRole | string;
  action: string;
  decision: AuditDecision;
  targetType: AuditTargetType | string;
  targetId: string;
  requestId?: string | null;
  causationId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PrivilegedAuditEntry extends PrivilegedAuditEntryInput {
  id: string;
  sequenceId: number;
  prevEntryHash: string;
  entryHash: string;
  createdAt: string;
}

export interface AuditIntegrityAnchor {
  id: string;
  startSequenceId: number;
  endSequenceId: number;
  entriesCount: number;
  merkleRoot: string;
  anchorHash: string;
  anchoredBy: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditVerificationFailure {
  sequenceId: number;
  id: string;
  expectedHash: string;
  actualHash: string;
  reason: "HASH_MISMATCH" | "CHAIN_BROKEN" | "ANCHOR_MISMATCH";
}

export interface AuditVerificationReport {
  valid: boolean;
  totalEntriesChecked: number;
  anchorsChecked: number;
  failures: AuditVerificationFailure[];
  firstSequenceId?: number;
  lastSequenceId?: number;
  headHash?: string;
}
