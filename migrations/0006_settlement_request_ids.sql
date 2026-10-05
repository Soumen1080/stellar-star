-- ============================================================================
-- 0006 — Correlation IDs for settlement intents
-- ============================================================================

ALTER TABLE public.settlement_intents
  ADD COLUMN IF NOT EXISTS request_id UUID;

-- Existing in-flight rows predate distributed tracing. Give each one a stable
-- recovery identifier before making the column mandatory.
UPDATE public.settlement_intents
SET request_id = gen_random_uuid()
WHERE request_id IS NULL;

ALTER TABLE public.settlement_intents
  ALTER COLUMN request_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN request_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS settlement_intents_request_id_idx
  ON public.settlement_intents (request_id);

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0006', '0006_settlement_request_ids', 'settlement_request_ids_v1')
ON CONFLICT (version) DO NOTHING;
