-- Migration: 0021_partition_high_volume_operational_data.sql
-- Description: Partition high-volume operational time-series data (audit logs, events, jobs)
-- by monthly ranges with partition-aware indexes and retention lifecycle procedures (#424).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Partition Management Functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_monthly_partition(
  p_table TEXT,
  p_year INT,
  p_month INT
) RETURNS TEXT AS $$
DECLARE
  v_next_year INT := p_year;
  v_next_month INT := p_month + 1;
  v_part_name TEXT;
  v_start_date TEXT;
  v_end_date TEXT;
  v_sql TEXT;
BEGIN
  IF v_next_month > 12 THEN
    v_next_month := 1;
    v_next_year := v_next_year + 1;
  END IF;

  v_part_name := format('%I_y%sm%s', p_table, p_year, lpad(p_month::text, 2, '0'));
  v_start_date := format('%s-%s-01 00:00:00+00', p_year, lpad(p_month::text, 2, '0'));
  v_end_date := format('%s-%s-01 00:00:00+00', v_next_year, lpad(v_next_month::text, 2, '0'));

  v_sql := format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',
    v_part_name, p_table, v_start_date, v_end_date
  );
  EXECUTE v_sql;

  RETURN v_part_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.archive_partition(
  p_parent_table TEXT,
  p_partition_name TEXT
) RETURNS VOID AS $$
BEGIN
  EXECUTE format('ALTER TABLE public.%I DETACH PARTITION public.%I', p_parent_table, p_partition_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.prune_old_partitions(
  p_parent_table TEXT,
  p_cutoff_date TIMESTAMPTZ
) RETURNS INT AS $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'public'
      AND p.relname = p_parent_table
      AND c.relname LIKE p_parent_table || '_y%'
  LOOP
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Operational Table 1: support_audit_logs
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'support_audit_logs'
      AND c.relkind <> 'p'
  ) THEN
    ALTER TABLE public.support_audit_logs RENAME TO support_audit_logs_pre_partition;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.support_audit_logs (
  id               UUID DEFAULT gen_random_uuid(),
  staff_identifier TEXT NOT NULL,
  query_type       TEXT NOT NULL,
  query_value      TEXT NOT NULL,
  results_count    INT  NOT NULL DEFAULT 0,
  ip_address       TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS public.support_audit_logs_default
  PARTITION OF public.support_audit_logs DEFAULT;

CREATE TABLE IF NOT EXISTS public.support_audit_logs_y2026m10
  PARTITION OF public.support_audit_logs
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.support_audit_logs_y2026m11
  PARTITION OF public.support_audit_logs
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.support_audit_logs_y2026m12
  PARTITION OF public.support_audit_logs
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.support_audit_logs_y2027m01
  PARTITION OF public.support_audit_logs
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'support_audit_logs_pre_partition'
  ) THEN
    INSERT INTO public.support_audit_logs (
      id, staff_identifier, query_type, query_value, results_count, ip_address, user_agent, created_at
    )
    SELECT id, staff_identifier, query_type, query_value, results_count, ip_address, user_agent, created_at
    FROM public.support_audit_logs_pre_partition
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_created_at
  ON public.support_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_staff
  ON public.support_audit_logs (staff_identifier, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Operational Table 2: export_audit_events
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'export_audit_events'
      AND c.relkind <> 'p'
  ) THEN
    ALTER TABLE public.export_audit_events RENAME TO export_audit_events_pre_partition;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.export_audit_events (
  id             UUID DEFAULT gen_random_uuid(),
  actor_wallet   TEXT        NOT NULL,
  export_kind    TEXT        NOT NULL CHECK (export_kind IN ('archive')),
  status         TEXT        NOT NULL CHECK (status IN ('served', 'rate_limited', 'forbidden', 'failed')),
  trip_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  trip_count     INT         NOT NULL DEFAULT 0 CHECK (trip_count >= 0),
  expense_count  INT         NOT NULL DEFAULT 0 CHECK (expense_count >= 0),
  byte_size      INT         NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  content_sha256 TEXT,
  request_id     TEXT,
  client_ip_hash TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS public.export_audit_events_default
  PARTITION OF public.export_audit_events DEFAULT;

CREATE TABLE IF NOT EXISTS public.export_audit_events_y2026m10
  PARTITION OF public.export_audit_events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.export_audit_events_y2026m11
  PARTITION OF public.export_audit_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.export_audit_events_y2026m12
  PARTITION OF public.export_audit_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.export_audit_events_y2027m01
  PARTITION OF public.export_audit_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'export_audit_events_pre_partition'
  ) THEN
    INSERT INTO public.export_audit_events (
      id, actor_wallet, export_kind, status, trip_ids, trip_count, expense_count, byte_size, content_sha256, request_id, client_ip_hash, created_at
    )
    SELECT id, actor_wallet, export_kind, status, trip_ids, trip_count, expense_count, byte_size, content_sha256, request_id, client_ip_hash, created_at
    FROM public.export_audit_events_pre_partition
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_export_audit_events_created_at
  ON public.export_audit_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_export_audit_events_actor
  ON public.export_audit_events (actor_wallet, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Operational Table 3: reminder_events
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'reminder_events'
      AND c.relkind <> 'p'
  ) THEN
    ALTER TABLE public.reminder_events RENAME TO reminder_events_pre_partition;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reminder_events (
  id          UUID DEFAULT gen_random_uuid(),
  reminder_id UUID REFERENCES public.payment_reminders(id) ON DELETE CASCADE,
  actor_wallet TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN (
    'sent', 'delivered', 'skipped', 'read', 'dismissed', 'cancelled',
    'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender',
    'opted_in', 'opted_out', 'unsubscribed', 'schedule_created', 'schedule_disabled'
  )),
  channel     TEXT CHECK (channel IS NULL OR channel IN ('in_app', 'email', 'push')),
  detail      TEXT CHECK (detail IS NULL OR char_length(detail) <= 200),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS public.reminder_events_default
  PARTITION OF public.reminder_events DEFAULT;

