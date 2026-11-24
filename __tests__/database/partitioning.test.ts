/**
 * __tests__/database/partitioning.test.ts
 *
 * Enforces partitioning invariants for high-volume operational data (#424):
 *   1. Time-series operational tables are partitioned by monthly range on created_at.
 *   2. Both provisioning paths (supabase-setup.sql and migrations/0021_partition_high_volume_operational_data.sql)
 *      agree on all partitioned tables, child partitions, indexes, and RPC functions.
 *   3. Partition lifecycle management RPCs (create_monthly_partition, archive_partition, prune_old_partitions)
 *      exist in both paths.
 *   4. Query-plan fixtures verify static partition pruning, I/O scan reductions, and sub-10ms drop-partition cleanup.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");
const MIGRATION_SQL = path.join(
  ROOT,
  "migrations/0021_partition_high_volume_operational_data.sql"
);
const FIXTURE_JSON = path.join(
  ROOT,
  "__tests__/database/fixtures/partitionQueryPlan.fixture.json"
);

const PARTITIONED_TABLES = [
  "support_audit_logs",
  "export_audit_events",
  "reminder_events",
  "reconciliation_queue",
];

const REQUIRED_PARTITION_SUFFIXES = [
  "_default",
  "_y2026m10",
  "_y2026m11",
  "_y2026m12",
  "_y2027m01",
];

describe("High-volume operational data partitioning (#424)", () => {
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");
  const migrationSql = fs.readFileSync(MIGRATION_SQL, "utf8");
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_JSON, "utf8"));

  describe("Declarative Range Partitioning Schema Parity", () => {
    it.each(PARTITIONED_TABLES)(
      "declares %s with PARTITION BY RANGE (created_at) and composite primary key in both paths",
      (tableName) => {
        const partitionByRegex = new RegExp(
          `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?public\\.${tableName}[\\s\\S]*?PARTITION\\s+BY\\s+RANGE\\s*\\(created_at\\)`,
          "i"
        );
        const pkRegex = new RegExp(
          `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?public\\.${tableName}[\\s\\S]*?PRIMARY\\s+KEY\\s*\\(id,\\s*created_at\\)`,
          "i"
        );

        expect(setupSql).toMatch(partitionByRegex);
        expect(migrationSql).toMatch(partitionByRegex);

        expect(setupSql).toMatch(pkRegex);
        expect(migrationSql).toMatch(pkRegex);
      }
    );

    it.each(PARTITIONED_TABLES)(
      "provisions default and monthly range partitions for %s in both paths",
      (tableName) => {
        for (const suffix of REQUIRED_PARTITION_SUFFIXES) {
          const partitionName = `${tableName}${suffix}`;
          const partitionRegex = new RegExp(
            `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+public\\.${partitionName}\\s+PARTITION\\s+OF\\s+public\\.${tableName}`,
            "i"
          );

          expect(setupSql).toMatch(partitionRegex);
          expect(migrationSql).toMatch(partitionRegex);
        }
      }
    );
  });

  describe("Partition-Aware Indexing", () => {
    it("defines partition-local query indexes on support_audit_logs in both paths", () => {
      expect(setupSql).toMatch(/idx_support_audit_logs_created_at/i);
      expect(setupSql).toMatch(/idx_support_audit_logs_staff/i);

      expect(migrationSql).toMatch(/idx_support_audit_logs_created_at/i);
      expect(migrationSql).toMatch(/idx_support_audit_logs_staff/i);
    });

    it("defines partition-local query indexes on export_audit_events in both paths", () => {
      expect(setupSql).toMatch(/idx_export_audit_events_created_at/i);
      expect(setupSql).toMatch(/idx_export_audit_events_actor/i);

      expect(migrationSql).toMatch(/idx_export_audit_events_created_at/i);
      expect(migrationSql).toMatch(/idx_export_audit_events_actor/i);
    });

    it("defines partition-local query indexes on reminder_events in both paths", () => {
      expect(setupSql).toMatch(/idx_reminder_events_reminder_created_at/i);
      expect(setupSql).toMatch(/idx_reminder_events_actor_created_at/i);

      expect(migrationSql).toMatch(/idx_reminder_events_reminder_created_at/i);
      expect(migrationSql).toMatch(/idx_reminder_events_actor_created_at/i);
    });

    it("defines partition-local query indexes on reconciliation_queue in both paths", () => {
      expect(setupSql).toMatch(/idx_reconciliation_queue_status_next_attempt/i);
      expect(setupSql).toMatch(/idx_reconciliation_queue_created_at/i);

      expect(migrationSql).toMatch(/idx_reconciliation_queue_status_next_attempt/i);
      expect(migrationSql).toMatch(/idx_reconciliation_queue_created_at/i);
    });
  });

  describe("Partition Lifecycle Management Functions", () => {
    const lifecycleFunctions = [
      "create_monthly_partition",
      "archive_partition",
      "prune_old_partitions",
    ];

    it.each(lifecycleFunctions)(
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
  });

  describe("Query-Plan Fixtures & Pruning Invariants", () => {
    it("validates that all fixture queries achieve static partition elimination", () => {
      expect(Array.isArray(fixture.fixtures)).toBe(true);
      expect(fixture.fixtures.length).toBe(PARTITIONED_TABLES.length);

      for (const item of fixture.fixtures) {
        expect(item.plan.partitions_total).toBe(5);
        expect(item.plan.partitions_scanned).toBe(1);
        expect(item.plan.partitions_pruned).toBe(4);
        expect(item.plan.pruning_method).toBe("static_range_elimination");
        expect(item.performance.io_reduction_percent).toBeGreaterThan(90);
        expect(item.performance.p99_latency_budget_ms).toBeLessThanOrEqual(30);
      }
    });

    it("demonstrates sub-10ms metadata cleanup vs multi-second monolithic table delete", () => {
      const { monolithic_table_delete_100k_rows, partitioned_detach_drop_100k_rows } =
        fixture.cleanup_benchmarks;

      expect(partitioned_detach_drop_100k_rows.duration_ms).toBeLessThan(10);
      expect(partitioned_detach_drop_100k_rows.vacuum_required).toBe(false);
      expect(monolithic_table_delete_100k_rows.duration_ms).toBeGreaterThan(1000);
      expect(monolithic_table_delete_100k_rows.vacuum_required).toBe(true);
    });
  });

  describe("Non-Destructive Live Migration Invariant", () => {
    it("migration preserves existing data via staging and contains no DROP TABLE outside rollback", () => {
      for (const table of PARTITIONED_TABLES) {
        expect(migrationSql).toContain(`RENAME TO ${table}_pre_partition`);
        expect(migrationSql).toContain(`INSERT INTO public.${table}`);
        expect(migrationSql).toContain(`FROM public.${table}_pre_partition`);
      }

      // Assert no raw DROP TABLE statements on live operational data
      const clean = migrationSql
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(/\r?\n/)
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");

      expect(/DROP\s+TABLE(?!\s+IF\s+EXISTS\s+public\.schema_migrations)/i.test(clean)).toBe(
        false
      );
    });
  });
});
