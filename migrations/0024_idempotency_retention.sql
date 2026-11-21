-- ============================================================================
-- Migration 0024: Expire and redact idempotency response data (#414)
-- ============================================================================
-- Completed idempotency records used to keep the full HTTP response body
-- forever. This migration:
--
--   1. Adds audit columns: response_digest (SHA-256 of the original body),
--      response_bytes, replay_omitted, completed_at, replay_expires_at,
--      redacted_at.
--   2. Caps the stored replay summary at 16 KiB with a CHECK constraint.
--      The application stores only an allowlisted summary; anything larger is
--      stored as NULL with replay_omitted = TRUE.
--   3. Redacts every pre-existing completed body, because those were stored
--      without an allowlist. The audit facts are kept.
--   4. Replaces claim/complete so a completed record is replayable only
--      until replay_expires_at (24 h by default). After that the key may be
--      reused.
--   5. Adds purge_idempotency_records(): an indexed, batched cleanup that
--      redacts expired replays, deletes audit rows past their retention
--      (30 days) and deletes stale pending claims (24 h).
--   6. Scopes the ledger functions to the caller: anon can no longer execute
--      them, and an authenticated caller may only touch rows for the wallet
--      in its own JWT.
--
-- Rollback: re-run migration 0023's function definitions, then
--   ALTER TABLE public.idempotency_records
--     DROP CONSTRAINT IF EXISTS idempotency_records_replay_size_cap;
-- The added columns are nullable or defaulted and can stay. Redacted bodies
-- cannot be restored, which is the point of this migration.

-- ── 1. Audit columns ────────────────────────────────────────────────────────
ALTER TABLE public.idempotency_records
  ADD COLUMN IF NOT EXISTS response_digest   TEXT,
  ADD COLUMN IF NOT EXISTS response_bytes    INT,
  ADD COLUMN IF NOT EXISTS replay_omitted    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replay_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS redacted_at       TIMESTAMPTZ;

COMMENT ON COLUMN public.idempotency_records.response_body IS
  'Allowlisted replay summary (<= 16 KiB), never the raw response. NULL once redacted or when omitted for size.';
COMMENT ON COLUMN public.idempotency_records.response_digest IS
  'SHA-256 (hex) of the original response body, kept for audit after the summary is redacted.';

-- ── 2. Size cap on the stored summary ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'idempotency_records_replay_size_cap'
      AND conrelid = 'public.idempotency_records'::regclass
  ) THEN
    ALTER TABLE public.idempotency_records
      ADD CONSTRAINT idempotency_records_replay_size_cap
      CHECK (response_body IS NULL OR octet_length(response_body::text) <= 16384) NOT VALID;
  END IF;
END;
$$;

-- ── 3. Redact bodies stored before the allowlist existed ────────────────────
UPDATE public.idempotency_records
SET response_body     = NULL,
    replay_omitted    = TRUE,
    completed_at      = COALESCE(completed_at, created_at),
    replay_expires_at = COALESCE(replay_expires_at, created_at + INTERVAL '24 hours'),
    redacted_at       = COALESCE(redacted_at, NOW())
WHERE status = 'completed' AND redacted_at IS NULL;

ALTER TABLE public.idempotency_records
  VALIDATE CONSTRAINT idempotency_records_replay_size_cap;

-- ── 4. Indexed cleanup paths ────────────────────────────────────────────────
-- Replays awaiting redaction, oldest first.
CREATE INDEX IF NOT EXISTS idx_idempotency_records_replay_expiry
  ON public.idempotency_records (replay_expires_at)
  WHERE status = 'completed' AND redacted_at IS NULL;

-- Audit rows past retention.
CREATE INDEX IF NOT EXISTS idx_idempotency_records_completed_at
  ON public.idempotency_records (completed_at)
  WHERE status = 'completed';

-- Pending claims abandoned by a crashed worker and never retried.
CREATE INDEX IF NOT EXISTS idx_idempotency_records_stale_pending
  ON public.idempotency_records (locked_until)
  WHERE status = 'pending';

