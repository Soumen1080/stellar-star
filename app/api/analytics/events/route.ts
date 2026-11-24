import { NextRequest, NextResponse } from "next/server";
import { toPublicErrorResponse } from "@/lib/api/errors";
import {
  isAllowedEventName,
  containsSensitiveData,
  sanitizeAnalyticsEvent,
  ANALYTICS_SCHEMA_VERSION,
} from "@/lib/analytics";
import { parseJsonBody } from "@/lib/api/bodyLimits";

export async function POST(req: NextRequest) {
  try {
    const parsedBody = await parseJsonBody<any>(req, { route: "/api/analytics/events" });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value;

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    if (!isAllowedEventName(body.name)) {
      return NextResponse.json(
        { error: `Unrecognized event name "${body.name}"` },
        { status: 400 }
      );
    }

    // Strict security check: reject if sensitive data was sent
    if (containsSensitiveData(body.properties)) {
      return NextResponse.json(
        {
          error: "Redaction violation: Payload contains sensitive or unpermitted data.",
          redacted: true,
        },
        { status: 400 }
      );
    }

    const sanitized = sanitizeAnalyticsEvent(body);

    // In production, forward to internal metrics storage or log sink
    return NextResponse.json({
      success: true,
      eventId: sanitized.id,
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
    });
  } catch (err: unknown) {
    return toPublicErrorResponse(err, {
      fallbackMessage: "Internal error",
      route: "/api/analytics/events",
      method: "POST",
    });
  }
}
