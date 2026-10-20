-- ============================================================================
-- Stellar-star Migration 0012: Partial settlement installments (issue #325)
-- ============================================================================
-- A share can now be settled over several on-chain payments. Each payment is
-- appended to the share's `installments` array inside `expenses.shares`; the
-- share flips to `paid` only when the installments sum to exactly what it owes.
--
-- `record_share_installment` is the only write path, and it is atomic:
--   * `SELECT ... FOR UPDATE` serializes concurrent installments on one expense,
--     so two payments racing for the same remaining balance cannot both fit.
--   * Amounts are compared in integer stroops (NUMERIC, never float).
--   * An installment that would exceed the remaining balance is rejected with
--     SQLSTATE 23514 (check_violation). There is no implicit credit.
--   * Re-recording a transaction hash already on the share is a no-op, which
--     keeps retry-after-submit and cross-device reconciliation idempotent.
--
-- Every statement is idempotent. Existing shares are untouched: a share with
-- no `installments` key behaves exactly as before.

CREATE OR REPLACE FUNCTION public.record_share_installment(
  p_expense_id  UUID,
  p_member_id   TEXT,
  p_installment JSONB
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_expense        public.expenses;
  v_shares         JSONB;
  v_share          JSONB;
  v_updated_shares JSONB := '[]'::jsonb;
  v_installments   JSONB;
  v_tx_hash        TEXT;
  v_amount_stroops NUMERIC;
  v_owed_stroops   NUMERIC;
  v_paid_stroops   NUMERIC;
  v_found          BOOLEAN := false;
  v_duplicate      BOOLEAN := false;
  v_all_paid       BOOLEAN := true;
  v_len            INT;
  v_idx            INT;
BEGIN
  v_tx_hash := lower(trim(p_installment ->> 'txHash'));
  IF v_tx_hash IS NULL OR v_tx_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Installment txHash must be a 64-character hex transaction hash'
      USING ERRCODE = '22023';
  END IF;

  IF (p_installment ->> 'amountStroops') IS NULL
     OR (p_installment ->> 'amountStroops') !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'Installment amountStroops must be a non-negative integer string'
      USING ERRCODE = '22023';
  END IF;
  v_amount_stroops := (p_installment ->> 'amountStroops')::NUMERIC;
  IF v_amount_stroops <= 0 THEN
    RAISE EXCEPTION 'Installment amount must be greater than zero' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
  END IF;

  -- Only a member of the expense may record a payment against it.
  IF public.current_wallet() IS NULL
     OR NOT (public.current_wallet() = ANY (v_expense.member_wallets)) THEN
    RAISE EXCEPTION 'Not a member of this expense' USING ERRCODE = '42501';
  END IF;

  v_shares := COALESCE(v_expense.shares, '[]'::jsonb);
  v_len := jsonb_array_length(v_shares);

  FOR v_idx IN 0..(v_len - 1) LOOP
    v_share := v_shares -> v_idx;

    IF (v_share ->> 'memberId') = p_member_id THEN
      v_found := true;
      v_installments := COALESCE(v_share -> 'installments', '[]'::jsonb);

      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_installments) AS i
         WHERE lower(i ->> 'txHash') = v_tx_hash
      ) THEN
        v_duplicate := true;
      ELSE
        IF COALESCE((v_share ->> 'paid')::boolean, false) THEN
          RAISE EXCEPTION 'Share is already fully settled' USING ERRCODE = '23514';
        END IF;

        v_owed_stroops := (v_share ->> 'amount')::NUMERIC * 10000000;
        SELECT COALESCE(SUM((i ->> 'amountStroops')::NUMERIC), 0)
          INTO v_paid_stroops
          FROM jsonb_array_elements(v_installments) AS i;

        IF v_paid_stroops + v_amount_stroops > v_owed_stroops THEN
          RAISE EXCEPTION 'OVERPAYMENT: installment of % stroops exceeds remaining % stroops',
            v_amount_stroops, v_owed_stroops - v_paid_stroops
            USING ERRCODE = '23514';
        END IF;

        v_paid_stroops := v_paid_stroops + v_amount_stroops;
        v_installments := v_installments || jsonb_build_array(
          p_installment || jsonb_build_object('txHash', v_tx_hash)
        );
        v_share := v_share || jsonb_build_object(
          'installments', v_installments,
          'paidStroops', v_paid_stroops::TEXT,
          'paid', v_paid_stroops = v_owed_stroops
        );
        IF v_paid_stroops = v_owed_stroops THEN
          v_share := v_share || jsonb_build_object('txHash', v_tx_hash);
        END IF;
      END IF;
    END IF;

    IF NOT COALESCE((v_share ->> 'paid')::boolean, false) THEN
      v_all_paid := false;
    END IF;

    v_updated_shares := v_updated_shares || jsonb_build_array(v_share);
  END LOOP;

  IF NOT v_found THEN
    RAISE EXCEPTION 'Share not found on this expense' USING ERRCODE = 'P0002';
  END IF;

  IF v_duplicate THEN
    RETURN QUERY SELECT * FROM public.expenses WHERE id = p_expense_id;
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.expenses
     SET shares = v_updated_shares,
         settled = v_all_paid,
         version = version + 1
   WHERE id = p_expense_id
   RETURNING *;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.record_share_installment(UUID, TEXT, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0012', '0012_share_installments', 'share_installments_v1')
ON CONFLICT (version) DO NOTHING;
