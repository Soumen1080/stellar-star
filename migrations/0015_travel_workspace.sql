-- ============================================================================
-- Stellar-star Migration 0015: Travel workspace (#342)
-- ============================================================================
-- Expands a trip from a financial ledger into a lightweight shared travel
-- workspace containing dated itinerary items, collaborative checklists (packing,
-- to-dos), optional reminders, and permission-controlled booking references.
--
-- Zero on-chain leakage: all workspace details remain strictly off-chain in Postgres
-- and local storage. No booking confirmation codes, attachments, or private links
-- ever enter transaction memos, Horizon payloads, or Soroban contract storage.

DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'workspace'
  ) THEN
    ALTER TABLE public.trips ADD COLUMN workspace JSONB NOT NULL DEFAULT '{"itinerary":[],"checklists":[],"bookings":[]}'::jsonb;
  END IF;
END $migrate$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0015', '0015_travel_workspace', 'travel_workspace_v1')
ON CONFLICT (version) DO NOTHING;
