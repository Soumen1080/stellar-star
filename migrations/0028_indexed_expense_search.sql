-- ============================================================================
-- Migration 0028: Indexed, bounded expense search (#450)
-- ============================================================================
-- search_expenses() (migration 0008) matched free text with
-- strpos(expense_search_document(e), term) against a document computed on
-- read. Every search therefore evaluated every visible row, and a one-letter
-- query matched almost everything. This migration adds:
--
--   documents  public.expense_search_documents holds one normalized tsvector
--              per expense, maintained by an AFTER trigger. It is a side table
--              rather than a column so the backfill never fires the expense
--              integrity triggers or bumps updated_at.
--   RLS        the side table carries member_wallets and its own SELECT
--              policy (member_wallets @> ARRAY[current_wallet()]), so the text
--              index is tenant-scoped exactly like public.expenses.
--   indexes    GIN on the tsvector, GIN on member_wallets, and
--              (created_at DESC, expense_id DESC) for recency ordering.
--   rules      expense_search_query() normalizes terms. It drops terms shorter
--              than 2 or longer than 64 characters, keeps at most 8, and
--              returns NULL when nothing usable is left. No usable term means
--              no rows, never a scan.
--   ranking    search_expense_ids() ranks matches with ts_rank_cd (title >
--              category/tags > description > members/tx hashes) and pages
--              with a (rank, created_at, id) keyset cursor. Rank is an
--              integer so cursor comparisons are exact.
--   bounded    search_expenses() keeps its signature, but its term filter
--              now goes through the GIN index too.
--
-- Rollback: forward-only and non-destructive. To revert, re-apply the
-- search_expenses() definition from migration 0017, then
--   DROP TRIGGER IF EXISTS trg_90_expenses_search_document ON public.expenses;
--   DROP FUNCTION IF EXISTS public.search_expense_ids(TEXT[], UUID, TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, UUID, INT);
-- The side table can stay; nothing reads it once the functions are reverted.
-- ============================================================================

-- ─── Normalization ──────────────────────────────────────────────────────────
-- Lowercase, and collapse runs of non-alphanumerics to one space. Mirrors
-- normalizeSearchText() in lib/expense/historyFilters.ts.
CREATE OR REPLACE FUNCTION public.expense_search_normalize(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT btrim(regexp_replace(lower(COALESCE(p_text, '')), '[^[:alnum:]]+', ' ', 'g'));
$fn$;

-- Weighted search vector: A title, B category + tags, C description,
-- D member names, wallets and payment tx hashes. 'simple' config: no stemming,
-- so names, wallet addresses and hashes are indexed verbatim.
CREATE OR REPLACE FUNCTION public.expense_search_vector(p_expense public.expenses)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT
    setweight(to_tsvector('simple', public.expense_search_normalize(p_expense.title)), 'A') ||
    setweight(to_tsvector('simple', public.expense_search_normalize(
      concat_ws(' ', p_expense.category, array_to_string(p_expense.tags, ' ')))), 'B') ||
    setweight(to_tsvector('simple', public.expense_search_normalize(p_expense.description)), 'C') ||
    setweight(to_tsvector('simple', public.expense_search_normalize(concat_ws(' ',
      (SELECT string_agg(concat_ws(' ', m ->> 'name', m ->> 'walletAddress'), ' ')
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_expense.members) = 'array' THEN p_expense.members ELSE '[]'::jsonb END
         ) AS m),
      (SELECT string_agg(s ->> 'txHash', ' ')
         FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_expense.shares) = 'array' THEN p_expense.shares ELSE '[]'::jsonb END
         ) AS s
        WHERE s ? 'txHash')))), 'D');
$fn$;

-- Minimum-query rules. Each surviving term becomes a prefix match, and all
-- terms must match. Returns NULL when no term is usable.
CREATE OR REPLACE FUNCTION public.expense_search_query(p_terms TEXT[])
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE to_tsquery('simple', string_agg(quote_literal(word) || ':*', ' & ' ORDER BY ord))
         END
  FROM (
    SELECT word, ord
    FROM unnest(COALESCE(p_terms, ARRAY[]::TEXT[])) WITH ORDINALITY AS t(raw, term_ord),
         LATERAL unnest(string_to_array(public.expense_search_normalize(t.raw), ' ')) WITH ORDINALITY AS w(word, word_ord),
         LATERAL (SELECT t.term_ord * 100 + w.word_ord AS ord) o
    WHERE char_length(word) BETWEEN 2 AND 64
    ORDER BY ord
    LIMIT 8
  ) usable;
