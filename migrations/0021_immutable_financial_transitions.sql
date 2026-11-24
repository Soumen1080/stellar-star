-- ============================================================================
-- Stellar-Star Migration 0021: Immutable Financial Transitions (#479)
-- ============================================================================
-- Rollback: forward-only: Financial audit trail and balance transitions.
--
-- Issue #479: one database enforced path for changes to expense balances.
-- The legacy RPC bodies are retained privately; public wrappers set a
-- transaction-local capability which direct REST/RLS writes cannot set.

CREATE TABLE IF NOT EXISTS public.financial_transition_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  actor_wallet TEXT,
  transition TEXT NOT NULL CHECK (transition IN ('settlement','correction')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_transition_events_expense_time
  ON public.financial_transition_events(expense_id, created_at, id);
ALTER TABLE public.financial_transition_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_transition_events_select_members ON public.financial_transition_events;
CREATE POLICY financial_transition_events_select_members ON public.financial_transition_events
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.expenses e WHERE e.id = expense_id
      AND public.current_wallet() = ANY(e.member_wallets)
  ));
GRANT SELECT ON public.financial_transition_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.financial_transition_events FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_financial_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'Financial transition events are append-only.' USING ERRCODE='42501'; END;
$fn$;
DROP TRIGGER IF EXISTS financial_transition_events_append_only ON public.financial_transition_events;
CREATE TRIGGER financial_transition_events_append_only
  BEFORE UPDATE OR DELETE ON public.financial_transition_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_financial_event_mutation();

-- Proof/attestation metadata can be refreshed without changing who owes what
-- or which transaction paid it. Keep those updates usable without treating
-- them as a financial transition.
CREATE OR REPLACE FUNCTION public.financial_share_state(p_shares JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $fn$
  SELECT COALESCE(jsonb_agg(
    (s.share - ARRAY['verified','onChain','attestationNonce','ledger'])
    || CASE WHEN s.share ? 'installments' THEN jsonb_build_object('installments',
      COALESCE((SELECT jsonb_agg(i.item - ARRAY['verified','onChain','attestationNonce','ledger'] ORDER BY i.ordinal)
        FROM jsonb_array_elements(s.share->'installments') WITH ORDINALITY AS i(item,ordinal)), '[]'::jsonb))
      ELSE '{}'::jsonb END ORDER BY s.ordinal), '[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_shares,'[]'::jsonb)) WITH ORDINALITY AS s(share,ordinal)
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_financial_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
  v_reason TEXT := current_setting('app.finance_reason', true);
  v_kind TEXT := current_setting('app.finance_transition', true);
  v_sum NUMERIC;
  v_all_paid BOOLEAN;
  v_old JSONB;
  v_new JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_old := jsonb_build_object('shares','[]'::jsonb,'settled',false);
  ELSE
    v_old := jsonb_build_object('shares',OLD.shares,'settled',OLD.settled);
  END IF;
  v_new := jsonb_build_object('shares',NEW.shares,'settled',NEW.settled);

  IF TG_OP = 'UPDATE' AND (public.financial_share_state(NEW.shares) IS DISTINCT FROM public.financial_share_state(OLD.shares)
      OR NEW.settled IS DISTINCT FROM OLD.settled) THEN
    IF v_kind NOT IN ('settlement','correction') OR char_length(btrim(COALESCE(v_reason,''))) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'Share balances and settled state must change through a financial transition.' USING ERRCODE='42501';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    v_kind := 'correction';
    v_reason := 'expense created';
  ELSE
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.shares) <> 'array' OR jsonb_array_length(NEW.shares) = 0 THEN
    IF NEW.settled THEN RAISE EXCEPTION 'An expense without shares cannot be settled.' USING ERRCODE='23514'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.shares) s
      WHERE COALESCE(s->>'memberId','') = '' OR COALESCE(s->>'amount','') !~ '^[0-9]+([.][0-9]+)?$') THEN
      RAISE EXCEPTION 'Every share requires a member and non-negative decimal amount.' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.shares) s) <>
       (SELECT count(DISTINCT s->>'memberId') FROM jsonb_array_elements(NEW.shares) s) THEN
      RAISE EXCEPTION 'A member may have only one share per expense.' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum((s->>'amount')::numeric),0), bool_and(COALESCE((s->>'paid')::boolean,false))
      INTO v_sum,v_all_paid FROM jsonb_array_elements(NEW.shares) s;
    IF v_sum <> NEW.total_amount::numeric THEN
      RAISE EXCEPTION 'Share total (%) must equal expense total (%).',v_sum,NEW.total_amount USING ERRCODE='23514';
    END IF;
    IF NEW.settled IS DISTINCT FROM v_all_paid THEN
      RAISE EXCEPTION 'Expense settled state must match all share states.' USING ERRCODE='23514';
    END IF;
  END IF;

  IF TG_OP='UPDATE' THEN
    INSERT INTO public.financial_transition_events(expense_id,actor_wallet,transition,reason,before_state,after_state)
    VALUES (NEW.id,public.current_wallet(),v_kind,btrim(v_reason),v_old,v_new);
  END IF;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS expenses_financial_transition ON public.expenses;
