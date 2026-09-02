-- ============================================================================
-- Stellar-star Migration 0004: Settlement intents + cross-trip claim guard
-- ============================================================================
-- WHY THIS EXISTS
--
-- Three defects, all of which only show up at runtime:
--
-- 1. `public.settlement_intents` was queried by lib/settlement/intent.ts and
--    lib/supabase/queries.ts but created by neither provisioning path. Reads
--    degraded silently to "no intent found" and writes failed outright — and a
--    missing intent is precisely the state in which two clients will each
--    submit a payment for the same share.
--
-- 2. `claim_trip_invite` resolved its target slot with
--    COALESCE(v_invite.member_id, p_selected_member_id). For an invite pinned
--    to a member, a caller-supplied id naming a *different* slot was silently
--    ignored and the pinned slot granted instead, so a token for one trip could
--    be presented against another trip's member and still report success.
--
-- 3. `schema_migrations_read` was created without a preceding DROP POLICY IF
--    EXISTS, so re-running migration 0001 failed instead of being a no-op.
--
-- SAFETY
--
-- Every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP
-- POLICY IF EXISTS before CREATE POLICY). There are no DROP TABLE, DROP COLUMN
-- or destructive ALTER statements, so neither provisioning path loses data.
--
-- ROLLBACK: see docs/DATABASE_MIGRATIONS.md. The down path is documented rather
-- than automated — dropping settlement_intents would discard in-flight
-- settlement records, so the safe reversal is to redeploy the previous
-- application version, which does not read the table.

-- ============================================================================
-- Settlement intents  (durable idempotency for share settlement)
-- ============================================================================
-- lib/settlement/intent.ts records an intent here *before* submitting a payment
-- to Horizon, so that:
--   1. two clients cannot settle the same share concurrently,
--   2. a crash mid-flow leaves a record any device can reconcile against,
--   3. a retry after a dropped response never moves money twice.
--
-- The table was queried by application code but created by neither provisioning
-- path, so every write failed at runtime and the reads silently degraded to
-- "no intent" — which is exactly the state that permits a double payment.

CREATE TABLE IF NOT EXISTS public.settlement_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Derived deterministically from (trip, expense, member); the unique
  -- constraint is what makes concurrent settlement attempts collide here
  -- rather than each submitting its own payment.
  idempotency_key   TEXT        NOT NULL UNIQUE,
  trip_id           TEXT        NOT NULL,
  expense_id        TEXT        NOT NULL,
  member_id         TEXT        NOT NULL,
  payer_wallet      TEXT        NOT NULL,
  member_wallet     TEXT        NOT NULL,
  -- TEXT, matching expenses.total_amount: the application holds these as exact
  -- decimal strings and reads this column straight back into one. NUMERIC would
  -- re-render the value on the way out (trailing-zero and notation changes),
  -- which is exactly the drift the money layer exists to prevent.
  amount            TEXT        NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'XLM',
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'submitting', 'submitted',
                                                  'recorded', 'failed', 'cancelled')),
  tx_hash           TEXT,
  ledger            BIGINT,
  on_chain          BOOLEAN     NOT NULL DEFAULT FALSE,
  error_message     TEXT,
  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS settlement_intents_member_wallet_idx
  ON public.settlement_intents (member_wallet, status);

CREATE INDEX IF NOT EXISTS settlement_intents_expense_member_idx
  ON public.settlement_intents (expense_id, member_id);

ALTER TABLE public.settlement_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "settlement_intents_select_party" ON public.settlement_intents;
DROP POLICY IF EXISTS "settlement_intents_insert_self" ON public.settlement_intents;
DROP POLICY IF EXISTS "settlement_intents_update_self" ON public.settlement_intents;
DROP POLICY IF EXISTS "settlement_intents_delete_self" ON public.settlement_intents;

-- Either side of the payment can see the intent: the payer needs it to resume a
-- crashed flow, the recipient to see that a payment is already in flight.
CREATE POLICY "settlement_intents_select_party" ON public.settlement_intents
  FOR SELECT USING (
    member_wallet = public.current_wallet() OR
    payer_wallet = public.current_wallet()
  );

CREATE POLICY "settlement_intents_insert_self" ON public.settlement_intents
  FOR INSERT WITH CHECK (created_by_wallet = public.current_wallet());

CREATE POLICY "settlement_intents_update_self" ON public.settlement_intents
  FOR UPDATE USING (created_by_wallet = public.current_wallet())
             WITH CHECK (created_by_wallet = public.current_wallet());

