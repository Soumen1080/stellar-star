import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Real PostgreSQL semantics in memory; no credentials, Docker or customer data.
const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);
    CREATE TABLE public.schema_migrations (version text PRIMARY KEY, name text, checksum text);
    CREATE TABLE public.expenses (id uuid PRIMARY KEY, member_wallets text[] NOT NULL);
    CREATE FUNCTION public.current_wallet() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('test.wallet', true), '') $$;
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT ON public.expenses TO authenticated;
    ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY expense_members ON public.expenses FOR SELECT TO authenticated
      USING (member_wallets @> ARRAY[public.current_wallet()]);
  `);
  const migration = await readFile(new URL("../migrations/0009_expense_receipts.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(migration); // Safe for fresh provisioning and repeat deployment.
  const expenseId = "11111111-1111-4111-8111-111111111111";
  const receiptId = "22222222-2222-4222-8222-222222222222";
  await db.query("INSERT INTO expenses VALUES ($1, ARRAY['MEMBER'])", [expenseId]);
  await db.query(`INSERT INTO expense_receipts
    (id, expense_id, storage_path, file_name, content_type, size_bytes, checksum_sha256, uploaded_by_wallet, retain_until)
    VALUES ($1, $2, 'receipts/original.jpg', 'original.jpg', 'image/jpeg', 20, $3, 'MEMBER', now() + interval '730 days')`,
  [receiptId, expenseId, "a".repeat(64)]);
  const bucket = (await db.query("SELECT * FROM storage.buckets WHERE id = 'expense-receipts'")).rows[0];
  assert.equal(bucket.public, false);
  assert.equal(bucket.file_size_limit, 4194304);
  assert.equal(bucket.allowed_mime_types.includes("image/svg+xml"), false);
  await db.exec("SET ROLE authenticated");
  await db.query("SELECT set_config('test.wallet', 'MEMBER', false)");
  assert.equal((await db.query("SELECT * FROM expense_receipts")).rows.length, 1);
  await assert.rejects(db.query("UPDATE expense_receipts SET file_name = 'tampered'"), /permission denied/);
  await assert.rejects(db.query("DELETE FROM expense_receipts"), /permission denied/);
  await db.query("SELECT set_config('test.wallet', 'OUTSIDER', false)");
  assert.equal((await db.query("SELECT * FROM expense_receipts")).rows.length, 0);
  await db.exec("RESET ROLE");
  await db.query("DELETE FROM expenses WHERE id = $1", [expenseId]);
  assert.equal((await db.query("SELECT expense_id FROM expense_receipts")).rows[0].expense_id, null);
  assert.equal((await db.query("SELECT id FROM expense_receipts WHERE expense_id IS NULL OR retain_until <= now()")).rows.length, 1);
  console.log("PASS: actual PostgreSQL receipt migration, private bucket, membership RLS, client write denial and retention orphan selection.");
} finally { await db.close(); }

// Also exercise the actual fresh-install file and the unique upgrade path.
// PGlite supplies gen_random_uuid() in core; Supabase supplies pgcrypto itself.
const provisioned = new PGlite();
try {
  await provisioned.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit integer, allowed_mime_types text[]);`);
  const setup = (await readFile(new URL("../supabase-setup.sql", import.meta.url), "utf8"))
    .replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, "");
  const receiptSection = setup.indexOf("CREATE TABLE IF NOT EXISTS public.expense_receipts");
  assert.ok(receiptSection > 0);
  await provisioned.exec(setup);
  // A colliding historical marker must not cause the new receipt schema to skip.
  await provisioned.exec("INSERT INTO schema_migrations (version, name, checksum) VALUES ('0009', 'legacy_parallel_branch', 'legacy') ON CONFLICT DO NOTHING");
  const upgrade = await readFile(new URL("../migrations/0017_receipt_capture_prerequisites.sql", import.meta.url), "utf8");
  await provisioned.exec(upgrade);
  await provisioned.exec(upgrade);
  await provisioned.exec(setup);
  assert.equal((await provisioned.query("SELECT public FROM storage.buckets WHERE id = 'expense-receipts'")).rows[0].public, false);
  assert.equal((await provisioned.query("SELECT version FROM schema_migrations WHERE version = '0017'")).rows.length, 1);
  const columns = (await provisioned.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'expenses'")).rows.map((row) => row.column_name);
  for (const name of ["category", "tags", "entered_amount", "settlement_asset"]) assert.ok(columns.includes(name));
  const receiptPolicy = (await provisioned.query("SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'expense_receipts' AND policyname = 'expense_receipts_select_members'")).rows[0];
  assert.ok(receiptPolicy.qual.includes("expense_has_permission"));
  const linkRpc = (await provisioned.query("SELECT prosrc FROM pg_proc WHERE proname = 'add_expense_to_trip'")).rows[0];
  assert.ok(linkRpc.prosrc.includes("trip_has_permission"));
  console.log("PASS: actual cumulative provisioning and repeatable receipt/form upgrade 0017.");
} finally { await provisioned.close(); }