CREATE TRIGGER expenses_financial_transition BEFORE INSERT OR UPDATE OF shares,settled ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_financial_transition();

-- Versioned edits remain available for descriptive/member fields; finance edits
-- must use record_financial_correction with a reviewable reason.
ALTER FUNCTION public.update_expense_versioned(UUID,INT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,BOOLEAN)
  RENAME TO update_expense_versioned_finance_legacy;
CREATE OR REPLACE FUNCTION public.update_expense_versioned(
  p_id UUID,p_expected_version INT,p_title TEXT,p_description TEXT,p_total_amount TEXT,p_currency TEXT,
  p_split_mode TEXT,p_paid_by_member_id TEXT,p_members JSONB,p_shares JSONB,p_settled BOOLEAN
) RETURNS SETOF public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF p_shares IS NOT NULL OR p_settled IS NOT NULL THEN
    IF p_shares IS NULL THEN
      RAISE EXCEPTION 'Settlement state is derived from the shares and cannot be set directly.' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('app.finance_transition','correction',true);
    PERFORM set_config('app.finance_reason','Expense split corrected through versioned edit',true);
  END IF;
  RETURN QUERY SELECT * FROM public.update_expense_versioned_finance_legacy(
    p_id,p_expected_version,p_title,p_description,p_total_amount,p_currency,p_split_mode,
    p_paid_by_member_id,p_members,p_shares,NULL);
END; $fn$;
REVOKE ALL ON FUNCTION public.update_expense_versioned_finance_legacy(UUID,INT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.update_expense_versioned(UUID,INT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID,INT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_financial_correction(p_expense_id UUID,p_shares JSONB,p_reason TEXT)
RETURNS SETOF public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF NOT public.expense_has_permission(p_expense_id,'expenses.manage') THEN
    RAISE EXCEPTION 'EXPENSE_UPDATE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_shares)<>'array' OR char_length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'A share array and correction reason are required.' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.finance_transition','correction',true);
  PERFORM set_config('app.finance_reason',btrim(p_reason),true);
  RETURN QUERY UPDATE public.expenses SET shares=p_shares,
    settled=COALESCE((SELECT bool_and(COALESCE((s->>'paid')::boolean,false)) FROM jsonb_array_elements(p_shares) s),false),
    version=version+1 WHERE id=p_expense_id RETURNING *;
END; $fn$;
GRANT EXECUTE ON FUNCTION public.record_financial_correction(UUID,JSONB,TEXT) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_financial_correction(UUID,JSONB,TEXT) FROM PUBLIC,anon;

-- Wrap established row-locking RPCs with a narrow, transaction-local capability.
ALTER FUNCTION public.mark_share_paid(UUID,TEXT,TEXT,BOOLEAN) RENAME TO mark_share_paid_finance_legacy;
CREATE OR REPLACE FUNCTION public.mark_share_paid(p_expense_id UUID,p_member_id TEXT,p_tx_hash TEXT,p_on_chain BOOLEAN DEFAULT true)
RETURNS SETOF public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF p_tx_hash IS NULL OR p_tx_hash !~* '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'A 64-character Stellar transaction hash is required.' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.finance_transition','settlement',true);
  PERFORM set_config('app.finance_reason','share payment recorded',true);
  RETURN QUERY SELECT * FROM public.mark_share_paid_finance_legacy(p_expense_id,p_member_id,p_tx_hash,p_on_chain);
