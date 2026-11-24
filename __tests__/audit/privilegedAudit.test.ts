import {
  appendPrivilegedAudit,
  computeEntryHash,
  computeDigestForEntries,
  createAuditIntegrityAnchor,
  verifyAuditChainIntegrity,
  resetMemoryAuditLogs,
  GENESIS_HASH,
} from "@/lib/audit/privilegedAudit";
import type { PrivilegedAuditEntry } from "@/types/audit";

describe("Tamper-Evident Privileged Audits (#455)", () => {
  beforeEach(() => {
    resetMemoryAuditLogs();
  });

  describe("Hash Chaining and Ledger Creation", () => {
    it("creates the first entry pointing to GENESIS_HASH", async () => {
      const entry = await appendPrivilegedAudit({
        actorWallet: "GBADMIN1234567890ABCDEF",
        actorRole: "admin",
        action: "object.rotate_key",
        decision: "execute",
        targetType: "storage_object",
        targetId: "receipts/rec-123.jpg",
        requestId: "req-001",
      });

      expect(entry.sequenceId).toBe(1);
      expect(entry.prevEntryHash).toBe(GENESIS_HASH);
      expect(entry.entryHash).toBeDefined();
      expect(entry.entryHash).toHaveLength(64);
    });

    it("chains consecutive audit entries sequentially", async () => {
      const entry1 = await appendPrivilegedAudit({
        actorWallet: "GBADMIN1234567890ABCDEF",
        actorRole: "admin",
        action: "object.rotate_key",
        decision: "execute",
        targetType: "storage_object",
        targetId: "receipts/rec-1.jpg",
      });

      const entry2 = await appendPrivilegedAudit({
        actorWallet: "GBSUPPORT1234567890ABCDEF",
        actorRole: "support",
        action: "support.lookup",
        decision: "allow",
        targetType: "support_lookup",
        targetId: "GBCUSTOMER1234567890ABCDEF",
      });

      const entry3 = await appendPrivilegedAudit({
        actorWallet: "GBOWNER1234567890ABCDEF",
        actorRole: "owner",
        action: "trip.member.role_change",
        decision: "allow",
        targetType: "role",
        targetId: "trip-123:user-456",
      });

      expect(entry2.sequenceId).toBe(2);
      expect(entry2.prevEntryHash).toBe(entry1.entryHash);

      expect(entry3.sequenceId).toBe(3);
      expect(entry3.prevEntryHash).toBe(entry2.entryHash);
    });
  });

  describe("Integrity Verification and Tamper Detection", () => {
    it("verifies an untampered audit chain as completely valid", async () => {
      await appendPrivilegedAudit({
        actorWallet: "GBACTOR1",
        action: "export.archive",
        decision: "allow",
        targetType: "export",
        targetId: "archive:GBACTOR1",
      });

      await appendPrivilegedAudit({
        actorWallet: "GBACTOR2",
        action: "support.action.execute.mark_intent_failed",
        decision: "execute",
        targetType: "intent",
        targetId: "intent-999",
      });

      const report = await verifyAuditChainIntegrity();
      expect(report.valid).toBe(true);
      expect(report.totalEntriesChecked).toBe(2);
      expect(report.failures).toHaveLength(0);
    });

    it("detects tampered payload content (HASH_MISMATCH)", async () => {
      await appendPrivilegedAudit({
        actorWallet: "GBACTOR1",
        action: "object.crypto_erase_key",
        decision: "execute",
        targetType: "key",
        targetId: "key-master-1",
      });

      const entry2 = await appendPrivilegedAudit({
        actorWallet: "GBACTOR2",
        action: "trip.member.role_change",
        decision: "allow",
        targetType: "role",
        targetId: "trip-1:member-1",
      });

      // Tamper with entry2 in the global in-memory ledger
      (entry2 as any).actorWallet = "MALICIOUS_ATTACKER_WALLET";

      const report = await verifyAuditChainIntegrity();
      expect(report.valid).toBe(false);
      expect(report.failures.some((f) => f.reason === "HASH_MISMATCH")).toBe(true);
    });

    it("detects deleted or reordered records (CHAIN_BROKEN)", async () => {
      const entry1 = await appendPrivilegedAudit({
        actorWallet: "GBACTOR1",
        action: "action-1",
        decision: "allow",
        targetType: "system",
        targetId: "sys-1",
      });

      await appendPrivilegedAudit({
        actorWallet: "GBACTOR2",
        action: "action-2",
        decision: "allow",
        targetType: "system",
        targetId: "sys-2",
      });

      await appendPrivilegedAudit({
        actorWallet: "GBACTOR3",
        action: "action-3",
        decision: "allow",
        targetType: "system",
        targetId: "sys-3",
      });

      // Simulate deletion of the second entry
      const list = (globalThis as any).stellarStarPrivilegedAudits as PrivilegedAuditEntry[];
      list.splice(1, 1);

      const report = await verifyAuditChainIntegrity();
      expect(report.valid).toBe(false);
      expect(report.failures.some((f) => f.reason === "CHAIN_BROKEN")).toBe(true);
    });
  });

  describe("Periodic Integrity Anchors", () => {
    it("anchors chain digests and verifies root integrity", async () => {
      for (let i = 1; i <= 5; i++) {
        await appendPrivilegedAudit({
          actorWallet: `GBACTOR${i}`,
          action: `action.${i}`,
          decision: "allow",
          targetType: "config",
          targetId: `cfg-${i}`,
        });
      }

      const anchor = await createAuditIntegrityAnchor({ anchoredBy: "cron:daily-anchor" });
      expect(anchor).not.toBeNull();
      expect(anchor?.entriesCount).toBe(5);
      expect(anchor?.merkleRoot).toBeDefined();

      const report = await verifyAuditChainIntegrity();
      expect(report.valid).toBe(true);
      expect(report.anchorsChecked).toBe(1);
    });

    it("detects anchor mismatch if history was rewritten after anchoring", async () => {
      for (let i = 1; i <= 3; i++) {
        await appendPrivilegedAudit({
          actorWallet: `GBACTOR${i}`,
          action: `action.${i}`,
          decision: "allow",
          targetType: "config",
          targetId: `cfg-${i}`,
        });
      }

      await createAuditIntegrityAnchor();

      // Tamper with an anchor
      const anchors = (globalThis as any).stellarStarAuditAnchors;
      anchors[0].merkleRoot = "tampered_fake_merkle_root_hex_string_1234567890abcdef";

      const report = await verifyAuditChainIntegrity();
      expect(report.valid).toBe(false);
      expect(report.failures.some((f) => f.reason === "ANCHOR_MISMATCH")).toBe(true);
    });
  });
});
