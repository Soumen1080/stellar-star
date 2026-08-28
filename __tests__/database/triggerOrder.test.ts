/**
 * __tests__/database/triggerOrder.test.ts
 *
 * Verification suite for Issue #159 (Epic #53).
 * Asserts explicit trigger execution order (Invariant 4) and simulates
 * the multi-stage integrity trigger pipeline.
 */

import fs from "node:fs";
import path from "node:path";

describe("Database Trigger Pipeline & Execution Order (Issue #159 / Epic #53)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const baselineSqlPath = path.join(ROOT, "migrations", "0001_baseline.sql");
  const pipelineSqlPath = path.join(ROOT, "migrations", "0002_explicit_trigger_pipeline.sql");
  const setupSqlPath = path.join(ROOT, "supabase-setup.sql");

  // ===========================================================================
  // Test 1: DDL Trigger Naming Conventions & Alphabetical Sort Order
  // ===========================================================================

  it("Invariant 4: Migration DDL explicitly defines numbered trigger prefixes ensuring strict alphabetical firing order", () => {
    const pipelineSql = fs.readFileSync(pipelineSqlPath, "utf8");

    // Extract all CREATE TRIGGER statements on public.expenses
    const triggerMatches = [
      ...pipelineSql.matchAll(/CREATE\s+TRIGGER\s+([a-zA-Z0-9_]+)\s+BEFORE\s+(?:INSERT\s+OR\s+UPDATE|UPDATE)\s+ON\s+public\.expenses/gi),
    ].map((m) => m[1]);

    expect(triggerMatches.length).toBeGreaterThanOrEqual(4);

    // Postgres fires triggers of the same event/timing class in alphabetical order.
    // Ensure that array is strictly sorted alphabetically and adheres to trg_01 -> trg_02 -> trg_03 -> trg_04
    const sorted = [...triggerMatches].sort();
    expect(triggerMatches).toEqual(sorted);

    // Assert exact order:
    // 01: freeze_identity
    // 02: sync_member_wallets
    // 03: validate_shares
    // 04: set_updated_at
    expect(triggerMatches[0]).toMatch(/trg_01_expenses_freeze_identity/i);
    expect(triggerMatches[1]).toMatch(/trg_02_expenses_sync_member_wallets/i);
    expect(triggerMatches[2]).toMatch(/trg_03_expenses_validate_shares/i);
    expect(triggerMatches[3]).toMatch(/trg_04_expenses_set_updated_at/i);
  });

  // ===========================================================================
  // Test 2: supabase-setup.sql matches the explicit trigger pipeline
  // ===========================================================================

  it("Invariant 1 & 4: supabase-setup.sql matches the migration pipeline triggers", () => {
    const setupSql = fs.readFileSync(setupSqlPath, "utf8");

    expect(setupSql).toContain("CREATE TRIGGER trg_01_expenses_freeze_identity");
    expect(setupSql).toContain("CREATE TRIGGER trg_02_expenses_sync_member_wallets");
    expect(setupSql).toContain("CREATE TRIGGER trg_03_expenses_validate_shares");
    expect(setupSql).toContain("CREATE TRIGGER trg_04_expenses_set_updated_at");

    expect(setupSql).toContain("CREATE TRIGGER trg_01_trips_freeze_identity");
    expect(setupSql).toContain("CREATE TRIGGER trg_02_trips_sync_member_wallets");
    expect(setupSql).toContain("CREATE TRIGGER trg_03_trips_set_updated_at");
  });

  // ===========================================================================
  // Test 3: Simulation of Trigger Ordering Invariant
  // ===========================================================================

  it("Invariant 4: freeze_identity MUST execute before sync_member_wallets to prevent creator takeover in member_wallets", () => {
    const OLD_ROW = {
      id: "exp-original-uuid",
      title: "Dinner",
      created_by_wallet: "G_CREATOR_ALICE",
      member_wallets: ["G_CREATOR_ALICE", "G_MEMBER_BOB"],
      members: [{ walletAddress: "G_MEMBER_BOB" }],
      shares: [{ amount: "50" }, { amount: "50" }],
      total_amount: "100",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    // Malicious payload trying to rewrite creator and add an unauthorized wallet
    const MALICIOUS_NEW = {
      ...OLD_ROW,
      id: "exp-forged-uuid",
      created_by_wallet: "G_ATTACKER_EVE",
      created_at: "2026-02-01T00:00:00Z",
      members: [{ walletAddress: "G_MEMBER_CHARLIE" }],
    };

    // Stage 1: freeze_row_identity
    function freezeRowIdentity(oldRow: any, newRow: any) {
      const out = { ...newRow };
      out.id = oldRow.id;
      out.created_at = oldRow.created_at;
      out.created_by_wallet = oldRow.created_by_wallet;
      return out;
    }

    // Stage 2: sync_member_wallets
    function syncMemberWallets(row: any) {
      const out = { ...row };
      const extracted = new Set<string>();
      for (const m of row.members ?? []) {
        if (m.walletAddress) extracted.add(m.walletAddress);
      }
      if (row.created_by_wallet) {
        extracted.add(row.created_by_wallet);
      }
      out.member_wallets = Array.from(extracted);
      return out;
    }

    // Pipeline execution:
    const stage1 = freezeRowIdentity(OLD_ROW, MALICIOUS_NEW);
    expect(stage1.created_by_wallet).toBe("G_CREATOR_ALICE"); // Forgery neutralized
    expect(stage1.id).toBe("exp-original-uuid");

    const stage2 = syncMemberWallets(stage1);
    expect(stage2.member_wallets).toContain("G_CREATOR_ALICE"); // Alice retained access
    expect(stage2.member_wallets).not.toContain("G_ATTACKER_EVE"); // Attacker denied

    // If order was inverted (bug simulation):
    const invertedStage1 = syncMemberWallets(MALICIOUS_NEW);
    expect(invertedStage1.member_wallets).toContain("G_ATTACKER_EVE"); // BUG: Forged creator leaked into RLS array!
  });
});
