-- ============================================================================
-- Migration 0020: Automated On-Chain Reconciliation Worker (#313)
-- ============================================================================
-- 1. Creates public.reconciliation_queue to durably track and resolve pending
--    settlement payments across the 4 core states:
--    - 'not_submitted'
--    - 'submitted_not_confirmed'
--    - 'confirmed_not_recorded'
--    - 'recorded'
--    plus 'escalated' (for ambiguous payments requiring operator review)
--    and 'failed' (for terminal errors / expired intents).
-- 2. Enforces backoff scheduling, retry limits, and anti-ambiguity escalation.
-- 3. Enables RLS and performance indexes for polling and operator reporting.

CREATE TABLE IF NOT EXISTS public.reconciliation_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for polling due jobs fast
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

-- Trigger to maintain updated_at
DROP TRIGGER IF EXISTS trg_reconciliation_queue_updated_at ON public.reconciliation_queue;
CREATE TRIGGER trg_reconciliation_queue_updated_at
  BEFORE UPDATE ON public.reconciliation_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.reconciliation_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reconciliation_queue_select_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_select_parties ON public.reconciliation_queue
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS reconciliation_queue_insert_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_insert_parties ON public.reconciliation_queue
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS reconciliation_queue_update_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_update_parties ON public.reconciliation_queue
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

GRANT SELECT, INSERT, UPDATE ON public.reconciliation_queue TO authenticated;

-- Record migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0020', '0020_onchain_reconciliation_worker', 'onchain_reconciliation_worker_313_v1')
ON CONFLICT (version) DO NOTHING;