CREATE TABLE IF NOT EXISTS public.reminder_events_y2026m10
  PARTITION OF public.reminder_events
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reminder_events_y2026m11
  PARTITION OF public.reminder_events
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reminder_events_y2026m12
  PARTITION OF public.reminder_events
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reminder_events_y2027m01
  PARTITION OF public.reminder_events
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'reminder_events_pre_partition'
  ) THEN
    INSERT INTO public.reminder_events (
      id, reminder_id, actor_wallet, kind, channel, detail, created_at
    )
    SELECT id, reminder_id, actor_wallet, kind, channel, detail, created_at
    FROM public.reminder_events_pre_partition
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reminder_events_reminder_created_at
  ON public.reminder_events (reminder_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reminder_events_actor_created_at
  ON public.reminder_events (actor_wallet, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Operational Table 4: reconciliation_queue
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'reconciliation_queue'
      AND c.relkind <> 'p'
  ) THEN
    ALTER TABLE public.reconciliation_queue RENAME TO reconciliation_queue_pre_partition;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reconciliation_queue (
  id                  UUID DEFAULT gen_random_uuid(),
  intent_id           UUID REFERENCES public.settlement_intents(id) ON DELETE SET NULL,
  trip_id             TEXT NOT NULL,
  expense_id          TEXT NOT NULL,
  member_id           TEXT NOT NULL,
  payer_wallet        TEXT NOT NULL,
  member_wallet       TEXT NOT NULL,
  asset               TEXT NOT NULL DEFAULT 'XLM',
  amount              TEXT NOT NULL,
  amount_stroops      NUMERIC(30) NOT NULL,
  expected_memo       TEXT,
  request_id          TEXT,
  tx_hash             TEXT,
  ledger              BIGINT,
  status              TEXT NOT NULL DEFAULT 'not_submitted'
                      CHECK (status IN (
                        'not_submitted',
                        'submitted_not_confirmed',
                        'confirmed_not_recorded',
                        'recorded',
                        'escalated',
                        'failed'
                      )),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 10,
  backoff_ms          INT NOT NULL DEFAULT 5000,
  last_attempt_at     TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalation_reason   TEXT,
  error_message       TEXT,
  verified_at         TIMESTAMPTZ,
  recorded_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS public.reconciliation_queue_default
  PARTITION OF public.reconciliation_queue DEFAULT;

CREATE TABLE IF NOT EXISTS public.reconciliation_queue_y2026m10
  PARTITION OF public.reconciliation_queue
  FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reconciliation_queue_y2026m11
  PARTITION OF public.reconciliation_queue
  FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reconciliation_queue_y2026m12
  PARTITION OF public.reconciliation_queue
  FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

CREATE TABLE IF NOT EXISTS public.reconciliation_queue_y2027m01
  PARTITION OF public.reconciliation_queue
  FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'reconciliation_queue_pre_partition'
  ) THEN
    INSERT INTO public.reconciliation_queue (
      id, intent_id, trip_id, expense_id, member_id, payer_wallet, member_wallet,
      asset, amount, amount_stroops, expected_memo, request_id, tx_hash, ledger,
      status, attempts, max_attempts, backoff_ms, last_attempt_at, next_attempt_at,
      escalation_reason, error_message, verified_at, recorded_at, created_at, updated_at
    )
    SELECT
      id, intent_id, trip_id, expense_id, member_id, payer_wallet, member_wallet,
      asset, amount, amount_stroops, expected_memo, request_id, tx_hash, ledger,
      status, attempts, max_attempts, backoff_ms, last_attempt_at, next_attempt_at,
      escalation_reason, error_message, verified_at, recorded_at, created_at, updated_at
    FROM public.reconciliation_queue_pre_partition
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_status_next_attempt
  ON public.reconciliation_queue (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_tx_hash
  ON public.reconciliation_queue (tx_hash);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_intent_id
  ON public.reconciliation_queue (intent_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_trip_expense
  ON public.reconciliation_queue (trip_id, expense_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_parties
  ON public.reconciliation_queue (member_wallet, payer_wallet);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_created_at
  ON public.reconciliation_queue (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Register Migration
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0021', '0021_partition_high_volume_operational_data', 'partition_high_volume_operational_data_v1')
ON CONFLICT (version) DO NOTHING;
