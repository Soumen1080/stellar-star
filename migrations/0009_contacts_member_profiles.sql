-- ============================================================================
-- Stellar-star Migration 0009: Reusable contacts & member profiles (#322)
-- ============================================================================
-- A private address book so names and wallets are not retyped for every trip.
--
-- Guarantees enforced by the database, not trusted from the client:
--   1. Contacts are private: every policy is owner_wallet = current_wallet().
--   2. Duplicates are detected by canonical wallet address, never by name:
--      UNIQUE (owner_wallet, wallet_address) on the upper-cased address.
--   3. Only the wallet's owner can verify it. wallet_verified/claimed_by_wallet
--      are writable solely by claim_contact_profile, which requires a session
--      signed by that very wallet.
--   4. A wallet already on a contact is never swapped in place. The change is
--      recorded in contact_wallet_changes, visible to every member of the
--      affected active trips, and applies only after the notice period.
--      Historic shares and payments are never rewritten.
-- See docs/DESIGN_CONTACTS.md.

-- ── Contacts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet        TEXT        NOT NULL,
  display_name        TEXT        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  wallet_address      TEXT        CHECK (wallet_address IS NULL OR wallet_address ~ '^G[A-Z2-7]{55}$'),
  wallet_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  claimed_by_wallet   TEXT,
  verified_at         TIMESTAMPTZ,
  invite_destination  TEXT        CHECK (invite_destination IS NULL OR length(invite_destination) <= 254),
  invite_channel      TEXT        CHECK (invite_channel IS NULL OR invite_channel IN ('email', 'phone', 'other')),
  -- SHA-256 of a one-time claim token; the token itself is never stored.
  claim_token_hash    TEXT,
  claim_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_wallet_unique_idx
  ON public.contacts (owner_wallet, wallet_address)
  WHERE wallet_address IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_claim_token_hash_idx
  ON public.contacts (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_owner_name
  ON public.contacts (owner_wallet, display_name);

-- Canonicalises input and protects the verification columns. Functions below
-- that are allowed to touch them set stellar_star.contact_privileged for the
-- current transaction only.
CREATE OR REPLACE FUNCTION public.guard_contact_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  privileged BOOLEAN := COALESCE(current_setting('stellar_star.contact_privileged', true), '') = 'on';
BEGIN
  NEW.display_name := btrim(NEW.display_name);
  NEW.wallet_address := NULLIF(upper(btrim(COALESCE(NEW.wallet_address, ''))), '');
  NEW.invite_destination := NULLIF(btrim(COALESCE(NEW.invite_destination, '')), '');

  IF privileged THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.wallet_verified := FALSE;
    NEW.claimed_by_wallet := NULL;
    NEW.verified_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE by the owner.
  NEW.owner_wallet := OLD.owner_wallet;
  NEW.wallet_verified := OLD.wallet_verified;
  NEW.claimed_by_wallet := OLD.claimed_by_wallet;
  NEW.verified_at := OLD.verified_at;

  IF OLD.wallet_address IS NOT NULL
     AND NEW.wallet_address IS DISTINCT FROM OLD.wallet_address THEN
    RAISE EXCEPTION 'CONTACT_WALLET_CHANGE_REQUIRES_NOTICE'
      USING HINT = 'Use request_contact_wallet_change so affected trips are notified first.';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_01_contacts_guard ON public.contacts;
CREATE TRIGGER trg_01_contacts_guard
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_contact_row();

DROP TRIGGER IF EXISTS trg_02_contacts_set_updated_at ON public.contacts;
CREATE TRIGGER trg_02_contacts_set_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_select_owner ON public.contacts;
CREATE POLICY contacts_select_owner ON public.contacts
  FOR SELECT USING (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_insert_owner ON public.contacts;
CREATE POLICY contacts_insert_owner ON public.contacts
  FOR INSERT WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_update_owner ON public.contacts;
CREATE POLICY contacts_update_owner ON public.contacts
  FOR UPDATE USING      (owner_wallet = public.current_wallet())
             WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_delete_owner ON public.contacts;
CREATE POLICY contacts_delete_owner ON public.contacts
  FOR DELETE USING (owner_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;

-- ── Wallet change history ───────────────────────────────────────────────────
-- Written only by the functions below. Readable by the contact's owner and by
-- every member of an affected trip, which is how those groups are notified.
CREATE TABLE IF NOT EXISTS public.contact_wallet_changes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         UUID        NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  owner_wallet       TEXT        NOT NULL,
  contact_name       TEXT        NOT NULL,
  old_wallet         TEXT,
  new_wallet         TEXT        NOT NULL CHECK (new_wallet ~ '^G[A-Z2-7]{55}$'),
  status             TEXT        NOT NULL DEFAULT 'pending_notice'
                     CHECK (status IN ('pending_notice', 'applied', 'cancelled')),
  affected_trip_ids  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  notice_until       TIMESTAMPTZ NOT NULL,
  verified           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contact_wallet_changes_contact_created_at
  ON public.contact_wallet_changes (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_wallet_changes_affected_trips
  ON public.contact_wallet_changes USING GIN (affected_trip_ids);

-- At most one pending change per contact.
CREATE UNIQUE INDEX IF NOT EXISTS contact_wallet_changes_one_pending_idx
  ON public.contact_wallet_changes (contact_id)
  WHERE status = 'pending_notice';

ALTER TABLE public.contact_wallet_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_wallet_changes_select_party ON public.contact_wallet_changes;
CREATE POLICY contact_wallet_changes_select_party ON public.contact_wallet_changes
  FOR SELECT USING (
    owner_wallet = public.current_wallet()
    OR EXISTS (
      SELECT 1 FROM public.trips t
       WHERE t.id::TEXT = ANY (affected_trip_ids)
         AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

GRANT SELECT ON public.contact_wallet_changes TO authenticated;

-- ── request_contact_wallet_change ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_contact_wallet_change(
  p_contact_id  UUID,
  p_new_wallet  TEXT
)
RETURNS SETOF public.contact_wallet_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet   TEXT := public.current_wallet();
  v_contact  public.contacts%ROWTYPE;
  v_new      TEXT := upper(btrim(COALESCE(p_new_wallet, '')));
  v_affected TEXT[];
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM public.contacts
   WHERE id = p_contact_id AND owner_wallet = v_wallet
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_NOT_FOUND';
  END IF;

  IF v_new !~ '^G[A-Z2-7]{55}$' THEN
    RAISE EXCEPTION 'CONTACT_INVALID_WALLET';
  END IF;
  IF v_new = v_contact.wallet_address THEN
    RAISE EXCEPTION 'CONTACT_WALLET_UNCHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts
              WHERE owner_wallet = v_wallet AND wallet_address = v_new AND id <> p_contact_id) THEN
    RAISE EXCEPTION 'CONTACT_DUPLICATE_WALLET';
  END IF;

  UPDATE public.contact_wallet_changes
     SET status = 'cancelled'
   WHERE contact_id = p_contact_id AND status = 'pending_notice';

  -- Active trips the owner shares with the old wallet. Settled trips are
  -- history and are left alone.
  SELECT COALESCE(array_agg(t.id::TEXT), ARRAY[]::TEXT[]) INTO v_affected
    FROM public.trips t
   WHERE v_contact.wallet_address IS NOT NULL
     AND t.settled = FALSE
     AND t.member_wallets @> ARRAY[v_wallet]
     AND t.member_wallets @> ARRAY[v_contact.wallet_address];

  RETURN QUERY
  INSERT INTO public.contact_wallet_changes (
    contact_id, owner_wallet, contact_name, old_wallet, new_wallet,
    affected_trip_ids, notice_until, verified
  ) VALUES (
    p_contact_id, v_wallet, v_contact.display_name, v_contact.wallet_address, v_new,
    v_affected,
    CASE WHEN cardinality(v_affected) = 0 THEN NOW() ELSE NOW() + INTERVAL '24 hours' END,
    -- An address typed by the owner is never verified; only a claim is.
    FALSE
  )
  RETURNING *;
END;
$fn$;

-- ── apply / cancel ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_contact_wallet_change(p_change_id UUID)
RETURNS SETOF public.contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet TEXT := public.current_wallet();
  v_change public.contact_wallet_changes%ROWTYPE;
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_change FROM public.contact_wallet_changes
   WHERE id = p_change_id AND owner_wallet = v_wallet
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_CHANGE_NOT_FOUND';
  END IF;
  IF v_change.status <> 'pending_notice' THEN
    RAISE EXCEPTION 'CONTACT_CHANGE_NOT_PENDING';
  END IF;
  IF cardinality(v_change.affected_trip_ids) > 0 AND v_change.notice_until > NOW() THEN
    RAISE EXCEPTION 'CONTACT_NOTICE_PERIOD_ACTIVE: affected trips are still being notified until %',
      v_change.notice_until;
  END IF;

  PERFORM set_config('stellar_star.contact_privileged', 'on', true);

  UPDATE public.contact_wallet_changes
     SET status = 'applied', applied_at = NOW()
   WHERE id = p_change_id;

  RETURN QUERY
  UPDATE public.contacts
     SET wallet_address    = v_change.new_wallet,
         wallet_verified   = v_change.verified,
         claimed_by_wallet = CASE WHEN v_change.verified THEN v_change.new_wallet END,
         verified_at       = CASE WHEN v_change.verified THEN NOW() END
   WHERE id = v_change.contact_id
  RETURNING *;

  PERFORM set_config('stellar_star.contact_privileged', 'off', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_contact_wallet_change(p_change_id UUID)
RETURNS SETOF public.contact_wallet_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF public.current_wallet() IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.contact_wallet_changes
     SET status = 'cancelled'
   WHERE id = p_change_id
     AND owner_wallet = public.current_wallet()
     AND status = 'pending_notice'
  RETURNING *;
END;
$fn$;

-- ── claim_contact_profile ───────────────────────────────────────────────────
-- The wallet owner proves control by signing in (the session JWT carries the
-- signature-verified wallet) and presenting the one-time claim token.
CREATE OR REPLACE FUNCTION public.claim_contact_profile(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_claimant TEXT := public.current_wallet();
  v_contact  public.contacts%ROWTYPE;
  v_change   public.contact_wallet_changes%ROWTYPE;
BEGIN
  IF v_claimant IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM public.contacts
   WHERE claim_token_hash = p_token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_INVALID';
  END IF;
  IF v_contact.claim_expires_at IS NULL OR v_contact.claim_expires_at <= NOW() THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_EXPIRED';
  END IF;
  IF v_contact.owner_wallet = v_claimant THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_SELF';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts
              WHERE owner_wallet = v_contact.owner_wallet
                AND wallet_address = v_claimant
                AND id <> v_contact.id) THEN
    RAISE EXCEPTION 'CONTACT_DUPLICATE_WALLET';
  END IF;

  PERFORM set_config('stellar_star.contact_privileged', 'on', true);

  -- One-time token: consumed whatever happens next.
  UPDATE public.contacts SET claim_token_hash = NULL, claim_expires_at = NULL
   WHERE id = v_contact.id;

  IF v_contact.wallet_address IS NULL OR v_contact.wallet_address = v_claimant THEN
    -- No address in use yet, or the claim confirms the one already entered:
    -- nothing historic changes, so verify immediately.
    UPDATE public.contacts
       SET wallet_address = v_claimant, wallet_verified = TRUE,
           claimed_by_wallet = v_claimant, verified_at = NOW()
     WHERE id = v_contact.id;

    PERFORM set_config('stellar_star.contact_privileged', 'off', true);
    RETURN jsonb_build_object(
      'status', 'verified',
      'contact_name', v_contact.display_name,
      'owner_wallet', v_contact.owner_wallet
    );
  END IF;

  -- The claimant controls a different wallet than the one on file. Treat it as
  -- an address change, so the owner's active trips are notified first.
  UPDATE public.contact_wallet_changes SET status = 'cancelled'
   WHERE contact_id = v_contact.id AND status = 'pending_notice';

  INSERT INTO public.contact_wallet_changes (
    contact_id, owner_wallet, contact_name, old_wallet, new_wallet,
    affected_trip_ids, notice_until, verified
  )
  SELECT v_contact.id, v_contact.owner_wallet, v_contact.display_name,
         v_contact.wallet_address, v_claimant, affected,
         CASE WHEN cardinality(affected) = 0 THEN NOW() ELSE NOW() + INTERVAL '24 hours' END,
         TRUE
    FROM (
      SELECT COALESCE(array_agg(t.id::TEXT), ARRAY[]::TEXT[]) AS affected
        FROM public.trips t
       WHERE t.settled = FALSE
         AND t.member_wallets @> ARRAY[v_contact.owner_wallet]
         AND t.member_wallets @> ARRAY[v_contact.wallet_address]
    ) a
  RETURNING * INTO v_change;

  PERFORM set_config('stellar_star.contact_privileged', 'off', true);
  RETURN jsonb_build_object(
    'status', 'pending_notice',
    'contact_name', v_contact.display_name,
    'owner_wallet', v_contact.owner_wallet,
    'notice_until', v_change.notice_until
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.request_contact_wallet_change(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_contact_wallet_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_contact_wallet_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_contact_profile(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_contact_wallet_change(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_contact_wallet_change(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_contact_wallet_change(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_profile(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0009', '0009_contacts_member_profiles', 'contacts_member_profiles_v1')
ON CONFLICT (version) DO NOTHING;