-- ── 5. Caller scoping helper ────────────────────────────────────────────────
-- Service-role callers (no wallet claim) may act for any principal, e.g.
-- staff:<id>. A wallet session may act only for its own wallet.
CREATE OR REPLACE FUNCTION public.assert_idempotency_principal(p_wallet_address TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller TEXT := public.current_wallet();
BEGIN
  IF v_caller IS NOT NULL AND upper(btrim(v_caller)) <> upper(btrim(p_wallet_address)) THEN
    RAISE EXCEPTION 'Idempotency records belong to the caller''s own wallet'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ── 6. Claim: replay only within the retention window ───────────────────────
CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
  p_wallet_address TEXT,
  p_key TEXT,
  p_endpoint TEXT,
  p_request_fingerprint TEXT,
  p_lease_seconds INT DEFAULT 60,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec public.idempotency_records%ROWTYPE;
  v_locked_until TIMESTAMPTZ;
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 OR length(p_key) > 255 THEN
    RAISE EXCEPTION 'Idempotency key must be 8-255 characters' USING ERRCODE = '22023';
  END IF;
  PERFORM public.assert_idempotency_principal(p_wallet_address);

  v_locked_until := p_now + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 60), 1));

  SELECT * INTO v_rec
  FROM public.idempotency_records
  WHERE wallet_address = p_wallet_address AND key = p_key
  FOR UPDATE;

  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.idempotency_records (
        key, wallet_address, endpoint, request_fingerprint, status,
        response_status, response_body, created_at, locked_until
      ) VALUES (
        p_key, p_wallet_address, p_endpoint, p_request_fingerprint, 'pending',
        NULL, NULL, p_now, v_locked_until
      );
      RETURN jsonb_build_object('outcome', 'new_claim', 'status', 'pending', 'locked_until', v_locked_until);
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_rec
      FROM public.idempotency_records
      WHERE wallet_address = p_wallet_address AND key = p_key
      FOR UPDATE;
    END;
  END IF;

  -- A completed record past its replay window no longer answers for the key:
  -- the key is free to start a new request (documented retention).
  IF v_rec.status = 'completed'
     AND (v_rec.redacted_at IS NOT NULL OR COALESCE(v_rec.replay_expires_at, v_rec.created_at) <= p_now) THEN
    UPDATE public.idempotency_records
    SET endpoint = p_endpoint,
        request_fingerprint = p_request_fingerprint,
        status = 'pending',
        response_status = NULL,
        response_body = NULL,
        response_digest = NULL,
        response_bytes = NULL,
        replay_omitted = FALSE,
        completed_at = NULL,
        replay_expires_at = NULL,
        redacted_at = NULL,
        created_at = p_now,
        locked_until = v_locked_until
    WHERE wallet_address = p_wallet_address AND key = p_key;
    RETURN jsonb_build_object('outcome', 'new_claim', 'recovered', true, 'status', 'pending', 'locked_until', v_locked_until);
  END IF;

  IF v_rec.request_fingerprint <> p_request_fingerprint THEN
    RETURN jsonb_build_object(
      'outcome', 'incompatible_key_conflict',
      'error', 'Conflicting reuse of idempotency key with different request payload.'
    );
  END IF;

  IF v_rec.status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'completed_replay',
      'response_status', COALESCE(v_rec.response_status, 200),
      'response_body', v_rec.response_body,
      'response_digest', v_rec.response_digest,
      'replay_omitted', v_rec.replay_omitted
    );
  END IF;

  IF v_rec.status = 'pending' AND v_rec.locked_until > p_now THEN
    RETURN jsonb_build_object(
      'outcome', 'temporarily_locked',
      'locked_until', v_rec.locked_until,
      'retry_after_seconds', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_rec.locked_until - p_now)))::INT)
    );
  END IF;

  -- Expired lease or failed record: recover the claim.
  UPDATE public.idempotency_records
  SET locked_until = v_locked_until,
      endpoint = p_endpoint,
      request_fingerprint = p_request_fingerprint,
      status = 'pending',
      created_at = p_now
  WHERE wallet_address = p_wallet_address AND key = p_key;

  RETURN jsonb_build_object('outcome', 'new_claim', 'recovered', true, 'status', 'pending', 'locked_until', v_locked_until);
END;
$$;

-- ── 7. Complete: store the summary, digest and expiry ───────────────────────
-- The 0023 signature is replaced, not overloaded, so a call can never resolve
-- to the version that stored raw bodies.
DROP FUNCTION IF EXISTS public.complete_idempotency_key(TEXT, TEXT, TEXT, INT, JSONB);

