-- 0019_expense_corrections_and_voids.sql
-- #316: Add reversals and corrections instead of destructive edits
-- Financial history should remain understandable after a mistake.
-- Replace the temptation to mutate or delete settled data with linked correction records.

-- 1. Add void and linked-correction columns to public.expenses
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_wallet TEXT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS correction_of_expense_id UUID REFERENCES public.expenses(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS correction_type TEXT,
  ADD COLUMN IF NOT EXISTS correction_reason TEXT;

-- 2. Constraints for voided and linked-correction fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_void_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_void_check CHECK (
        (voided = FALSE AND void_reason IS NULL AND voided_at IS NULL AND voided_by_wallet IS NULL) OR
        (voided = TRUE AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 1 AND 1000 AND voided_at IS NOT NULL AND voided_by_wallet IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_correction_type_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_correction_type_check CHECK (
        correction_type IS NULL OR correction_type IN ('reversal', 'adjustment', 'offset')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_correction_link_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_correction_link_check CHECK (
        (correction_of_expense_id IS NULL AND correction_type IS NULL AND correction_reason IS NULL) OR
        (correction_of_expense_id IS NOT NULL AND correction_type IS NOT NULL AND correction_reason IS NOT NULL AND char_length(btrim(correction_reason)) BETWEEN 1 AND 1000)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_no_self_correction_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_no_self_correction_check CHECK (
        correction_of_expense_id IS NULL OR correction_of_expense_id <> id
      );
  END IF;
END $$;

-- 3. Indexes for fast lookup of voided expenses and linked correction chains
CREATE INDEX IF NOT EXISTS idx_expenses_voided
  ON public.expenses (voided) WHERE voided = TRUE;
CREATE INDEX IF NOT EXISTS idx_expenses_correction_of
  ON public.expenses (correction_of_expense_id) WHERE correction_of_expense_id IS NOT NULL;

-- 4. Immutable append-only audit event log for void and correction events
CREATE TABLE IF NOT EXISTS public.expense_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('voided', 'correction_created', 'reversal_created', 'adjustment_created')),
  actor_wallet TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_audit_events_expense_id
  ON public.expense_audit_events (expense_id, created_at DESC);

-- 5. Prevent destructive mutations on settled data and frozen voided rows
CREATE OR REPLACE FUNCTION public.prevent_destructive_expense_operations()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  v_is_settled BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_is_settled := OLD.settled OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.shares) s
      WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
        OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
    );
    IF v_is_settled THEN
      RAISE EXCEPTION 'A settled expense cannot be deleted. Use a linked correction or offset to preserve financial history.' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.expenses WHERE correction_of_expense_id = OLD.id) THEN
      RAISE EXCEPTION 'An expense with linked corrections cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A voided expense is completely frozen
    IF OLD.voided = TRUE THEN
      IF NEW.title IS DISTINCT FROM OLD.title
        OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.split_mode IS DISTINCT FROM OLD.split_mode
        OR NEW.paid_by_member_id IS DISTINCT FROM OLD.paid_by_member_id
        OR NEW.members IS DISTINCT FROM OLD.members
        OR NEW.shares IS DISTINCT FROM OLD.shares
        OR NEW.settled IS DISTINCT FROM OLD.settled
        OR NEW.voided IS DISTINCT FROM OLD.voided
        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
        RAISE EXCEPTION 'A voided expense is immutable.' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Voiding an unsettled expense transition check
    IF NEW.voided = TRUE AND OLD.voided = FALSE THEN
      v_is_settled := OLD.settled OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.shares) s
        WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
          OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
      );
      IF v_is_settled THEN
        RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Settled expenses cannot have their financial facts mutated in place
    v_is_settled := OLD.settled OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.shares) s
      WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
        OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
    );
    IF v_is_settled AND NEW.voided = FALSE THEN
      IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.split_mode IS DISTINCT FROM OLD.split_mode
        OR NEW.paid_by_member_id IS DISTINCT FROM OLD.paid_by_member_id
        OR NEW.members IS DISTINCT FROM OLD.members
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.settlement_asset IS DISTINCT FROM OLD.settlement_asset THEN
        RAISE EXCEPTION 'Settled expenses cannot be mutated in place; create a linked correction instead.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_prevent_destructive_expense_ops ON public.expenses;
