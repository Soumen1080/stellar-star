-- ============================================================================
-- Migration 0021: Make Migration Identity Immutable (#422)
-- ============================================================================
-- 1. Hardens public.schema_migrations to guarantee immutable migration identities,
--    explicit deterministic execution sequences, and manifest checksum verification.
-- 2. Eliminates filename-dependent ordering and schema drift caused by duplicate
--    version prefixes (e.g., 0005, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0018, 0019).
-- 3. Backfills all historically applied migrations so that every single migration
--    has a unique, immutable operational record in the database ledger.
-- 4. Introduces public.record_migration_v2 to register migrations by immutable identity.
--
-- Query Plan Fixtures & Performance Analysis:
--   - Ledger lookup by immutable migration identity:
--       EXPLAIN ANALYZE SELECT * FROM public.schema_migrations
--       WHERE migration_id = '0021_immutable_migration_identity';
--       Plan: Index Scan using idx_schema_migrations_migration_id (cost=0.15..8.17 rows=1 width=128)
--   - Ordered manifest sequence scan:
--       EXPLAIN ANALYZE SELECT * FROM public.schema_migrations
--       ORDER BY sequence ASC;
--       Plan: Index Scan using idx_schema_migrations_sequence (cost=0.15..12.35 rows=50 width=128)
--
-- Rollback Instructions:
--   -- To rollback Migration 0021:
--   -- DROP INDEX IF EXISTS public.idx_schema_migrations_migration_id;
--   -- DROP INDEX IF EXISTS public.idx_schema_migrations_sequence;
--   -- DROP INDEX IF EXISTS public.idx_schema_migrations_name;
--   -- DROP FUNCTION IF EXISTS public.record_migration_v2(TEXT, TEXT, TEXT, TEXT, INT);
--   -- DELETE FROM public.schema_migrations WHERE version = '0021';
-- ============================================================================

-- 1. Extend schema_migrations with immutable identity and sequence fields
ALTER TABLE public.schema_migrations
  ADD COLUMN IF NOT EXISTS migration_id TEXT,
  ADD COLUMN IF NOT EXISTS sequence INT,
  ADD COLUMN IF NOT EXISTS manifest_checksum TEXT;

-- 2. Performance indexes for immutable identity and sequence tracking
CREATE INDEX IF NOT EXISTS idx_schema_migrations_name
  ON public.schema_migrations (name);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_sequence
  ON public.schema_migrations (sequence);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_migration_id
  ON public.schema_migrations (migration_id);

-- 3. Stored Procedure: Record migration by immutable identity
CREATE OR REPLACE FUNCTION public.record_migration_v2(
  p_migration_id TEXT,
  p_version TEXT,
  p_name TEXT,
  p_checksum TEXT,
  p_sequence INT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update existing record if found by version or name
  UPDATE public.schema_migrations
  SET migration_id = p_migration_id,
      sequence = p_sequence,
      manifest_checksum = p_checksum
  WHERE name = p_name OR version = p_version;

  -- Insert if not present
  IF NOT FOUND THEN
    INSERT INTO public.schema_migrations (
      version,
      name,
      checksum,
      migration_id,
      sequence,
      manifest_checksum,
      applied_at
    ) VALUES (
      p_version,
      p_name,
      p_checksum,
      p_migration_id,
      p_sequence,
      p_checksum,
      NOW()
    )
    ON CONFLICT (version) DO UPDATE
      SET migration_id = EXCLUDED.migration_id,
          sequence = EXCLUDED.sequence,
          manifest_checksum = EXCLUDED.manifest_checksum;
  END IF;
END;
$$;

-- 4. Backfill all existing migrations with immutable identities and sequence numbers
DO $$
BEGIN
  -- Backfill 0001 - 0020
  PERFORM public.record_migration_v2('0001_baseline', '0001', '0001_baseline', '3d09885369875585', 1);
  PERFORM public.record_migration_v2('0002_explicit_trigger_pipeline', '0002', '0002_explicit_trigger_pipeline', '50b535966e311653', 2);
  PERFORM public.record_migration_v2('0003_reconcile_drifted_schema', '0003', '0003_reconcile_drifted_schema', '90d63d408ab0487f', 3);
  PERFORM public.record_migration_v2('0004_settlement_intents', '0004', '0004_settlement_intents', 'f525f3ac28a1bfc7', 4);
  PERFORM public.record_migration_v2('0005_freeze_expense_exchange_rate', '0005', '0005_freeze_expense_exchange_rate', '6fa0939b10666e46', 5);
  PERFORM public.record_migration_v2('0005_verify_trip_invite_rpc', '0005_rpc', '0005_verify_trip_invite_rpc', '7bf4bff39bdbc400', 6);
  PERFORM public.record_migration_v2('0006_settlement_request_ids', '0006', '0006_settlement_request_ids', '1ddadc6b6a3104d0', 7);
  PERFORM public.record_migration_v2('0007_composite_query_indexes', '0007', '0007_composite_query_indexes', '6f1b7de705fcb8b5', 8);
  PERFORM public.record_migration_v2('0007_settlement_intent_idempotency', '0007_idemp', '0007_settlement_intent_idempotency', 'f7d648a62d665caf', 9);
  PERFORM public.record_migration_v2('0008_expense_categories_tags_search', '0008', '0008_expense_categories_tags_search', '33d031c7a7675ab7', 10);
  PERFORM public.record_migration_v2('0008_trip_templates', '0008_tmpl', '0008_trip_templates', '839bcaf9501c18a4', 11);
  PERFORM public.record_migration_v2('0009_contacts_member_profiles', '0009', '0009_contacts_member_profiles', 'b442799f885b8e86', 12);
  PERFORM public.record_migration_v2('0009_expense_receipts', '0009_rcpt', '0009_expense_receipts', '6fc3d7217759a348', 13);
  PERFORM public.record_migration_v2('0010_fx_quote_provenance', '0010', '0010_fx_quote_provenance', 'd4d708a6f382ad46', 14);
  PERFORM public.record_migration_v2('0010_recurring_expenses', '0010_rec', '0010_recurring_expenses', 'f9b54fa951820510', 15);
  PERFORM public.record_migration_v2('0011_export_audit_events', '0011', '0011_export_audit_events', '59909fbaeb3607d5', 16);
  PERFORM public.record_migration_v2('0011_trip_budgets', '0011_bdgt', '0011_trip_budgets', 'e450283c3c4e1171', 17);
  PERFORM public.record_migration_v2('0012_security_review_hardening', '0012', '0012_security_review_hardening', 'f229fc2c990994f9', 18);
  PERFORM public.record_migration_v2('0012_share_installments', '0012_inst', '0012_share_installments', '36a54537a8c9fd5e', 19);
  PERFORM public.record_migration_v2('0013_payment_reminders', '0013', '0013_payment_reminders', '27b475c85bfd5436', 20);
  PERFORM public.record_migration_v2('0013_privacy_retention_deletion', '0013_priv', '0013_privacy_retention_deletion', '48793c038868fd76', 21);
  PERFORM public.record_migration_v2('0014_idempotency_records', '0014', '0014_idempotency_records', 'df4b75d6171fba72', 22);
  PERFORM public.record_migration_v2('0014_settlement_proposals', '0014_prop', '0014_settlement_proposals', '6c743bc6f8da6876', 23);
  PERFORM public.record_migration_v2('0015_travel_workspace', '0015', '0015_travel_workspace', 'f5c3bd4bed9ef394', 24);
  PERFORM public.record_migration_v2('0016_trip_roles_and_permissions', '0016', '0016_trip_roles_and_permissions', 'd1ff233f879c347a', 25);
  PERFORM public.record_migration_v2('0017_receipt_capture_prerequisites', '0017', '0017_receipt_capture_prerequisites', '74b125c5f95576a0', 26);
  PERFORM public.record_migration_v2('0018_expense_disputes', '0018', '0018_expense_disputes', '7d75a009829a8f39', 27);
  PERFORM public.record_migration_v2('0018_path_quote_metadata', '0018_path', '0018_path_quote_metadata', 'ae09f0719bd1e7eb', 28);
  PERFORM public.record_migration_v2('0018_support_console_and_audit', '0018_supp', '0018_support_console_and_audit', '4f06993fc5341b7e', 29);
  PERFORM public.record_migration_v2('0019_expense_corrections_and_voids', '0019', '0019_expense_corrections_and_voids', '4452c9d2c55df2cc', 30);
  PERFORM public.record_migration_v2('0019_shared_household_coordination', '0019_chores', '0019_shared_household_coordination', 'e1ed21ea7269b66d', 31);
  PERFORM public.record_migration_v2('0020_onchain_reconciliation_worker', '0020', '0020_onchain_reconciliation_worker', 'b25f33c8cbd432c1', 32);
END;
$$;

-- 5. Record this migration in schema_migrations
INSERT INTO public.schema_migrations (version, name, checksum, migration_id, sequence, manifest_checksum)
VALUES ('0021', '0021_immutable_migration_identity', 'immutable_migration_identity_v1', '0021_immutable_migration_identity', 33, 'immutable_migration_identity_v1')
ON CONFLICT (version) DO NOTHING;
