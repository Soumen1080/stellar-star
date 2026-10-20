-- ============================================================================
-- Stellar-star Migration 0014: Settlement proposals and confirmation (#328)
-- ============================================================================
-- Before payments begin, a member can freeze a "proposed settlement": the
-- exact expense versions, balances, assets and transfers it covers, with a
-- creator, an expiry and a deterministic content hash
-- (lib/settlement/proposal.ts). Members approve it, reject it with a reason,
-- or request an edit.
--
-- The hash is recomputed from `snapshot` by every reader; a row whose snapshot
-- does not hash to `content_hash` is treated as invalid, so a tampered
-- snapshot can never collect approvals. Each response records the hash it
-- answered, so an approval only ever counts for the exact snapshot approved.
--
-- Stored lifecycle is open | revoked | superseded | invalidated. "approved",
-- "rejected", "expired" and "invalidated by a material change" are derived
-- from the responses, `expires_at` and the live expenses.

CREATE TABLE IF NOT EXISTS public.settlement_proposals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        TEXT        NOT NULL,
  creator_wallet TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  snapshot       JSONB       NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  status         TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'revoked', 'superseded', 'invalidated')),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_reason TEXT        CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_proposals_hash_unique UNIQUE (content_hash)
);

-- At most one open proposal per trip: proposing again supersedes, never stacks.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_proposals_one_open_per_trip
  ON public.settlement_proposals (trip_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_settlement_proposals_trip_created_at
  ON public.settlement_proposals (trip_id, created_at DESC);

-- Append-only: a member's latest response is the one that counts.
CREATE TABLE IF NOT EXISTS public.settlement_proposal_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  UUID        NOT NULL REFERENCES public.settlement_proposals (id) ON DELETE CASCADE,
  member_id    TEXT        NOT NULL,
  wallet       TEXT        NOT NULL,
  decision     TEXT        NOT NULL CHECK (decision IN ('approve', 'reject', 'request_edit')),
  reason       TEXT        CHECK (reason IS NULL OR char_length(reason) <= 500),
  content_hash TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_proposal_responses_reason_required
    CHECK (decision = 'approve' OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_settlement_proposal_responses_proposal_created_at
  ON public.settlement_proposal_responses (proposal_id, created_at);

DROP TRIGGER IF EXISTS trg_01_settlement_proposals_set_updated_at ON public.settlement_proposals;
CREATE TRIGGER trg_01_settlement_proposals_set_updated_at
  BEFORE UPDATE ON public.settlement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
ALTER TABLE public.settlement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_proposal_responses ENABLE ROW LEVEL SECURITY;

-- Trip members see and create proposals for their trips.
DROP POLICY IF EXISTS settlement_proposals_select_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_select_member ON public.settlement_proposals
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips t
     WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
  ));

DROP POLICY IF EXISTS settlement_proposals_insert_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_insert_member ON public.settlement_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    creator_wallet = public.current_wallet()
    AND status = 'open'
    AND EXISTS (
      SELECT 1 FROM public.trips t
       WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
    )
  );

-- Members may move an open proposal to superseded/invalidated (proposing again,
-- or recording a detected material change); only the creator may revoke.
-- The snapshot and hash themselves are frozen by the trigger below.
DROP POLICY IF EXISTS settlement_proposals_update_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_update_member ON public.settlement_proposals
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips t
     WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
  ))
  WITH CHECK (status <> 'revoked' OR creator_wallet = public.current_wallet());

CREATE OR REPLACE FUNCTION public.freeze_settlement_proposal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.creator_wallet IS DISTINCT FROM OLD.creator_wallet
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'A settlement proposal snapshot is frozen; propose again instead.'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Only an open proposal can change status.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_00_settlement_proposals_freeze ON public.settlement_proposals;
CREATE TRIGGER trg_00_settlement_proposals_freeze
  BEFORE UPDATE ON public.settlement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.freeze_settlement_proposal();

DROP POLICY IF EXISTS settlement_proposal_responses_select_member ON public.settlement_proposal_responses;
CREATE POLICY settlement_proposal_responses_select_member ON public.settlement_proposal_responses
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.settlement_proposals p
      JOIN public.trips t ON t.id::TEXT = p.trip_id
     WHERE p.id = proposal_id AND public.current_wallet() = ANY (t.member_wallets)
  ));

-- A member answers only for themselves, and only an open proposal.
DROP POLICY IF EXISTS settlement_proposal_responses_insert_self ON public.settlement_proposal_responses;
CREATE POLICY settlement_proposal_responses_insert_self ON public.settlement_proposal_responses
  FOR INSERT TO authenticated
  WITH CHECK (
    wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.settlement_proposals p
        JOIN public.trips t ON t.id::TEXT = p.trip_id
       WHERE p.id = proposal_id
         AND p.status = 'open'
         AND p.expires_at > NOW()
         AND p.content_hash = settlement_proposal_responses.content_hash
         AND public.current_wallet() = ANY (t.member_wallets)
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.settlement_proposals TO authenticated;
GRANT SELECT, INSERT ON public.settlement_proposal_responses TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0014', '0014_settlement_proposals', 'settlement_proposals_v1')
ON CONFLICT (version) DO NOTHING;
