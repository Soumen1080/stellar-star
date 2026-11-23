import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchActiveTemplates, fetchExceptions } from "@/lib/recurring/queries";
import { generateDueDrafts } from "@/lib/recurring/generate";
import { utcToday } from "@/lib/recurring/schedule";
import { consumeTenantQuota } from "@/lib/quotas/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Small enough that the `template_id IN (...)` exception lookup stays a short URL.
const PAGE = 100;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Scheduled draft generation (issue #319), e.g. Vercel Cron daily with
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * Idempotent: drafts are keyed on (template_id, occurrence_date), so re-running
 * the same day — or overlapping runs — creates nothing new. It only ever
 * writes drafts; no expense is saved and no payment is attempted.
 */
async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const client = createServiceRoleClient();
  if (!client) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for scheduled drafts." },
      { status: 503 },
    );
  }

  const today = utcToday();
  let created = 0;
  let templates = 0;
  const failedTemplateIds: string[] = [];

  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await fetchActiveTemplates(client, { limit: PAGE, offset });
      if (page.length === 0) break;
      templates += page.length;
      const eligible: typeof page = [];
      for (const template of page) {
        const quota = await consumeTenantQuota(template.createdByWallet, { jobs: 1 });
        if (!quota.available) {
          return NextResponse.json({ error: "Tenant quota service is unavailable.", created }, { status: 503 });
        }
        if (quota.allowed) eligible.push(template);
        else failedTemplateIds.push(template.id);
      }
      if (eligible.length) {
        const exceptions = await fetchExceptions(eligible.map((t) => t.id), client);
        const result = await generateDueDrafts(client, eligible, exceptions, today);
        created += result.created;
        failedTemplateIds.push(...result.failedTemplateIds);
      }
      if (page.length < PAGE) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Draft generation failed.";
    return NextResponse.json({ error: message, created }, { status: 500 });
  }

  return NextResponse.json(
    { data: { date: today, templates, created, failedTemplateIds } },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = run;
export const POST = run;
