import { NextResponse } from "next/server";
import { getPublicStatus, STATUS_CACHE_SECONDS } from "@/lib/status/evaluate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public service status (Issue #377). Coarse states only; see
 * lib/status/evaluate.ts for what each component is measured from.
 */
export async function GET() {
  const status = await getPublicStatus();
  return NextResponse.json(status, {
    headers: {
      "Cache-Control": `public, max-age=0, s-maxage=${STATUS_CACHE_SECONDS}, stale-while-revalidate=60`,
    },
  });
}
