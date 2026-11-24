import { NextRequest, NextResponse } from "next/server";
import { processWebhookOutbox } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = (process.env.WEBHOOK_DISPATCH_SECRET ?? process.env.CRON_SECRET)?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const processed = await processWebhookOutbox(10);
    return NextResponse.json({ processed }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to process webhook deliveries." }, { status: 503 });
  }
}

export const GET = POST;
