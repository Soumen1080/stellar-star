-- ============================================================================
-- Stellar-star Migration 0005: Freeze expense debt-defining fields
-- ============================================================================
-- A member may edit shared expense metadata, but must never be able to change
-- the amount or conversion snapshot that determines another member's debt.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS exchange_rate TEXT,
  ADD COLUMN IF NOT EXISTS exchange_rate_timestamp TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.freeze_row_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  old_json JSONB;
  new_json JSONB;
BEGIN
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  new_json := new_json
    || jsonb_build_object('id', old_json -> 'id')
    || jsonb_build_object('created_at', old_json -> 'created_at')
    || jsonb_build_object('created_by_wallet', old_json -> 'created_by_wallet')
    || jsonb_build_object('total_amount', old_json -> 'total_amount')
    || jsonb_build_object('currency', old_json -> 'currency')
    || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
    || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp');

  RETURN jsonb_populate_record(NEW, new_json);
END;
$fn$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0005', '0005_freeze_expense_exchange_rate', 'freeze_expense_exchange_rate_v1')
ON CONFLICT (version) DO NOTHING;