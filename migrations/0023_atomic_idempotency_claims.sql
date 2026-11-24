-- ============================================================================
-- Migration 0023: Atomic Idempotency Claims and Lease Management (#411)
-- ============================================================================
-- 1. Adds atomic claim function (public.claim_idempotency_key) returning one of
--    four deliberate outcomes: new_claim, completed_replay, incompatible_key_conflict,
--    or temporarily_locked.
-- 2. Implements lease recovery for crashed or timed-out workers.
-- 3. Adds completion and release functions for safe lifecycle tracking.

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
  v_lease_interval INTERVAL;
  v_locked_until TIMESTAMPTZ;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) = 0 THEN
    RAISE EXCEPTION 'Idempotency key is required';
  END IF;

  v_lease_interval := (GREATEST(COALESCE(p_lease_seconds, 60), 1) || ' seconds')::INTERVAL;
  v_locked_until := p_now + v_lease_interval;

  -- 1. Try to lock existing record row
  SELECT * INTO v_rec
  FROM public.idempotency_records
  WHERE wallet_address = p_wallet_address AND key = p_key
  FOR UPDATE;

  -- 2. If no record exists, insert new pending claim
  IF NOT FOUND THEN
    BEGIN
      INSERT INTO public.idempotency_records (
        key,
        wallet_address,
        endpoint,
        request_fingerprint,
        status,
        response_status,
        response_body,
        created_at,
        locked_until
      ) VALUES (
        p_key,
        p_wallet_address,
        p_endpoint,
        p_request_fingerprint,
        'pending',
        NULL,
        NULL,
        p_now,
        v_locked_until
      );

      RETURN jsonb_build_object(
        'outcome', 'new_claim',
        'status', 'pending',
        'locked_until', v_locked_until
      );
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_rec
      FROM public.idempotency_records
      WHERE wallet_address = p_wallet_address AND key = p_key
      FOR UPDATE;
    END;
  END IF;

  -- 3. Deliberate outcome evaluation on existing row
  -- Outcome 1: Incompatible-key conflict
  IF v_rec.request_fingerprint <> p_request_fingerprint THEN
    RETURN jsonb_build_object(
      'outcome', 'incompatible_key_conflict',
      'error', 'Conflicting reuse of idempotency key with different request payload.'
    );
  END IF;

  -- Outcome 2: Completed replay
  IF v_rec.status = 'completed' THEN
    RETURN jsonb_build_object(
      'outcome', 'completed_replay',
      'response_status', COALESCE(v_rec.response_status, 200),
      'response_body', v_rec.response_body
    );
  END IF;

  -- Outcome 3 & 4: Pending lease evaluation
  IF v_rec.status = 'pending' THEN
    IF v_rec.locked_until > p_now THEN
      -- Temporarily locked
      RETURN jsonb_build_object(
        'outcome', 'temporarily_locked',
        'locked_until', v_rec.locked_until,
        'retry_after_seconds', GREATEST(1, EXTRACT(EPOCH FROM (v_rec.locked_until - p_now))::INT)
      );
    ELSE
      -- Lease expired; recover claim for crashed worker
      UPDATE public.idempotency_records
      SET locked_until = v_locked_until,
          endpoint = p_endpoint,
          request_fingerprint = p_request_fingerprint,
          status = 'pending',
          created_at = p_now
      WHERE wallet_address = p_wallet_address AND key = p_key;

      RETURN jsonb_build_object(
        'outcome', 'new_claim',
        'recovered', true,
        'status', 'pending',
        'locked_until', v_locked_until
      );
    END IF;
  END IF;

  -- Failed records can be re-claimed
  UPDATE public.idempotency_records
  SET locked_until = v_locked_until,
      endpoint = p_endpoint,
      request_fingerprint = p_request_fingerprint,
      status = 'pending',
      created_at = p_now
  WHERE wallet_address = p_wallet_address AND key = p_key;

  RETURN jsonb_build_object(
    'outcome', 'new_claim',
    'recovered', true,
    'status', 'pending',
    'locked_until', v_locked_until
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_idempotency_key(
  p_wallet_address TEXT,
  p_key TEXT,
  p_request_fingerprint TEXT,
  p_response_status INT,
  p_response_body JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.idempotency_records
  SET status = 'completed',
      response_status = p_response_status,
      response_body = p_response_body,
      locked_until = NULL
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
  DELETE FROM public.idempotency_records
  WHERE wallet_address = p_wallet_address
    AND key = p_key
    AND status = 'pending';
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_idempotency_key TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.complete_idempotency_key TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.release_idempotency_key TO authenticated, service_role, anon;

-- Record migration in schema_migrations
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0023', '0023_atomic_idempotency_claims', 'atomic_idempotency_claims_411_v1')
ON CONFLICT (version) DO NOTHING;
