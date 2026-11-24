\set ON_ERROR_STOP on

DO $inventory$
DECLARE
  unsafe TEXT;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO unsafe
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Tables without enabled and forced RLS: %', unsafe;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO unsafe
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND (
       has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'INSERT')
       OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE')
       OR has_table_privilege('authenticated', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'INSERT')
       OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('authenticated', c.oid, 'DELETE')
     )
     AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Client-granted tables require explicit policy coverage: %', unsafe;
  END IF;

  SELECT string_agg(DISTINCT format('%I.%I', p.schemaname, p.tablename), ', ' ORDER BY format('%I.%I', p.schemaname, p.tablename))
    INTO unsafe
    FROM pg_publication_tables p
    JOIN information_schema.columns c
      ON c.table_schema = p.schemaname AND c.table_name = p.tablename
   WHERE p.schemaname = 'public'
     AND c.column_name IN ('created_by_wallet', 'owner_wallet', 'sender_wallet', 'wallet_address')
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger t
       WHERE t.tgrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
         AND t.tgname = 'tenant_realtime_quota' AND NOT t.tgisinternal
     );
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Realtime tenant tables require quota metering: %', unsafe;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO unsafe
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'v'
     AND NOT coalesce((SELECT option_value::boolean FROM pg_options_to_table(c.reloptions)
                        WHERE option_name = 'security_invoker'), false);
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Views must use security_invoker: %', unsafe;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO unsafe
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND (
       NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) setting
                    WHERE setting LIKE 'search_path=%')
       OR (has_function_privilege('anon', p.oid, 'EXECUTE')
           AND p.proname NOT IN (
             'verify_trip_invite', 'claim_trip_invite', 'record_auth_challenge',
             'consume_auth_challenge', 'check_auth_rate_limit'
           ))
     );
  IF unsafe IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe SECURITY DEFINER function search path or anonymous grant: %', unsafe;
  END IF;
END;
$inventory$;

INSERT INTO public.trips (name, created_by_wallet, member_wallets)
VALUES ('Alice trip', 'G_WALLET_ALICE', ARRAY['G_WALLET_ALICE']),
       ('Bob trip', 'G_WALLET_BOB', ARRAY['G_WALLET_BOB']);
INSERT INTO public.expenses (title, total_amount, currency, split_mode, paid_by_member_id,
                             created_by_wallet, member_wallets)
VALUES ('Alice expense', '10', 'XLM', 'equal', 'alice', 'G_WALLET_ALICE', ARRAY['G_WALLET_ALICE']),
       ('Bob expense', '20', 'XLM', 'equal', 'bob', 'G_WALLET_BOB', ARRAY['G_WALLET_BOB']);

INSERT INTO public.tenant_quota_limits (wallet_address, objects_limit, bytes_limit,
                                        jobs_per_minute, events_per_minute, requests_per_minute)
VALUES ('G_WALLET_QUOTA', 2, 100, 2, 2, 2)
ON CONFLICT (wallet_address) DO UPDATE SET objects_limit = 2, bytes_limit = 100,
  jobs_per_minute = 2, events_per_minute = 2, requests_per_minute = 2;

SET ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
DO $quota$
DECLARE result JSONB;
BEGIN
  result := public.consume_tenant_quotas('G_WALLET_QUOTA', 1, 50, 0, 0, 1, 'quota-file-a');
  IF NOT (result ->> 'allowed')::boolean THEN RAISE EXCEPTION 'First quota reservation should pass'; END IF;
  result := public.consume_tenant_quotas('G_WALLET_QUOTA', 1, 60, 0, 0, 0, 'quota-file-rejected');
  IF (result ->> 'allowed')::boolean OR result ->> 'metric' <> 'bytes' THEN
    RAISE EXCEPTION 'Byte limit must reject atomically';
  END IF;
  result := public.consume_tenant_quotas('G_WALLET_QUOTA', 1, 50, 0, 0, 1, 'quota-file-b');
  IF NOT (result ->> 'allowed')::boolean THEN
    RAISE EXCEPTION 'Rejected multi-metric reservation must not consume object or request quota';
  END IF;
  IF NOT public.release_tenant_storage_quota('quota-file-a') THEN
    RAISE EXCEPTION 'First storage release should succeed';
  END IF;
  IF public.release_tenant_storage_quota('quota-file-a') THEN
    RAISE EXCEPTION 'Repeated storage release must be idempotent';
  END IF;
  result := public.consume_tenant_quotas('G_WALLET_QUOTA', 1, 1, 0, 0, 0, 'quota-file-c');
  IF NOT (result ->> 'allowed')::boolean THEN
    RAISE EXCEPTION 'Released storage quota should be reusable';
  END IF;
  result := public.consume_tenant_quotas('G_WALLET_QUOTA', 1, 1, 0, 0, 0, 'quota-file-d');
  IF (result ->> 'allowed')::boolean OR result ->> 'metric' <> 'objects' THEN
    RAISE EXCEPTION 'Object limit must reject once exhausted';
  END IF;
END;
$quota$;
RESET ROLE;

SET ROLE authenticated;
DO $private_usage$
BEGIN
  PERFORM count(*) FROM public.tenant_quota_usage;
  RAISE EXCEPTION 'Authenticated tenant can inspect quota usage';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$private_usage$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"wallet_address":"G_WALLET_ALICE","role":"authenticated"}', false);
DO $alice$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM public.trips;
  IF n <> 1 THEN RAISE EXCEPTION 'Alice can see % trips; expected exactly one', n; END IF;
  SELECT count(*) INTO n FROM public.expenses;
  IF n <> 1 THEN RAISE EXCEPTION 'Alice can see % expenses; expected exactly one', n; END IF;
  UPDATE public.trips SET name = 'cross-wallet write' WHERE created_by_wallet = 'G_WALLET_BOB';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Alice updated a Bob trip'; END IF;
  UPDATE public.expenses SET title = 'cross-wallet write' WHERE created_by_wallet = 'G_WALLET_BOB';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Alice updated a Bob expense'; END IF;
  BEGIN
    PERFORM public.update_expense_versioned(
      (SELECT id FROM public.expenses WHERE created_by_wallet = 'G_WALLET_BOB'),
      (SELECT version FROM public.expenses WHERE created_by_wallet = 'G_WALLET_BOB'),
      'cross-wallet write', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    RAISE EXCEPTION 'Alice executed update_expense_versioned against Bob expense';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$alice$;

SELECT set_config('request.jwt.claims', '{"wallet_address":"G_WALLET_BOB","role":"authenticated"}', false);
DO $bob$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM public.trips;
  IF n <> 1 THEN RAISE EXCEPTION 'Bob can see % trips; expected exactly one', n; END IF;
  SELECT count(*) INTO n FROM public.expenses;
  IF n <> 1 THEN RAISE EXCEPTION 'Bob can see % expenses; expected exactly one', n; END IF;
END;
$bob$;
RESET ROLE;

SET ROLE anon;
DO $anonymous$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM public.trips;
  IF n <> 0 THEN RAISE EXCEPTION 'Anonymous caller can read tenant trips'; END IF;
  SELECT count(*) INTO n FROM public.expenses;
  IF n <> 0 THEN RAISE EXCEPTION 'Anonymous caller can read tenant expenses'; END IF;
END;
$anonymous$;
RESET ROLE;

SELECT 'PostgreSQL RLS checks passed' AS result;
