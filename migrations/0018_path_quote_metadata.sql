ALTER TABLE public.settlement_intents
  ADD COLUMN IF NOT EXISTS quote_metadata JSONB;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0018', '0018_path_quote_metadata', 'path_quote_metadata_v1')
ON CONFLICT (version) DO NOTHING;
