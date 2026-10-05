-- Run after provisioning a disposable database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-query-indexes.sql
-- `enable_seqscan = off` makes this a deterministic index-coverage check even
-- when the throwaway database is too small for PostgreSQL to prefer an index.

BEGIN;
SET LOCAL enable_seqscan = off;

EXPLAIN (COSTS OFF)
SELECT id FROM public.expenses
 WHERE member_wallets @> ARRAY['GQUERYPLAN']
   AND settled = false
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.expenses
 WHERE created_by_wallet = 'GQUERYPLAN'
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.expenses
 WHERE settled = false
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.trips
 WHERE member_wallets @> ARRAY['GQUERYPLAN']
   AND settled = false
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.trips
 WHERE created_by_wallet = 'GQUERYPLAN'
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.trips
 WHERE settled = false
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.trip_invites
 WHERE trip_id = '00000000-0000-0000-0000-000000000001'::uuid
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT id FROM public.settlement_intents
 WHERE member_wallet = 'GQUERYPLAN'
   AND status IN ('pending', 'submitting', 'submitted')
 ORDER BY created_at DESC;

EXPLAIN (COSTS OFF)
SELECT nonce FROM public.auth_challenges
 WHERE address = 'GQUERYPLAN'
 ORDER BY created_at ASC
 LIMIT 1;

ROLLBACK;
