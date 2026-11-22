import { NextResponse } from "next/server";
import { providerRegistry } from "@/lib/routing";
import { parseJsonBody } from "@/lib/api/bodyLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/developer/providers
 *
 * Operational dashboard endpoint listing all providers across Stellar, FX, OCR,
 * and Notifications with health status, latency, failure counts, and capabilities.
 */
export async function GET() {
  const providers = providerRegistry.getAll().map((p) => ({
    id: p.id,
    name: p.name,
    domain: p.domain,
    priority: p.priority,
    capabilities: p.capabilities,
    health: p.health,
    disabled: p.disabled,
    averageLatencyMs: p.averageLatencyMs,
    consecutiveFailures: p.consecutiveFailures,
    consecutiveSuccesses: p.consecutiveSuccesses,
    totalRequests: p.totalRequests,
    totalFailures: p.totalFailures,
    lastHealthCheck: p.lastHealthCheck,
    endpointUrl: p.endpointUrl,
  }));

  const byDomain = {
    stellar: providers.filter((p) => p.domain === "stellar"),
    fx: providers.filter((p) => p.domain === "fx"),
    ocr: providers.filter((p) => p.domain === "ocr"),
    notification: providers.filter((p) => p.domain === "notification"),
  };

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    totalProviders: providers.length,
    byDomain,
    providers,
  });
}

/**
 * POST /api/developer/providers
 *
 * Operational actions allowing staff to deliberately disable/enable vendors,
 * trigger health checks, or simulate outages for failure fixture testing.
 */
export async function POST(req: Request) {
  try {
    const parsedBody = await parseJsonBody<Record<string, any>>(req, { route: "/api/developer/providers", allowEmpty: true });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value ?? {};
    const { action, providerId, disabled } = body;

    if (action === "toggle") {
      if (!providerId) {
        return NextResponse.json({ success: false, error: "Missing providerId" }, { status: 400 });
      }
      const ok = providerRegistry.setDisabled(providerId, Boolean(disabled));
      if (!ok) {
        return NextResponse.json({ success: false, error: `Provider "${providerId}" not found` }, { status: 404 });
      }
      const updated = providerRegistry.get(providerId);
      return NextResponse.json({
        success: true,
        action: "toggle",
        provider: {
          id: updated?.id,
          name: updated?.name,
          disabled: updated?.disabled,
          health: updated?.health,
        },
      });
    }

    if (action === "check") {
      if (providerId) {
        const result = await providerRegistry.checkHealth(providerId);
        const updated = providerRegistry.get(providerId);
        return NextResponse.json({
          success: true,
          action: "check",
          providerId,
          result,
          currentHealth: updated?.health,
        });
      }
      const allResults = await providerRegistry.checkAllHealth();
      return NextResponse.json({
        success: true,
        action: "check_all",
        results: allResults,
      });
    }

    if (action === "reset") {
      providerRegistry.reset();
      return NextResponse.json({ success: true, action: "reset" });
    }

    return NextResponse.json(
      {
        success: false,
        error: `Unknown action: "${action}". Valid actions are "toggle", "check", and "reset".`,
      },
      { status: 400 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Provider operation failed";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
