import { NextResponse } from "next/server";
import { chainMetadataCache } from "@/lib/stellar/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/developer/stellar-cache
 *
 * Diagnostics endpoint returning operational metrics and active cache summaries
 * for the bounded chain metadata cache.
 */
export async function GET() {
  const metrics = chainMetadataCache.getMetrics();
  const entries = chainMetadataCache.getEntriesSummary();

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    metrics,
    entriesCount: entries.length,
    entries,
  });
}

/**
 * POST /api/developer/stellar-cache
 *
 * Management endpoint allowing selective invalidation of cached metadata
 * by tenant, entityType, network, or full reset.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action = "invalidate", tenantWallet, entityType, entityId, network } = body;

    if (action === "clear") {
      chainMetadataCache.clear();
      return NextResponse.json({
        success: true,
        action: "clear",
        metrics: chainMetadataCache.getMetrics(),
      });
    }

    if (action === "invalidate") {
      const count = chainMetadataCache.invalidateByFilter({
        network,
        tenantWallet,
        entityType,
        entityId,
      });

      return NextResponse.json({
        success: true,
        action: "invalidate",
        invalidatedCount: count,
        metrics: chainMetadataCache.getMetrics(),
      });
    }

    return NextResponse.json(
      { success: false, error: `Unknown action: "${action}". Valid actions are "invalidate" and "clear".` },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Cache operation failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