$fn$;

-- ─── Documents ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_search_documents (
  expense_id     UUID PRIMARY KEY REFERENCES public.expenses(id) ON DELETE CASCADE,
  member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at     TIMESTAMPTZ NOT NULL,
  search_vector  tsvector NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.expense_search_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_search_documents_select_member" ON public.expense_search_documents;
CREATE POLICY "expense_search_documents_select_member" ON public.expense_search_documents
  FOR SELECT TO authenticated
  USING (member_wallets @> ARRAY[public.current_wallet()]);

REVOKE ALL ON public.expense_search_documents FROM anon;
GRANT SELECT ON public.expense_search_documents TO authenticated;
GRANT ALL ON public.expense_search_documents TO service_role;

CREATE INDEX IF NOT EXISTS idx_expense_search_documents_vector
  ON public.expense_search_documents USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_expense_search_documents_wallets
  ON public.expense_search_documents USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_expense_search_documents_created
  ON public.expense_search_documents (created_at DESC, expense_id DESC);

-- Keeps the document in step with its expense. SECURITY DEFINER because
-- wallets have no write grant on the side table. It only writes the row for
-- the expense that fired the trigger.
CREATE OR REPLACE FUNCTION public.sync_expense_search_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.expense_search_documents (expense_id, member_wallets, created_at, search_vector, updated_at)
  VALUES (NEW.id, COALESCE(NEW.member_wallets, ARRAY[]::TEXT[]), NEW.created_at, public.expense_search_vector(NEW), now())
  ON CONFLICT (expense_id) DO UPDATE
    SET member_wallets = EXCLUDED.member_wallets,
        created_at     = EXCLUDED.created_at,
        search_vector  = EXCLUDED.search_vector,
        updated_at     = now();
  RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.sync_expense_search_document() FROM PUBLIC, anon, authenticated;

-- AFTER trigger: runs once the 01–05 BEFORE pipeline has produced the final row.
DROP TRIGGER IF EXISTS trg_90_expenses_search_document ON public.expenses;
CREATE TRIGGER trg_90_expenses_search_document
  AFTER INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.sync_expense_search_document();

-- Backfill existing rows. Writes only the side table, so expense triggers do
-- not fire. On very large tables, run it in created_at ranges during off-peak.
INSERT INTO public.expense_search_documents (expense_id, member_wallets, created_at, search_vector)
SELECT e.id, COALESCE(e.member_wallets, ARRAY[]::TEXT[]), e.created_at, public.expense_search_vector(e)
FROM public.expenses e
ON CONFLICT (expense_id) DO NOTHING;

-- ─── Shared filter predicate ────────────────────────────────────────────────
-- The non-text filters from search_expenses(), for the ranked search below.
-- It is evaluated only on rows the GIN index already matched.
CREATE OR REPLACE FUNCTION public.expense_matches_history_filters(
  e          public.expenses,
  p_trip_id  UUID,
  p_category TEXT,
  p_tags     TEXT[],
  p_payer    TEXT,
  p_status   TEXT,
  p_asset    TEXT,
  p_from     TIMESTAMPTZ,
  p_to       TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT (p_trip_id IS NULL OR e.id::text IN (
            SELECT unnest(t.expense_ids) FROM public.trips t WHERE t.id = p_trip_id))
    AND (p_category IS NULL
         OR (p_category = 'uncategorized' AND e.category IS NULL)
         OR e.category = p_category)
    AND (p_tags IS NULL OR cardinality(p_tags) = 0 OR e.tags @> p_tags)
    AND (p_payer IS NULL
         OR e.paid_by_member_id = p_payer
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(e.members) = 'array' THEN e.members ELSE '[]'::jsonb END
           ) AS m
           WHERE m ->> 'id' = e.paid_by_member_id
             AND upper(m ->> 'walletAddress') = upper(p_payer)))
    AND (p_status IS NULL
         OR (p_status = 'settled' AND e.settled)
         OR (p_status = 'open' AND NOT e.settled)
         OR (p_status IN ('unpaid', 'partial') AND NOT e.settled AND (
               EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.shares) = 'array' THEN e.shares ELSE '[]'::jsonb END
                 ) AS s
                 WHERE (s ->> 'paid')::boolean IS TRUE)
             ) = (p_status = 'partial')))
    AND (p_asset IS NULL
         OR COALESCE(NULLIF(e.settlement_asset, ''), 'native') = p_asset)
    AND (p_from IS NULL OR e.created_at >= p_from)
    AND (p_to IS NULL OR e.created_at < p_to);
