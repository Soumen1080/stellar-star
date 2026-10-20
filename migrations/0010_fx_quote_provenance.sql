-- ============================================================================
-- Stellar-star Migration 0010: Multi-currency entry & FX provenance (#323)
-- ============================================================================
-- Records the full provenance of a converted expense so it can be shown in the
-- expense history, and makes every part of it immutable once saved:
--
--   entered_amount        what the user typed, in `currency` (exact decimal)
--   currency              the entered display currency (existing)
--   exchange_rate         the locked quote's rate (existing)
--   exchange_rate_source  which provider produced the quote
--   exchange_rate_timestamp  when the quote was fetched (existing)
--   total_amount          converted amount in the settlement asset (existing)
--   settlement_asset      Stellar asset the expense settles in ('native' = XLM)
--
-- Rows written before this migration have NULL entered_amount/source and are
-- treated as native-settled, which is what every historical expense was.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS entered_amount       TEXT,
  ADD COLUMN IF NOT EXISTS exchange_rate_source TEXT,
  ADD COLUMN IF NOT EXISTS settlement_asset     TEXT NOT NULL DEFAULT 'native';

-- Same identity freeze as 0005, extended to the new provenance columns: a
-- member may edit an expense's title or split, never the quote behind it.
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
    || jsonb_build_object('created_by_wallet', old_json -> 'created_by_wallet');

  -- The original fiat/XLM snapshot is part of the debt. Freeze it even when
  -- exchange_rate is NULL (for native XLM expenses), and freeze the source and
  -- timestamp together with the rate so the provenance cannot be rewritten.
  new_json := new_json
    || jsonb_build_object('total_amount', old_json -> 'total_amount')
    || jsonb_build_object('currency', old_json -> 'currency')
    || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
    || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp')
    || jsonb_build_object('exchange_rate_source', old_json -> 'exchange_rate_source')
    || jsonb_build_object('entered_amount', old_json -> 'entered_amount')
    || jsonb_build_object('settlement_asset', old_json -> 'settlement_asset');

  RETURN jsonb_populate_record(NEW, new_json);
END;
$fn$;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0010', '0010_fx_quote_provenance', 'fx_quote_provenance_v1')
ON CONFLICT (version) DO NOTHING;
