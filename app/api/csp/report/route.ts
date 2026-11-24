/**
 * app/api/csp/report/route.ts
 *
 * Issue #457: CSP Violation Ingestion & Reporting Endpoint.
 *
 * Accepts application/csp-report and application/reports+json payloads,
 * sanitizes and rate limits them, and records actionable violations.
 */

import { NextRequest, NextResponse } from "next/server";
import { sanitizeViolationReport } from "@/lib/security/csp";
import { getClientIp, checkRateLimit } from "@/lib/auth/rateLimiter";
import type { SanitizedCSPViolation, CSPViolationPayload } from "@/types/csp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

declare global {
  var stellarStarCSPViolations: SanitizedCSPViolation[] | undefined;
}

const violationsBuffer: SanitizedCSPViolation[] = globalThis.stellarStarCSPViolations ?? [];
globalThis.stellarStarCSPViolations = violationsBuffer;
const MAX_VIOLATIONS = 500;

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rateKey = `csp:report:${ip}`;
  const rateLimit = await checkRateLimit(rateKey, 100, 60_000); // 100 reports / min per IP

  if (!rateLimit.allowed) {
    return new NextResponse(null, { status: 429 });
  }

  try {
    let payload: CSPViolationPayload = {};
    const text = await request.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        return new NextResponse(null, { status: 400 });
      }
    }

    const sanitized = sanitizeViolationReport(payload, ip);
    violationsBuffer.unshift(sanitized);
    if (violationsBuffer.length > MAX_VIOLATIONS) {
      violationsBuffer.pop();
    }

    return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 400 });
  }
}

/**
 * Diagnostic query endpoint for staff / operators to inspect recent violations.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    count: violationsBuffer.length,
    violations: violationsBuffer.slice(0, 50),
  });
}
