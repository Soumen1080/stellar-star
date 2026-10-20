-- ============================================================================
-- Stellar-star Migration 0013: Reminders and payment requests (issue #326)
-- ============================================================================
-- A payer can politely ask a member for a due share. Every reminder is shown
-- in-app; email/push go out only when the recipient opted in, and are rate
-- limited in lib/reminders/policy.ts.
--
--   payment_reminders     one row per request. Its UUID is the deep link
--                         (/requests/<id>): it identifies recipient and share
--                         but carries no trip details, and RLS shows the row
--                         only to its sender and recipient.
--   reminder_events       append-only history: sent, delivered per channel,
--                         read, dismissed, cancelled, mute/unsubscribe choices.
--   reminder_preferences  per-wallet opt-ins and mutes. Private to the wallet.
--   reminder_schedules    user-created schedules. The only way a reminder is
--                         ever sent without a click: nothing is sent unless a
--                         member configured one.

CREATE TABLE IF NOT EXISTS public.payment_reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           TEXT        NOT NULL,
  expense_id        TEXT        NOT NULL,
  member_id         TEXT        NOT NULL,
  recipient_wallet  TEXT        NOT NULL,
  sender_wallet     TEXT        NOT NULL,
  amount            TEXT        NOT NULL CHECK (amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  asset             TEXT        NOT NULL DEFAULT 'native',
  note              TEXT        CHECK (note IS NULL OR char_length(note) <= 280),
  trigger           TEXT        NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule')),
  schedule_id       UUID,
  state             TEXT        NOT NULL DEFAULT 'delivered'
                      CHECK (state IN ('delivered', 'read', 'dismissed', 'cancelled', 'muted')),
  channels          TEXT[]      NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at           TIMESTAMPTZ,
  CONSTRAINT payment_reminders_not_self CHECK (sender_wallet <> recipient_wallet)
);

CREATE INDEX IF NOT EXISTS idx_payment_reminders_recipient_created_at
  ON public.payment_reminders (recipient_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_sender_created_at
  ON public.payment_reminders (sender_wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reminder_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id  UUID REFERENCES public.payment_reminders (id) ON DELETE CASCADE,
  actor_wallet TEXT        NOT NULL,
  kind         TEXT        NOT NULL CHECK (kind IN (
                 'sent', 'delivered', 'skipped', 'read', 'dismissed', 'cancelled',
                 'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender',
                 'opted_in', 'opted_out', 'unsubscribed', 'schedule_created', 'schedule_disabled'
               )),
  channel      TEXT        CHECK (channel IS NULL OR channel IN ('in_app', 'email', 'push')),
  detail       TEXT        CHECK (detail IS NULL OR char_length(detail) <= 200),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reminder_events_reminder_created_at
  ON public.reminder_events (reminder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reminder_events_actor_created_at
  ON public.reminder_events (actor_wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reminder_preferences (
  wallet               TEXT PRIMARY KEY,
  email_opt_in         BOOLEAN     NOT NULL DEFAULT FALSE,
  email_address        TEXT        CHECK (email_address IS NULL OR char_length(email_address) <= 254),
  push_opt_in          BOOLEAN     NOT NULL DEFAULT FALSE,
  push_endpoint        TEXT        CHECK (push_endpoint IS NULL OR char_length(push_endpoint) <= 1024),
  muted_trip_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  muted_sender_wallets TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.reminder_schedules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id       TEXT        NOT NULL,
  owner_wallet  TEXT        NOT NULL,
  interval_days INT         NOT NULL CHECK (interval_days BETWEEN 1 AND 30),
  next_run_at   TIMESTAMPTZ NOT NULL,
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active schedule per (trip, owner): re-creating replaces, never stacks.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_one_active
  ON public.reminder_schedules (trip_id, owner_wallet)
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_reminder_schedules_due
  ON public.reminder_schedules (next_run_at)
  WHERE active;

DROP TRIGGER IF EXISTS trg_01_payment_reminders_set_updated_at ON public.payment_reminders;
CREATE TRIGGER trg_01_payment_reminders_set_updated_at
  BEFORE UPDATE ON public.payment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_01_reminder_preferences_set_updated_at ON public.reminder_preferences;
CREATE TRIGGER trg_01_reminder_preferences_set_updated_at
  BEFORE UPDATE ON public.reminder_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_01_reminder_schedules_set_updated_at ON public.reminder_schedules;
CREATE TRIGGER trg_01_reminder_schedules_set_updated_at
  BEFORE UPDATE ON public.reminder_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
ALTER TABLE public.payment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_schedules ENABLE ROW LEVEL SECURITY;

-- A reminder is visible only to the two wallets it is between.
DROP POLICY IF EXISTS payment_reminders_select_party ON public.payment_reminders;
CREATE POLICY payment_reminders_select_party ON public.payment_reminders
  FOR SELECT TO authenticated
  USING (public.current_wallet() IN (sender_wallet, recipient_wallet));

DROP POLICY IF EXISTS payment_reminders_insert_sender ON public.payment_reminders;
CREATE POLICY payment_reminders_insert_sender ON public.payment_reminders
  FOR INSERT TO authenticated
  WITH CHECK (sender_wallet = public.current_wallet());

DROP POLICY IF EXISTS payment_reminders_update_party ON public.payment_reminders;
CREATE POLICY payment_reminders_update_party ON public.payment_reminders
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IN (sender_wallet, recipient_wallet))
  WITH CHECK (public.current_wallet() IN (sender_wallet, recipient_wallet));

-- History is append-only: no UPDATE or DELETE policy exists.
DROP POLICY IF EXISTS reminder_events_select_party ON public.reminder_events;
CREATE POLICY reminder_events_select_party ON public.reminder_events
  FOR SELECT TO authenticated
  USING (
    actor_wallet = public.current_wallet()
    OR EXISTS (
      SELECT 1 FROM public.payment_reminders r
       WHERE r.id = reminder_id
         AND public.current_wallet() IN (r.sender_wallet, r.recipient_wallet)
    )
  );

DROP POLICY IF EXISTS reminder_events_insert_actor ON public.reminder_events;
CREATE POLICY reminder_events_insert_actor ON public.reminder_events
  FOR INSERT TO authenticated
  WITH CHECK (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS reminder_preferences_own ON public.reminder_preferences;
CREATE POLICY reminder_preferences_own ON public.reminder_preferences
  FOR ALL TO authenticated
  USING (wallet = public.current_wallet())
  WITH CHECK (wallet = public.current_wallet());

DROP POLICY IF EXISTS reminder_schedules_owner ON public.reminder_schedules;
CREATE POLICY reminder_schedules_owner ON public.reminder_schedules
  FOR ALL TO authenticated
  USING (owner_wallet = public.current_wallet())
  WITH CHECK (owner_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE ON public.payment_reminders TO authenticated;
GRANT SELECT, INSERT ON public.reminder_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reminder_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reminder_schedules TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0013', '0013_payment_reminders', 'payment_reminders_v1')
ON CONFLICT (version) DO NOTHING;
