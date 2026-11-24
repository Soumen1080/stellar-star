-- #329 Disputes are off-chain review state. They never rewrite expenses,
-- installments, transaction hashes, or contract events.
CREATE TABLE IF NOT EXISTS public.expense_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id TEXT NOT NULL,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  share_member_id TEXT NOT NULL,
  opened_by_wallet TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('incorrect_amount','incorrect_split','not_shared','duplicate','already_paid','missing_context','other')),
  comment TEXT NOT NULL CHECK (char_length(btrim(comment)) BETWEEN 1 AND 2000),
  -- References to private receipt records only; raw evidence is never public.
  evidence_receipt_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[] CHECK (cardinality(evidence_receipt_ids) <= 5),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT expense_disputes_resolution_state CHECK ((status = 'open' AND resolved_at IS NULL) OR (status IN ('upheld','resolved') AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_disputes_one_open_per_share
  ON public.expense_disputes (expense_id, share_member_id) WHERE status IN ('open','upheld');
CREATE INDEX IF NOT EXISTS expense_disputes_trip_created ON public.expense_disputes (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.expense_dispute_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES public.expense_disputes(id) ON DELETE RESTRICT,
  actor_wallet TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('opened','upheld','dismissed','adjusted')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expense_dispute_events_dispute_created ON public.expense_dispute_events (dispute_id, created_at);

CREATE OR REPLACE FUNCTION public.record_expense_dispute_opened()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.expense_dispute_events (dispute_id, actor_wallet, action, reason)
    VALUES (NEW.id, NEW.opened_by_wallet, 'opened', NEW.comment);
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_opened_event ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_opened_event AFTER INSERT ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.record_expense_dispute_opened();

ALTER TABLE public.expense_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_dispute_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_disputes_select_members ON public.expense_disputes;
CREATE POLICY expense_disputes_select_members ON public.expense_disputes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trips t WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY(t.member_wallets)));
DROP POLICY IF EXISTS expense_disputes_insert_subject_member ON public.expense_disputes;
CREATE POLICY expense_disputes_insert_subject_member ON public.expense_disputes FOR INSERT TO authenticated
  WITH CHECK (opened_by_wallet = public.current_wallet()
    AND status = 'open' AND resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id
      AND public.current_wallet() = ANY(e.member_wallets)
      AND e.members @> jsonb_build_array(jsonb_build_object('id', share_member_id))
      AND e.shares @> jsonb_build_array(jsonb_build_object('memberId', share_member_id))
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.members) m WHERE m->>'id' = share_member_id AND upper(m->>'walletAddress') = upper(public.current_wallet()))));

CREATE OR REPLACE FUNCTION public.validate_expense_dispute_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE receipt_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.expenses e, jsonb_array_elements(e.shares) s
    WHERE e.id = NEW.expense_id AND s->>'memberId' = NEW.share_member_id
      AND COALESCE((s->>'paid')::BOOLEAN, FALSE) = FALSE) THEN
    RAISE EXCEPTION 'Only an unpaid share can be disputed.' USING ERRCODE = '42501';
  END IF;
  FOREACH receipt_id IN ARRAY NEW.evidence_receipt_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.expense_receipts r WHERE r.id = receipt_id
      AND r.expense_id = NEW.expense_id AND r.status = 'active'
      AND (r.uploaded_by_wallet = public.current_wallet()
        OR public.expense_has_permission(NEW.expense_id, 'receipts.manage'))) THEN
      RAISE EXCEPTION 'Evidence must reference an active private receipt available to you for this expense.' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_evidence ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_evidence BEFORE INSERT ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_dispute_evidence();

-- Only trip owners/organizers with expense management permission may resolve.
DROP POLICY IF EXISTS expense_disputes_update_resolver ON public.expense_disputes;
CREATE POLICY expense_disputes_update_resolver ON public.expense_disputes FOR UPDATE TO authenticated
  USING (public.expense_has_permission(expense_id, 'expenses.manage'))
  WITH CHECK (public.expense_has_permission(expense_id, 'expenses.manage') AND status IN ('upheld','resolved') AND resolved_at IS NOT NULL);

DROP POLICY IF EXISTS expense_dispute_events_select_members ON public.expense_dispute_events;
CREATE POLICY expense_dispute_events_select_members ON public.expense_dispute_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expense_disputes d JOIN public.trips t ON t.id::TEXT = d.trip_id
    WHERE d.id = dispute_id AND public.current_wallet() = ANY(t.member_wallets)));
DROP POLICY IF EXISTS expense_dispute_events_insert_actor ON public.expense_dispute_events;
CREATE POLICY expense_dispute_events_insert_actor ON public.expense_dispute_events FOR INSERT TO authenticated
  WITH CHECK (actor_wallet = public.current_wallet() AND EXISTS (
    SELECT 1 FROM public.expense_disputes d WHERE d.id = dispute_id AND d.status = 'open'
      AND ((action = 'opened' AND d.opened_by_wallet = public.current_wallet())
        OR (action <> 'opened' AND public.expense_has_permission(d.expense_id, 'expenses.manage')))));

-- Resolution event + state transition are atomic; a resolved state can never
-- exist without its action and reason in the append-only event log.
CREATE OR REPLACE FUNCTION public.resolve_expense_dispute(p_dispute_id UUID, p_action TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE d public.expense_disputes%ROWTYPE;
BEGIN
  IF p_action NOT IN ('upheld','dismissed','adjusted') OR char_length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'A valid resolution action and reason are required.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM public.expense_disputes WHERE id = p_dispute_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND OR NOT public.expense_has_permission(d.expense_id, 'expenses.manage') THEN
    RAISE EXCEPTION 'You are not allowed to resolve this dispute.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.expense_dispute_events (dispute_id, actor_wallet, action, reason)
    VALUES (d.id, public.current_wallet(), p_action, btrim(p_reason));
  UPDATE public.expense_disputes SET status = CASE WHEN p_action = 'upheld' THEN 'upheld' ELSE 'resolved' END,
    resolved_at = NOW() WHERE id = d.id;
END; $fn$;

CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Disputes are retained as an audit record.' USING ERRCODE = '42501'; END IF;
  IF NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
    OR NEW.share_member_id IS DISTINCT FROM OLD.share_member_id OR NEW.opened_by_wallet IS DISTINCT FROM OLD.opened_by_wallet
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.comment IS DISTINCT FROM OLD.comment
    OR NEW.evidence_receipt_ids IS DISTINCT FROM OLD.evidence_receipt_ids
    OR OLD.status <> 'open' OR NEW.status NOT IN ('upheld','resolved') OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'Disputes are immutable; resolution must be recorded as an event.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_freeze ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_freeze BEFORE UPDATE OR DELETE ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_dispute_history();

CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_events()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'Dispute events are append-only.' USING ERRCODE = '42501'; END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_events_freeze ON public.expense_dispute_events;
CREATE TRIGGER trg_expense_dispute_events_freeze BEFORE UPDATE OR DELETE ON public.expense_dispute_events
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_dispute_events();

GRANT SELECT, INSERT, UPDATE ON public.expense_disputes TO authenticated;
GRANT SELECT, INSERT ON public.expense_dispute_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_expense_dispute(UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.validate_expense_dispute_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_dispute_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_dispute_events() FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0018', '0018_expense_disputes', 'expense_disputes_v1')
ON CONFLICT (version) DO NOTHING;
