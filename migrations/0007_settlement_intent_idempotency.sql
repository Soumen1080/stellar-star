-- ============================================================================
-- 0007 — Enforce uniqueness for settlement intents by payment transaction
-- ============================================================================
-- Prevents duplicate settlement intent rows when a payment is re-synced after
-- a network retry or webhook event reprocessing.
-- Composite uniqueness on (tx_hash, expense_id, member_id, currency) ensures
-- that identical payments cannot appear multiple times in the settlement ledger.

CREATE UNIQUE INDEX IF NOT EXISTS settlement_intents_tx_expense_member_asset_idx
  ON public.settlement_intents (tx_hash, expense_id, member_id, currency)
  WHERE tx_hash IS NOT NULL;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0007', '0007_settlement_intent_idempotency', 'settlement_intent_idempotency_v1')
ON CONFLICT (version) DO NOTHING;