END; $fn$;
REVOKE ALL ON FUNCTION public.mark_share_paid_finance_legacy(UUID,TEXT,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID,TEXT,TEXT,BOOLEAN) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.mark_share_paid(UUID,TEXT,TEXT,BOOLEAN) FROM PUBLIC,anon;

ALTER FUNCTION public.record_share_installment(UUID,TEXT,JSONB) RENAME TO record_share_installment_finance_legacy;
CREATE OR REPLACE FUNCTION public.record_share_installment(p_expense_id UUID,p_member_id TEXT,p_installment JSONB)
RETURNS SETOF public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  PERFORM set_config('app.finance_transition','settlement',true);
  PERFORM set_config('app.finance_reason','share installment recorded',true);
  RETURN QUERY SELECT * FROM public.record_share_installment_finance_legacy(p_expense_id,p_member_id,p_installment);
END; $fn$;
REVOKE ALL ON FUNCTION public.record_share_installment_finance_legacy(UUID,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_share_installment(UUID,TEXT,JSONB) TO authenticated,service_role;
REVOKE ALL ON FUNCTION public.record_share_installment(UUID,TEXT,JSONB) FROM PUBLIC,anon;

-- Settlement intents are also state machines. Keep retries possible after a
-- failed submission while preventing edits to the debt or replay identity.
CREATE TABLE IF NOT EXISTS public.settlement_intent_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES public.settlement_intents(id) ON DELETE RESTRICT,
  actor_wallet TEXT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.settlement_intent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlement_intent_events_select_party ON public.settlement_intent_events
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.settlement_intents i WHERE i.id=intent_id
      AND public.current_wallet() IN (i.member_wallet,i.payer_wallet)
  ));
GRANT SELECT ON public.settlement_intent_events TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.settlement_intent_events FROM anon,authenticated;
CREATE TRIGGER settlement_intent_events_append_only
  BEFORE UPDATE OR DELETE ON public.settlement_intent_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_financial_event_mutation();

CREATE OR REPLACE FUNCTION public.guard_settlement_intent_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Settlement intents are retained as financial evidence.' USING ERRCODE='42501';
  END IF;
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
    OR NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.payer_wallet IS DISTINCT FROM OLD.payer_wallet OR NEW.member_wallet IS DISTINCT FROM OLD.member_wallet
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_by_wallet IS DISTINCT FROM OLD.created_by_wallet THEN
    RAISE EXCEPTION 'Settlement intent debt and idempotency fields are immutable.' USING ERRCODE='42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('submitting','cancelled','failed')) OR
    (OLD.status='submitting' AND NEW.status IN ('submitted','recorded','failed','cancelled')) OR
    (OLD.status='submitted' AND NEW.status IN ('recorded','failed')) OR
    (OLD.status='failed' AND NEW.status IN ('submitting','cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid settlement intent transition: % to %.',OLD.status,NEW.status USING ERRCODE='23514';
  END IF;
  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'A settlement transaction hash is immutable once recorded.' USING ERRCODE='42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    INSERT INTO public.settlement_intent_events(intent_id,actor_wallet,from_status,to_status,tx_hash)
      VALUES (NEW.id,public.current_wallet(),OLD.status,NEW.status,NEW.tx_hash);
  END IF;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS guard_settlement_intent_transition ON public.settlement_intents;
CREATE TRIGGER guard_settlement_intent_transition BEFORE UPDATE OR DELETE ON public.settlement_intents
  FOR EACH ROW EXECUTE FUNCTION public.guard_settlement_intent_transition();

INSERT INTO public.schema_migrations(version,name,checksum)
VALUES('0021','0021_immutable_financial_transitions','immutable_finance_479_v1')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
