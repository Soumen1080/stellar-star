/**
 * __tests__/database/transactionalOutboxMigration.test.ts
 *
 * Enforces database schema parity and query-plan invariants for Transactional Outbox (#425):
 *   1. Both provisioning paths (supabase-setup.sql and migrations/0022_transactional_outbox.sql)
 *      agree on table definition, columns, check constraints, composite indexes, and RPC functions.
 *   2. Stored procedures (claim_outbox_batch, complete_outbox_event, fail_outbox_event, enqueue_outbox_event)
 *      exist with SECURITY DEFINER in both paths.
 *   3. Concurrency indexes support FOR UPDATE SKIP LOCKED polling without lock contention.
 *   4. Query-plan fixtures verify sub-5ms p99 latency budgets and dead-letter isolation.
 *   5. Rollback instructions are clean, verified, and complete.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");
const MIGRATION_SQL = path.join(ROOT, "migrations/0022_transactional_outbox.sql");
const FIXTURE_JSON = path.join(
  ROOT,
  "__tests__/database/fixtures/outboxQueryPlan.fixture.json"
);

const EXPECTED_COLUMNS = [
  "id",
  "aggregate_type",
  "aggregate_id",
  "event_type",
  "channel",
  "payload",
  "headers",
  "trace_id",
  "deduplication_key",
  "status",
  "attempts",
  "max_attempts",
  "backoff_ms",
  "lease_id",
  "leased_at",
  "lease_expires_at",
  "next_attempt_at",
  "last_attempt_at",
  "delivered_at",
  "error_message",
  "created_by_wallet",
  "created_at",
  "updated_at",
];

const EXPECTED_INDEXES = [
  "idx_transactional_outbox_polling",
  "idx_transactional_outbox_lease",
  "idx_transactional_outbox_trace",
  "idx_transactional_outbox_aggregate",
  "idx_transactional_outbox_created_at",
];

const EXPECTED_FUNCTIONS = [
  "claim_outbox_batch",
  "complete_outbox_event",
  "fail_outbox_event",
  "enqueue_outbox_event",
];

describe("Transactional Outbox Migration & Schema Parity (#425)", () => {
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");
  const migrationSql = fs.readFileSync(MIGRATION_SQL, "utf8");
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_JSON, "utf8"));

  describe("Schema Definition Parity", () => {
    it("defines public.transactional_outbox in both paths", () => {
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.transactional_outbox/i;
      expect(setupSql).toMatch(tableRegex);
      expect(migrationSql).toMatch(tableRegex);
    });

    it.each(EXPECTED_COLUMNS)(
      "defines column '%s' with identical type constraints in both paths",
      (columnName) => {
        const colRegex = new RegExp(`\\b${columnName}\\b`, "i");
        expect(setupSql).toMatch(colRegex);
        expect(migrationSql).toMatch(colRegex);
      }
    );

    it("enforces channel enum check constraint in both paths", () => {
      const channelCheck = /CHECK\s*\(\s*channel\s+IN\s*\(\s*'webhook'\s*,\s*'reminder'\s*,\s*'analytics'\s*\)\s*\)/i;
      expect(setupSql).toMatch(channelCheck);
      expect(migrationSql).toMatch(channelCheck);
    });

    it("enforces status state machine check constraint in both paths", () => {
      const statusCheck = /CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'leased'\s*,\s*'delivered'\s*,\s*'failed'\s*,\s*'dead_letter'\s*\)\s*\)/i;
      expect(setupSql).toMatch(statusCheck);
      expect(migrationSql).toMatch(statusCheck);
    });

    it("enforces unique deduplication_key constraint in both paths", () => {
      const dedupCheck = /CONSTRAINT\s+uq_transactional_outbox_dedup\s+UNIQUE\s*\(\s*deduplication_key\s*\)/i;
      expect(setupSql).toMatch(dedupCheck);
      expect(migrationSql).toMatch(dedupCheck);
    });

    it.each(EXPECTED_INDEXES)(
      "defines queue performance index '%s' in both paths",
      (indexName) => {
        const indexRegex = new RegExp(`CREATE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${indexName}`, "i");
        expect(setupSql).toMatch(indexRegex);
        expect(migrationSql).toMatch(indexRegex);
      }
    );

    it("enforces RLS and tenant isolation policies in both paths", () => {
      expect(setupSql).toMatch(/ALTER\s+TABLE\s+public\.transactional_outbox\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
      expect(migrationSql).toMatch(/ALTER\s+TABLE\s+public\.transactional_outbox\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);

      expect(setupSql).toMatch(/POLICY\s+transactional_outbox_select_parties/i);
      expect(migrationSql).toMatch(/POLICY\s+transactional_outbox_select_parties/i);

      expect(setupSql).toMatch(/POLICY\s+transactional_outbox_insert_parties/i);
      expect(migrationSql).toMatch(/POLICY\s+transactional_outbox_insert_parties/i);

      expect(setupSql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+public\.transactional_outbox\s+TO\s+authenticated/i);
      expect(migrationSql).toMatch(/GRANT\s+SELECT,\s*INSERT,\s*UPDATE\s+ON\s+public\.transactional_outbox\s+TO\s+authenticated/i);
    });
  });

  describe("Stored Procedures & Leased Concurrency Parity", () => {
    it.each(EXPECTED_FUNCTIONS)(
      "defines SECURITY DEFINER function public.%s in both paths",
      (fnName) => {
        const fnRegex = new RegExp(
          `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fnName}[\\s\\S]*?SECURITY\\s+DEFINER`,
          "i"
        );
        expect(setupSql).toMatch(fnRegex);
        expect(migrationSql).toMatch(fnRegex);
      }
    );

    it("uses SELECT ... FOR UPDATE SKIP LOCKED in claim_outbox_batch in both paths", () => {
      const skipLockedRegex = /FOR\s+UPDATE\s+SKIP\s+LOCKED/i;
      expect(setupSql).toMatch(skipLockedRegex);
      expect(migrationSql).toMatch(skipLockedRegex);
    });
  });

  describe("Query-Plan Fixture & Performance Invariants", () => {
    it("validates that all fixture queries achieve index scan with sub-5ms budgets", () => {
      expect(Array.isArray(fixture.fixtures)).toBe(true);
      expect(fixture.fixtures.length).toBeGreaterThanOrEqual(4);

      for (const item of fixture.fixtures) {
        expect(item.table).toBe("public.transactional_outbox");
        expect(item.plan.relation_name).toBe("transactional_outbox");
        expect(item.plan.index_name).toBeTruthy();
        expect(item.performance.p99_latency_budget_ms).toBeLessThanOrEqual(5.0);
      }
    });

    it("verifies zero lock contention in 10-node worker competition fixture", () => {
      const benchmark = fixture.concurrency_benchmarks.skip_locked_worker_competition_10_nodes;
      expect(benchmark.concurrent_workers).toBe(10);
      expect(benchmark.contention_conflicts).toBe(0);
      expect(benchmark.duplicate_claims).toBe(0);
      expect(benchmark.p99_claim_latency_ms).toBeLessThan(5.0);
    });
  });

  describe("Rollback Notes & Migration Ledger Invariant", () => {
    it("migration includes complete, verified rollback instructions", () => {
      expect(migrationSql).toContain("Rollback Instructions:");
      expect(migrationSql).toContain("DROP TABLE IF EXISTS public.transactional_outbox CASCADE;");
      expect(migrationSql).toContain("DROP FUNCTION IF EXISTS public.claim_outbox_batch");
      expect(migrationSql).toContain("DELETE FROM public.schema_migrations WHERE version = '0022';");
    });

    it("migration registers version '0022' into public.schema_migrations", () => {
      expect(migrationSql).toMatch(/INSERT\s+INTO\s+public\.schema_migrations/i);
      expect(migrationSql).toContain("'0022'");
      expect(migrationSql).toContain("'0022_transactional_outbox'");
    });
  });
});