CREATE TRIGGER trg_prevent_destructive_expense_ops
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_destructive_expense_operations();

-- 6. Freeze audit events table as append-only
CREATE OR REPLACE FUNCTION public.freeze_expense_audit_events()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'Expense audit events are append-only.' USING ERRCODE = '42501';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_expense_audit_events_freeze ON public.expense_audit_events;
CREATE TRIGGER trg_expense_audit_events_freeze
  BEFORE UPDATE OR DELETE ON public.expense_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_audit_events();

-- 7. Trigger to automatically record audit events on void or correction creation
CREATE OR REPLACE FUNCTION public.record_expense_correction_audit_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.voided = TRUE AND OLD.voided = FALSE THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (
      NEW.id,
      'voided',
      NEW.voided_by_wallet,
      NEW.void_reason,
      jsonb_build_object('total_amount', NEW.total_amount, 'voided_at', NEW.voided_at)
    );
  ELSIF TG_OP = 'INSERT' AND NEW.correction_of_expense_id IS NOT NULL THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (
      NEW.id,
      CASE WHEN NEW.correction_type = 'reversal' THEN 'reversal_created' ELSE 'adjustment_created' END,
      NEW.created_by_wallet,
      NEW.correction_reason,
      jsonb_build_object(
        'correction_of_expense_id', NEW.correction_of_expense_id,
        'correction_type', NEW.correction_type,
        'total_amount', NEW.total_amount
      )
    );
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_expense_correction_audit ON public.expenses;
CREATE TRIGGER trg_expense_correction_audit
  AFTER INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.record_expense_correction_audit_event();

-- 8. Atomic void_expense RPC function
CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS public.expenses LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE
  v_expense public.expenses%ROWTYPE;
  v_caller TEXT;
  v_trimmed_reason TEXT;
  v_is_settled BOOLEAN;
  v_is_authorized BOOLEAN;
BEGIN
  v_trimmed_reason := btrim(COALESCE(p_reason, ''));
  IF char_length(v_trimmed_reason) < 1 OR char_length(v_trimmed_reason) > 1000 THEN
    RAISE EXCEPTION 'A void reason between 1 and 1000 characters is required.' USING ERRCODE = '22023';
  END IF;

  v_caller := public.current_wallet();
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_expense FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_expense.voided THEN
    RAISE EXCEPTION 'Expense is already voided.' USING ERRCODE = '42501';
  END IF;

  -- Check permissions: caller is creator, payer, or has expenses.manage permission
  v_is_authorized := (
    upper(v_expense.created_by_wallet) = upper(v_caller)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_expense.members) m
      WHERE m->>'id' = v_expense.paid_by_member_id AND upper(m->>'walletAddress') = upper(v_caller)
    )
    OR public.expense_has_permission(p_expense_id, 'expenses.manage')
  );
  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'You are not authorized to void this expense.' USING ERRCODE = '42501';
  END IF;

  -- Check settled status
  v_is_settled := v_expense.settled OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_expense.shares) s
    WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
      OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
  );
  IF v_is_settled THEN
    RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.expenses
  SET voided = TRUE,
      voided_at = NOW(),
      voided_by_wallet = v_caller,
      void_reason = v_trimmed_reason,
      updated_at = NOW()
  WHERE id = p_expense_id
  RETURNING * INTO v_expense;

  RETURN v_expense;
END;
$fn$;

-- 9. Row level security and permissions
ALTER TABLE public.expense_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_audit_events_select_members ON public.expense_audit_events;
CREATE POLICY expense_audit_events_select_members ON public.expense_audit_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_id
        AND (public.current_wallet() = ANY(e.member_wallets) OR upper(e.created_by_wallet) = upper(public.current_wallet()))
    )
  );

DROP POLICY IF EXISTS expense_audit_events_insert_system ON public.expense_audit_events;
CREATE POLICY expense_audit_events_insert_system ON public.expense_audit_events
  FOR INSERT TO authenticated
  WITH CHECK (upper(actor_wallet) = upper(public.current_wallet()));

GRANT SELECT, INSERT ON public.expense_audit_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.prevent_destructive_expense_operations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_audit_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_expense_correction_audit_event() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_expense_corrections_and_voids', 'expense_corrections_and_voids_v1')
ON CONFLICT (version) DO NOTHING;
