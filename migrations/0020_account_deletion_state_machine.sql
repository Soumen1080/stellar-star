-- Durable and resumable account erasure (#478). Only opaque operational
-- evidence is retained; user content is purged and financial history stays intact.
CREATE TABLE IF NOT EXISTS public.account_legal_holds (
  wallet_address TEXT PRIMARY KEY CHECK (wallet_address = upper(btrim(wallet_address))),
  hold_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);
ALTER TABLE public.account_legal_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_legal_holds FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_legal_holds TO service_role;

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','held','erasing','retryable_error','completed')),
  current_step TEXT,
  completed_steps TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_deletion_requests TO service_role;

CREATE TABLE IF NOT EXISTS public.account_deletion_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.account_deletion_requests(id) ON DELETE RESTRICT,
  step TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started','completed','held','retryable_error')),
  counts JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.account_deletion_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletion_evidence FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_deletion_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.begin_account_deletion(p_wallet TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_wallet TEXT := upper(btrim(p_wallet)); v_request public.account_deletion_requests%ROWTYPE; v_held BOOLEAN;
BEGIN
  IF v_wallet IS NULL OR v_wallet = '' THEN RAISE EXCEPTION 'wallet is required' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.deleted_accounts(wallet_address, deleted_at, reason)
  VALUES (v_wallet, NOW(), 'user_request') ON CONFLICT(wallet_address) DO NOTHING;
  INSERT INTO public.account_deletion_requests(wallet_address)
  VALUES (v_wallet) ON CONFLICT(wallet_address) DO UPDATE SET updated_at = NOW()
  RETURNING * INTO v_request;
  SELECT EXISTS (SELECT 1 FROM public.account_legal_holds WHERE wallet_address = v_wallet AND released_at IS NULL) INTO v_held;
  IF v_request.state = 'completed' THEN RETURN jsonb_build_object('request_id', v_request.id, 'state', 'completed'); END IF;
  IF v_held THEN
    UPDATE public.account_deletion_requests SET state = 'held', current_step = 'legal_hold', updated_at = NOW() WHERE id = v_request.id;
    INSERT INTO public.account_deletion_evidence(request_id, step, outcome) VALUES (v_request.id, 'legal_hold', 'held');
    RETURN jsonb_build_object('request_id', v_request.id, 'state', 'held');
  END IF;
  UPDATE public.account_deletion_requests SET state = 'erasing', current_step = NULL, updated_at = NOW() WHERE id = v_request.id;
  INSERT INTO public.account_deletion_evidence(request_id, step, outcome) VALUES (v_request.id, 'deletion', 'started');
  RETURN jsonb_build_object('request_id', v_request.id, 'state', 'erasing', 'completed_steps', to_jsonb(v_request.completed_steps));
END; $fn$;

CREATE OR REPLACE FUNCTION public.record_account_deletion_step(p_request_id UUID, p_step TEXT, p_counts JSONB DEFAULT '{}'::JSONB, p_complete BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE public.account_deletion_requests
     SET completed_steps = CASE WHEN p_step = ANY(completed_steps) THEN completed_steps ELSE array_append(completed_steps, p_step) END,
         current_step = CASE WHEN p_complete THEN NULL ELSE p_step END,
         state = CASE WHEN p_complete THEN 'completed' ELSE 'erasing' END,
         completed_at = CASE WHEN p_complete THEN COALESCE(completed_at, NOW()) ELSE NULL END,
         updated_at = NOW()
   WHERE id = p_request_id AND state IN ('erasing','retryable_error');
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion request is not active' USING ERRCODE = '55000'; END IF;
  INSERT INTO public.account_deletion_evidence(request_id, step, outcome, counts)
  VALUES (p_request_id, p_step, 'completed', COALESCE(p_counts, '{}'::JSONB));
END; $fn$;

CREATE OR REPLACE FUNCTION public.fail_account_deletion(p_request_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.account_deletion_requests SET state = 'retryable_error', updated_at = NOW()
   WHERE id = p_request_id AND state <> 'completed';
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_account_background_work(p_wallet TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_wallet TEXT := upper(btrim(p_wallet)); v_schedules INT := 0; v_templates INT := 0; v_drafts INT := 0; v_reminders INT := 0; v_hooks INT := 0; v_outbox INT := 0;
BEGIN
  UPDATE public.reminder_schedules SET active = FALSE, updated_at = NOW() WHERE upper(owner_wallet) = v_wallet AND active;
  GET DIAGNOSTICS v_schedules = ROW_COUNT;
  UPDATE public.recurring_expense_templates t
     SET members = (SELECT COALESCE(jsonb_agg(m), '[]'::JSONB) FROM jsonb_array_elements(t.members) m WHERE upper(COALESCE(m->>'walletAddress','')) <> v_wallet),
         updated_at = NOW()
   WHERE upper(t.created_by_wallet) <> v_wallet AND v_wallet = ANY(t.member_wallets);
  DELETE FROM public.expense_drafts WHERE v_wallet = ANY(member_wallets)
     OR template_id IN (SELECT id FROM public.recurring_expense_templates WHERE upper(created_by_wallet) = v_wallet);
  GET DIAGNOSTICS v_drafts = ROW_COUNT;
  DELETE FROM public.recurring_expense_templates WHERE upper(created_by_wallet) = v_wallet;
  GET DIAGNOSTICS v_templates = ROW_COUNT;
  UPDATE public.payment_reminders SET state = 'cancelled', updated_at = NOW() WHERE (upper(sender_wallet) = v_wallet OR upper(recipient_wallet) = v_wallet) AND state NOT IN ('cancelled','dismissed','muted');
  GET DIAGNOSTICS v_reminders = ROW_COUNT;
  DELETE FROM public.webhook_endpoints WHERE upper(wallet_address) = v_wallet;
  GET DIAGNOSTICS v_hooks = ROW_COUNT;
  DELETE FROM public.webhook_outbox WHERE payload::TEXT ILIKE '%' || v_wallet || '%';
  GET DIAGNOSTICS v_outbox = ROW_COUNT;
  DELETE FROM public.idempotency_records WHERE upper(wallet_address) = v_wallet;
  DELETE FROM public.reminder_schedules WHERE upper(owner_wallet) = v_wallet;
  DELETE FROM public.reminder_preferences WHERE upper(wallet) = v_wallet;
  DELETE FROM public.auth_challenges WHERE upper(address) = v_wallet;
  DELETE FROM public.auth_rate_limits WHERE key ILIKE '%' || v_wallet || '%';
  DELETE FROM public.trip_invites WHERE upper(created_by_wallet) = v_wallet;
  DELETE FROM public.payment_reminders WHERE upper(sender_wallet) = v_wallet OR upper(recipient_wallet) = v_wallet;
  DELETE FROM public.trip_templates WHERE upper(owner_wallet) = v_wallet;
  DELETE FROM public.sponsorship_invites WHERE upper(inviter) = v_wallet OR upper(invitee) = v_wallet;
  DELETE FROM public.sponsored_accounts WHERE upper(account_id) = v_wallet;
  UPDATE public.sponsored_accounts SET sponsor = 'FORMER_ACCOUNT' WHERE upper(sponsor) = v_wallet;
  DELETE FROM public.budget_alert_mutes WHERE upper(member_wallet) = v_wallet;
  RETURN jsonb_build_object('schedules', v_schedules, 'templates', v_templates, 'drafts', v_drafts, 'reminders', v_reminders, 'webhooks', v_hooks, 'outbox', v_outbox);
END; $fn$;

CREATE OR REPLACE FUNCTION public.anonymize_account_lawful_logs(p_wallet TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_wallet TEXT := upper(btrim(p_wallet)); v_exports INT := 0; v_reminder_events INT := 0; v_other_logs INT := 0;
BEGIN
  UPDATE public.export_audit_events SET actor_wallet = 'FORMER_ACCOUNT', trip_ids = ARRAY[]::TEXT[], client_ip_hash = NULL WHERE upper(actor_wallet) = v_wallet;
  GET DIAGNOSTICS v_exports = ROW_COUNT;
  UPDATE public.reminder_events SET actor_wallet = 'FORMER_ACCOUNT', detail = NULL WHERE upper(actor_wallet) = v_wallet;
  GET DIAGNOSTICS v_reminder_events = ROW_COUNT;
  UPDATE public.trip_copy_events SET actor_wallet = 'FORMER_ACCOUNT' WHERE upper(actor_wallet) = v_wallet;
  UPDATE public.trip_copy_events SET idempotency_key = 'deleted:' || id::TEXT WHERE idempotency_key ILIKE '%' || v_wallet || '%';
  UPDATE public.trip_role_audit SET changed_by_wallet = 'FORMER_ACCOUNT' WHERE upper(changed_by_wallet) = v_wallet;
  UPDATE public.trip_budgets SET created_by_wallet = 'FORMER_ACCOUNT' WHERE upper(created_by_wallet) = v_wallet;
  UPDATE public.settlement_proposals SET creator_wallet = 'FORMER_ACCOUNT' WHERE upper(creator_wallet) = v_wallet;
  UPDATE public.settlement_proposal_responses SET wallet = 'FORMER_ACCOUNT', reason = CASE WHEN decision = 'approve' THEN NULL ELSE '[redacted on account deletion]' END WHERE upper(wallet) = v_wallet;
  UPDATE public.expense_disputes SET opened_by_wallet = 'FORMER_ACCOUNT', comment = '[redacted on account deletion]' WHERE upper(opened_by_wallet) = v_wallet;
  UPDATE public.expense_dispute_events SET actor_wallet = 'FORMER_ACCOUNT', reason = '[redacted on account deletion]' WHERE upper(actor_wallet) = v_wallet;
  GET DIAGNOSTICS v_other_logs = ROW_COUNT;
  RETURN jsonb_build_object('export_logs', v_exports, 'reminder_logs', v_reminder_events, 'other_logs', v_other_logs);
END; $fn$;

-- A narrow exception allows the service workflow to remove user-authored text
-- from retained dispute evidence without permitting financial state changes.
CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.opened_by_wallet = 'FORMER_ACCOUNT'
    AND NEW.comment = '[redacted on account deletion]'
    AND (to_jsonb(NEW) - 'opened_by_wallet' - 'comment') = (to_jsonb(OLD) - 'opened_by_wallet' - 'comment') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Disputes are immutable except for approved privacy anonymization.' USING ERRCODE = '42501';
END; $fn$;

CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_events()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.actor_wallet = 'FORMER_ACCOUNT'
    AND NEW.reason = '[redacted on account deletion]'
    AND (to_jsonb(NEW) - 'actor_wallet' - 'reason') = (to_jsonb(OLD) - 'actor_wallet' - 'reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Dispute events are append-only except for approved privacy anonymization.' USING ERRCODE = '42501';
END; $fn$;

REVOKE ALL ON FUNCTION public.begin_account_deletion(TEXT), public.record_account_deletion_step(UUID,TEXT,JSONB,BOOLEAN), public.fail_account_deletion(UUID), public.cancel_account_background_work(TEXT), public.anonymize_account_lawful_logs(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_account_deletion(TEXT), public.record_account_deletion_step(UUID,TEXT,JSONB,BOOLEAN), public.fail_account_deletion(UUID), public.cancel_account_background_work(TEXT), public.anonymize_account_lawful_logs(TEXT) TO service_role;

INSERT INTO public.schema_migrations(version,name,checksum) VALUES ('0020','0020_account_deletion_state_machine','account_deletion_478_v1') ON CONFLICT(version) DO NOTHING;
