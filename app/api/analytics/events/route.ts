import { NextRequest, NextResponse } from "next/server";
import {
  isAllowedEventName,
  containsSensitiveData,
  sanitizeAnalyticsEvent,
  ANALYTICS_SCHEMA_VERSION,
} from "@/lib/analytics";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

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
    const message = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
