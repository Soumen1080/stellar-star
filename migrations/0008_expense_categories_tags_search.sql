-- ============================================================================
-- Stellar-star Migration 0008: Expense categories, tags & filterable history
-- (issue #317)
-- ============================================================================
-- Lightweight organization for long trips. Nothing here changes how much
-- anyone owes: category and tags are labels, and settlement_asset only makes
-- the asset an expense already settles in queryable (NULL = native XLM, which
-- is what every existing row settles in).
--
-- Search and filtering run server-side in public.search_expenses(), a
-- SECURITY INVOKER function, so the caller's existing RLS policies decide
-- visibility exactly as they do for a plain SELECT.

-- ─── Columns ────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS settlement_asset TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Keep in step with EXPENSE_CATEGORIES in lib/expense/categories.ts.
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_category_check') THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_category_check CHECK (
        category IS NULL OR category IN (
          'food', 'groceries', 'lodging', 'transport', 'activities', 'shopping',
          'utilities', 'rent', 'subscriptions', 'health', 'other'
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_tags_limit_check') THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_tags_limit_check CHECK (cardinality(tags) <= 10);
  END IF;
END
$constraints$;

-- ─── Tag normalization ──────────────────────────────────────────────────────
-- Mirrors normalizeTag() in lib/expense/tags.ts: lowercase, strip a leading
-- '#', collapse non-alphanumeric runs to '-', trim '-', cap at 32 characters,
-- de-duplicate keeping first-seen order. Enforced here so a client that skips
-- the TypeScript helper still cannot store "Beach" and "beach" as two tags.
CREATE OR REPLACE FUNCTION public.normalize_expense_tags(p_tags TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(array_agg(tag ORDER BY first_pos), ARRAY[]::TEXT[])
  FROM (
    SELECT tag, MIN(pos) AS first_pos
    FROM (
      SELECT
        btrim(left(btrim(regexp_replace(
          regexp_replace(lower(btrim(raw)), '^#+', ''),
          '[^[:alnum:]]+', '-', 'g'
        ), '-'), 32), '-') AS tag,
        pos
      FROM unnest(COALESCE(p_tags, ARRAY[]::TEXT[])) WITH ORDINALITY AS t(raw, pos)
    ) cleaned
    WHERE tag <> ''
    GROUP BY tag
  ) deduped;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_expense_labels()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.tags := public.normalize_expense_tags(NEW.tags);
  NEW.category := NULLIF(lower(btrim(NEW.category)), '');
  RETURN NEW;
END;
$fn$;

-- Runs after the 01–04 integrity pipeline (triggers fire alphabetically).
DROP TRIGGER IF EXISTS trg_05_expenses_normalize_labels ON public.expenses;
CREATE TRIGGER trg_05_expenses_normalize_labels
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.normalize_expense_labels();

-- ─── Freeze the settlement asset ────────────────────────────────────────────
-- The asset is part of the debt, exactly like the amount: a member relabelling
-- an expense must not be able to change what it settles in. Same function as
-- migration 0005, plus settlement_asset.
CREATE OR REPLACE FUNCTION public.freeze_row_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  old_json JSONB;
  new_json JSONB;
BEGIN
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  new_json := new_json
    || jsonb_build_object('id', old_json -> 'id')
    || jsonb_build_object('created_at', old_json -> 'created_at')
    || jsonb_build_object('created_by_wallet', old_json -> 'created_by_wallet')
    || jsonb_build_object('total_amount', old_json -> 'total_amount')
    || jsonb_build_object('currency', old_json -> 'currency')
    || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
    || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp')
    || jsonb_build_object('settlement_asset', old_json -> 'settlement_asset');

  RETURN jsonb_populate_record(NEW, new_json);
END;
$fn$;

-- ─── Search ─────────────────────────────────────────────────────────────────
-- Everything free-text search looks at, lowercased. Mirrors
-- expenseSearchDocument() in lib/expense/historyFilters.ts. Computed on read
-- rather than stored, so existing rows need no backfill (a backfill UPDATE
-- would re-run the share validation and bump updated_at on every expense).
CREATE OR REPLACE FUNCTION public.expense_search_document(p_expense public.expenses)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $fn$
  SELECT lower(concat_ws(' ',
    p_expense.title,
    p_expense.description,
    p_expense.category,
    array_to_string(p_expense.tags, ' '),
    (SELECT string_agg(concat_ws(' ', m ->> 'name', m ->> 'walletAddress'), ' ')
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_expense.members) = 'array' THEN p_expense.members ELSE '[]'::jsonb END
       ) AS m),
    (SELECT string_agg(s ->> 'txHash', ' ')
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_expense.shares) = 'array' THEN p_expense.shares ELSE '[]'::jsonb END
       ) AS s
      WHERE s ? 'txHash')
  ));
$fn$;

-- Filtered, searched, keyset-paginated history. Every filter is optional (NULL
-- = not applied). Semantics match matchesExpenseHistoryFilters() in
-- lib/expense/historyFilters.ts:
--   p_trip_id   only expenses linked from that trip's expense_ids
--   p_terms     lowercased terms; ALL must appear in the search document
--   p_category  a category, or 'uncategorized' for NULL
--   p_tags      the expense must carry ALL of them
--   p_payer     paid_by_member_id, or the payer member's wallet address
--   p_status    'open' (not settled) | 'unpaid' | 'partial' | 'settled'
--   p_asset     canonical asset key; 'native' also matches NULL
--   p_from/p_to half-open [from, to) instant range on created_at
--   p_cursor_*  keyset position from the previous page (created_at, id)
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
  WHERE (p_trip_id IS NULL OR e.id::text IN (
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
    AND (p_to IS NULL OR e.created_at < p_to)
    AND (p_cursor_created_at IS NULL
         OR e.created_at < p_cursor_created_at
         OR (p_cursor_id IS NOT NULL AND e.created_at = p_cursor_created_at AND e.id < p_cursor_id))
    AND (p_terms IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest(p_terms) AS term
          WHERE strpos(public.expense_search_document(e), lower(term)) = 0))
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 21), 1), 101);
$fn$;

GRANT EXECUTE ON FUNCTION public.search_expenses(
  UUID, TEXT[], TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INT
) TO authenticated;

-- ─── Indexes ────────────────────────────────────────────────────────────────

-- Keyset pagination: ORDER BY created_at DESC, id DESC with a (created_at, id) bound.
CREATE INDEX IF NOT EXISTS idx_expenses_created_at_id
  ON public.expenses (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_category_created_at
  ON public.expenses (category, created_at DESC);

-- Containment (tags @> ARRAY[...]) is what the tag filter uses.
CREATE INDEX IF NOT EXISTS idx_expenses_tags
  ON public.expenses USING GIN (tags);

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0008', '0008_expense_categories_tags_search', 'expense_categories_tags_search_v1')
ON CONFLICT (version) DO NOTHING;
