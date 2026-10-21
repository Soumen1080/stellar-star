ALTER TABLE public.settlement_intents
  ADD COLUMN IF NOT EXISTS quote_metadata JSONB;
