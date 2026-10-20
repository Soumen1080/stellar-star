-- ============================================================================
-- Stellar-star Migration 0011: Trip budgets & spending alerts (issue #320)
-- ============================================================================
-- Budgets are display-only targets. They never touch amounts, shares or
-- settlement; every check below is about visibility and alert bookkeeping.

CREATE TABLE IF NOT EXISTS public.trip_budgets (
  trip_id           UUID PRIMARY KEY REFERENCES public.trips (id) ON DELETE CASCADE,
  currency          TEXT        NOT NULL DEFAULT 'XLM',
  total_amount      TEXT        CHECK (total_amount IS NULL OR total_amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  category_caps     JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(category_caps) = 'object'),
  thresholds        INT[]       NOT NULL DEFAULT ARRAY[50, 80, 100]
                      CHECK (cardinality(thresholds) <= 6 AND 0 < ALL (thresholds) AND 200 >= ALL (thresholds)),
  version           INT         NOT NULL DEFAULT 1,
  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_01_trip_budgets_set_updated_at ON public.trip_budgets;
CREATE TRIGGER trg_01_trip_budgets_set_updated_at
  BEFORE UPDATE ON public.trip_budgets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per threshold crossing. `cleared_at` is set when spend falls back
-- below the threshold, re-arming it; the partial unique index guarantees a
-- crossing fires exactly once even when several members' browsers evaluate it
-- at the same moment.
CREATE TABLE IF NOT EXISTS public.budget_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID        NOT NULL REFERENCES public.trips (id) ON DELETE CASCADE,
  scope             TEXT        NOT NULL,
  threshold         INT         NOT NULL CHECK (threshold > 0),
  spent_at_crossing TEXT        NOT NULL,
  fired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_alerts_one_active_crossing
  ON public.budget_alerts (trip_id, scope, threshold)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_budget_alerts_trip_fired_at
  ON public.budget_alerts (trip_id, fired_at DESC);

-- Per-member mute. A member can only mute (or unmute) themselves.
CREATE TABLE IF NOT EXISTS public.budget_alert_mutes (
  trip_id       UUID        NOT NULL REFERENCES public.trips (id) ON DELETE CASCADE,
  member_wallet TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trip_id, member_wallet)
);

ALTER TABLE public.trip_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_alert_mutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_budgets_members ON public.trip_budgets;
CREATE POLICY trip_budgets_members ON public.trip_budgets
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = trip_budgets.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = trip_budgets.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

DROP POLICY IF EXISTS budget_alerts_members ON public.budget_alerts;
CREATE POLICY budget_alerts_members ON public.budget_alerts
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alerts.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alerts.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

DROP POLICY IF EXISTS budget_alert_mutes_self ON public.budget_alert_mutes;
CREATE POLICY budget_alert_mutes_self ON public.budget_alert_mutes
  FOR ALL TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallet = public.current_wallet())
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND member_wallet = public.current_wallet()
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alert_mutes.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_budgets TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.budget_alerts TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.budget_alert_mutes TO authenticated;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0011', '0011_trip_budgets', 'trip_budgets_v1')
ON CONFLICT (version) DO NOTHING;