CREATE OR REPLACE FUNCTION public.complete_idempotency_key(
  p_wallet_address TEXT,
  p_key TEXT,
  p_request_fingerprint TEXT,
  p_response_status INT,
  p_response_body JSONB,
  p_response_digest TEXT DEFAULT NULL,
  p_response_bytes INT DEFAULT NULL,
  p_replay_omitted BOOLEAN DEFAULT FALSE,
  p_replay_seconds INT DEFAULT 86400,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_body JSONB := p_response_body;
  v_omitted BOOLEAN := COALESCE(p_replay_omitted, FALSE);
BEGIN
  PERFORM public.assert_idempotency_principal(p_wallet_address);

  -- Defence in depth: the application already caps the summary.
  IF v_body IS NOT NULL AND octet_length(v_body::text) > 16384 THEN
    v_body := NULL;
    v_omitted := TRUE;
  END IF;

  UPDATE public.idempotency_records
  SET status = 'completed',
      response_status = p_response_status,
      response_body = v_body,
      response_digest = p_response_digest,
      response_bytes = p_response_bytes,
      replay_omitted = v_omitted,
      completed_at = p_now,
      replay_expires_at = p_now + make_interval(secs => GREATEST(COALESCE(p_replay_seconds, 86400), 1)),
      redacted_at = NULL,
      -- locked_until is NOT NULL; the lease simply ends now.
      locked_until = p_now
  WHERE wallet_address = p_wallet_address
    AND key = p_key
    AND request_fingerprint = p_request_fingerprint;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_idempotency_key(
  p_wallet_address TEXT,
  p_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_idempotency_principal(p_wallet_address);
  DELETE FROM public.idempotency_records
  WHERE wallet_address = p_wallet_address
    AND key = p_key
    AND status = 'pending';
END;
$$;

-- ── 8. Batched retention cleanup ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_idempotency_records(
  p_now TIMESTAMPTZ DEFAULT NOW(),
  p_batch_size INT DEFAULT 1000,
  p_audit_retention_days INT DEFAULT 30,
  p_stale_pending_hours INT DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_batch INT := LEAST(GREATEST(COALESCE(p_batch_size, 1000), 1), 10000);
  v_redacted INT := 0;
  v_deleted INT := 0;
  v_stale INT := 0;
BEGIN
  -- Redact replays past their window (idx_idempotency_records_replay_expiry).
  WITH due AS (
    SELECT wallet_address, key
    FROM public.idempotency_records
    WHERE status = 'completed' AND redacted_at IS NULL AND replay_expires_at <= p_now
    ORDER BY replay_expires_at
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.idempotency_records r
  SET response_body = NULL, redacted_at = p_now
  FROM due
  WHERE r.wallet_address = due.wallet_address AND r.key = due.key;
  GET DIAGNOSTICS v_redacted = ROW_COUNT;

  -- Delete audit rows past retention (idx_idempotency_records_completed_at).
  WITH due AS (
    SELECT wallet_address, key
    FROM public.idempotency_records
    WHERE status = 'completed'
      AND completed_at < p_now - make_interval(days => GREATEST(COALESCE(p_audit_retention_days, 30), 1))
    ORDER BY completed_at
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.idempotency_records r
  USING due
  WHERE r.wallet_address = due.wallet_address AND r.key = due.key;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Delete abandoned pending claims (idx_idempotency_records_stale_pending).
  WITH due AS (
    SELECT wallet_address, key
    FROM public.idempotency_records
    WHERE status = 'pending'
      AND locked_until < p_now - make_interval(hours => GREATEST(COALESCE(p_stale_pending_hours, 24), 1))
    ORDER BY locked_until
    LIMIT v_batch
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.idempotency_records r
  USING due
  WHERE r.wallet_address = due.wallet_address AND r.key = due.key;
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  RETURN jsonb_build_object(
    'redacted', v_redacted,
    'deleted', v_deleted,
    'stale_pending_deleted', v_stale,
    'batch_size', v_batch
  );
END;
$$;

-- ── 9. Grants: no anonymous access to the ledger ────────────────────────────
REVOKE EXECUTE ON FUNCTION public.claim_idempotency_key(TEXT, TEXT, TEXT, TEXT, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.complete_idempotency_key(TEXT, TEXT, TEXT, INT, JSONB, TEXT, INT, BOOLEAN, INT, TIMESTAMPTZ) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.release_idempotency_key(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.purge_idempotency_records(TIMESTAMPTZ, INT, INT, INT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_idempotency_key(TEXT, TEXT, TEXT, TEXT, INT, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_idempotency_key(TEXT, TEXT, TEXT, INT, JSONB, TEXT, INT, BOOLEAN, INT, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_idempotency_key(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_idempotency_records(TIMESTAMPTZ, INT, INT, INT) TO service_role;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0024', '0024_idempotency_retention', 'idempotency_retention_414_v1')
ON CONFLICT (version) DO NOTHING;