$fn$;

-- ─── Ranked search ──────────────────────────────────────────────────────────
-- Returns ids in rank order. The caller loads the rows by primary key (still
-- under RLS). SECURITY INVOKER: both tables' RLS policies apply. Rows come
-- only from the GIN-matched candidate set, and no usable term means no rows.
CREATE OR REPLACE FUNCTION public.search_expense_ids(
  p_terms             TEXT[],
  p_trip_id           UUID        DEFAULT NULL,
  p_category          TEXT        DEFAULT NULL,
  p_tags              TEXT[]      DEFAULT NULL,
  p_payer             TEXT        DEFAULT NULL,
  p_status            TEXT        DEFAULT NULL,
  p_asset             TEXT        DEFAULT NULL,
  p_from              TIMESTAMPTZ DEFAULT NULL,
  p_to                TIMESTAMPTZ DEFAULT NULL,
  p_cursor_rank       BIGINT      DEFAULT NULL,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id         UUID        DEFAULT NULL,
  p_limit             INT         DEFAULT 21
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ, search_rank BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  WITH q AS (SELECT public.expense_search_query(p_terms) AS tsq),
  hits AS (
    SELECT d.expense_id, d.created_at,
           round(ts_rank_cd(d.search_vector, q.tsq) * 1000000)::BIGINT AS search_rank
    FROM q
    JOIN public.expense_search_documents d ON d.search_vector @@ q.tsq
    WHERE q.tsq IS NOT NULL
      AND d.member_wallets @> ARRAY[public.current_wallet()]
  )
  SELECT h.expense_id, h.created_at, h.search_rank
  FROM hits h
  JOIN public.expenses e ON e.id = h.expense_id
  WHERE public.expense_matches_history_filters(e, p_trip_id, p_category, p_tags, p_payer, p_status, p_asset, p_from, p_to)
    AND (p_cursor_rank IS NULL
         OR h.search_rank < p_cursor_rank
         OR (h.search_rank = p_cursor_rank AND (
               h.created_at < p_cursor_created_at
               OR (h.created_at = p_cursor_created_at AND h.expense_id < p_cursor_id))))
  ORDER BY h.search_rank DESC, h.created_at DESC, h.expense_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 21), 1), 101);
$fn$;

REVOKE ALL ON FUNCTION public.search_expense_ids(
  TEXT[], UUID, TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, UUID, INT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_expense_ids(
  TEXT[], UUID, TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, UUID, INT
) TO authenticated;

-- ─── Recency search, now index-backed ───────────────────────────────────────
-- Same signature and semantics as migration 0017, except the free-text clause
-- now goes through the GIN index, with the minimum-query rules applied.
CREATE OR REPLACE FUNCTION public.search_expenses(
  p_trip_id           UUID        DEFAULT NULL,
  p_terms             TEXT[]      DEFAULT NULL,
  p_category          TEXT        DEFAULT NULL,
  p_tags              TEXT[]      DEFAULT NULL,
  p_payer             TEXT        DEFAULT NULL,
  p_status            TEXT        DEFAULT NULL,
  p_asset             TEXT        DEFAULT NULL,
  p_from              TIMESTAMPTZ DEFAULT NULL,
  p_to                TIMESTAMPTZ DEFAULT NULL,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id         UUID        DEFAULT NULL,
  p_limit             INT         DEFAULT 21
)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT e.*
  FROM public.expenses e
  WHERE public.expense_matches_history_filters(e, p_trip_id, p_category, p_tags, p_payer, p_status, p_asset, p_from, p_to)
    AND (p_cursor_created_at IS NULL
         OR e.created_at < p_cursor_created_at
         OR (p_cursor_id IS NOT NULL AND e.created_at = p_cursor_created_at AND e.id < p_cursor_id))
    AND (p_terms IS NULL OR cardinality(p_terms) = 0 OR e.id IN (
          SELECT d.expense_id
          FROM public.expense_search_documents d
          WHERE d.search_vector @@ public.expense_search_query(p_terms)))
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 21), 1), 101);
$fn$;

GRANT EXECUTE ON FUNCTION public.search_expenses(
  UUID, TEXT[], TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INT
) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0028', '0028_indexed_expense_search', 'indexed_expense_search_450_v1')
ON CONFLICT (version) DO NOTHING;
