-- Force RLS for every application table already provisioned in public. New
-- tables are checked by scripts/postgres-rls-check.sql in the PostgreSQL CI job.
DO $rls$
DECLARE
  relation RECORD;
  routine RECORD;
BEGIN
  FOR relation IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', relation.schema_name, relation.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', relation.schema_name, relation.table_name);
  END LOOP;

  -- SECURITY DEFINER routines cannot rely on the caller's search_path, and no
  -- definer routine is exposed anonymously except the invitation verifier.
  FOR routine IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', routine.oid::regprocedure);
    IF routine.proname NOT IN (
      'verify_trip_invite', 'claim_trip_invite', 'record_auth_challenge',
      'consume_auth_challenge', 'check_auth_rate_limit'
    ) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', routine.oid::regprocedure);
    END IF;
  END LOOP;
END;
$rls$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_force_row_level_security', 'force_rls_all_public_tables_v1')
ON CONFLICT (version) DO NOTHING;