CREATE POLICY "settlement_intents_delete_self" ON public.settlement_intents
  FOR DELETE USING (created_by_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.settlement_intents TO anon, authenticated;

DROP TRIGGER IF EXISTS trg_01_settlement_intents_set_updated_at ON public.settlement_intents;
CREATE TRIGGER trg_01_settlement_intents_set_updated_at
  BEFORE UPDATE ON public.settlement_intents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Cross-trip claim guard  (see defect 2 above)
-- ============================================================================
-- Replaces the function defined in migration 0003 so that a pinned invite
-- rejects a mismatched p_selected_member_id instead of quietly substituting its
-- own slot.

CREATE OR REPLACE FUNCTION public.claim_trip_invite(
  p_token_hash TEXT,
  p_claiming_wallet TEXT,
  p_selected_member_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_invite RECORD;
  v_trip RECORD;
  v_target_member_id TEXT;
  v_target_member_name TEXT;
  v_members JSONB;
  v_updated_members JSONB := '[]'::jsonb;
  v_member JSONB;
  v_found BOOLEAN := FALSE;
  v_already_claimed BOOLEAN := FALSE;
  v_idx INT;
  v_len INT;
BEGIN
  -- 1. Validate claiming wallet
  IF p_claiming_wallet IS NULL OR btrim(p_claiming_wallet) = '' THEN
    RAISE EXCEPTION 'Claiming wallet address is required';
  END IF;

  -- 2. Lock and validate the invite row
  SELECT *
    INTO v_invite
    FROM public.trip_invites
   WHERE token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invalid or unrecognized invitation token';
  END IF;

  IF v_invite.revoked THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invitation has been revoked';
  END IF;

  IF v_invite.expires_at <= NOW() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired';
  END IF;

  IF v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invitation has already reached its maximum uses';
  END IF;

  -- 3. Lock and retrieve the trip row
  SELECT *
    INTO v_trip
    FROM public.trips
   WHERE id = v_invite.trip_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND: Associated trip no longer exists';
  END IF;

  -- 4. Determine target member slot.
  --
  -- When the invite is pinned to a member, a caller-supplied p_selected_member_id
  -- that names a different slot is a cross-trip claim attempt, not a preference:
  -- the old COALESCE silently ignored it and granted the pinned slot instead, so
  -- the caller was told the claim succeeded for a member they never asked for.
  -- Reject the mismatch outright and let the pinned id stand otherwise.
  IF v_invite.member_id IS NOT NULL
     AND p_selected_member_id IS NOT NULL
     AND p_selected_member_id <> v_invite.member_id THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND: Member % is not the slot this invitation is for', p_selected_member_id;
  END IF;

  v_target_member_id := COALESCE(v_invite.member_id, p_selected_member_id);
  v_members := COALESCE(v_trip.members, '[]'::jsonb);
  v_len := jsonb_array_length(v_members);

  IF v_target_member_id IS NOT NULL THEN
    -- Look for specified member slot
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF (v_member ->> 'id') = v_target_member_id THEN
        v_found := TRUE;
        v_target_member_name := v_member ->> 'name';
        
        -- Check if already claimed
        IF (v_member ->> 'walletAddress') IS NOT NULL AND btrim(v_member ->> 'walletAddress') <> '' THEN
          IF (v_member ->> 'walletAddress') = p_claiming_wallet THEN
            -- Idempotent retry by the same wallet
            RETURN jsonb_build_object(
              'success', true,
              'trip_id', v_trip.id,
              'trip_name', v_trip.name,
              'member_id', v_target_member_id,
              'member_name', v_target_member_name,
              'message', 'Already claimed by this wallet'
            );
          ELSE
            RAISE EXCEPTION 'SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet';
          END IF;
        END IF;

        -- Attach wallet
        v_updated_members := v_updated_members || jsonb_build_array(v_member || jsonb_build_object('walletAddress', p_claiming_wallet));
      ELSE
        v_updated_members := v_updated_members || jsonb_build_array(v_member);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      RAISE EXCEPTION 'MEMBER_NOT_FOUND: Member slot % not found in trip', v_target_member_id;
    END IF;
  ELSE
    -- General invite with no slot pre-selected: find first unclaimed placeholder slot
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF NOT v_found AND ((v_member ->> 'walletAddress') IS NULL OR btrim(v_member ->> 'walletAddress') = '') THEN
        v_found := TRUE;
        v_target_member_id := v_member ->> 'id';
        v_target_member_name := v_member ->> 'name';
        v_updated_members := v_updated_members || jsonb_build_array(v_member || jsonb_build_object('walletAddress', p_claiming_wallet));
      ELSE
        v_updated_members := v_updated_members || jsonb_build_array(v_member);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      -- No open placeholder slots: add new member
      v_target_member_id := gen_random_uuid()::text;
      v_target_member_name := 'Member ' || (v_len + 1)::text;
      v_updated_members := v_members || jsonb_build_array(
        jsonb_build_object('id', v_target_member_id, 'name', v_target_member_name, 'walletAddress', p_claiming_wallet)
      );
    END IF;
  END IF;

  -- 5. Update trip members JSONB (triggers sync_member_wallets)
  UPDATE public.trips
     SET members = v_updated_members
   WHERE id = v_trip.id;

  -- 6. Update expenses linked to this trip
  -- Update members and shares for this member_id to attach walletAddress
  UPDATE public.expenses
     SET members = (
           SELECT jsonb_agg(
             CASE
               WHEN (m ->> 'id') = v_target_member_id THEN m || jsonb_build_object('walletAddress', p_claiming_wallet)
               ELSE m
             END
           )
           FROM jsonb_array_elements(members) AS m
         ),
         shares = (
           SELECT jsonb_agg(
             CASE
               WHEN (s ->> 'memberId') = v_target_member_id THEN s || jsonb_build_object('walletAddress', p_claiming_wallet)
               ELSE s
             END
           )
           FROM jsonb_array_elements(shares) AS s
         )
   WHERE (id::text = ANY(v_trip.expense_ids) OR v_trip.id::text = ANY(member_wallets) OR members @> jsonb_build_array(jsonb_build_object('id', v_target_member_id)));

  -- 7. Increment invite uses
  UPDATE public.trip_invites
     SET uses = uses + 1
   WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_trip.id,
    'trip_name', v_trip.name,
    'member_id', v_target_member_id,
    'member_name', v_target_member_name
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.claim_trip_invite(TEXT, TEXT, TEXT) TO anon, authenticated;

-- ============================================================================
-- Re-runnable schema_migrations policy  (see defect 3 above)
-- ============================================================================

DROP POLICY IF EXISTS schema_migrations_read ON public.schema_migrations;

CREATE POLICY schema_migrations_read ON public.schema_migrations
  FOR SELECT TO authenticated, anon USING (true);

-- ─── RECORD MIGRATION ────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0004', '0004_settlement_intents_and_claim_guard', 'settlement_intents_and_claim_guard_v1')
ON CONFLICT (version) DO NOTHING;
