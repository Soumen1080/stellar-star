/**
 * /api/reminders/unsubscribe?token=… (#326) — one-click opt-out from an
 * external reminder, without signing in.
 *
 *   GET   a confirmation page (link scanners and prefetchers only ever GET,
 *         so a GET never changes anything)
 *   POST  performs the opt-out (also the RFC 8058 List-Unsubscribe-Post target)
 *
 * The token is HMAC-signed and can only turn a channel off.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildDeps } from "@/lib/reminders/server";
import { unsubscribe } from "@/lib/reminders/service";
import { verifyUnsubscribeToken } from "@/lib/reminders/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#0F0F14"><h1 style="font-size:1.25rem">${title}</h1>${body}</body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

function claimsFrom(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  try {
    return { token, claims: verifyUnsubscribeToken(token) };
  } catch {
    return { token, claims: null };
  }
}

export async function GET(request: NextRequest) {
  const { token, claims } = claimsFrom(request);
  if (!claims) return page("Link expired", "<p>This unsubscribe link is invalid or has expired.</p>", 400);
  const action = `/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;
  return page(
    "Stop reminder messages?",
    `<p>You will stop getting StellarStar payment requests by ${claims.channel}. In-app reminders are not affected.</p>` +
      `<form method="post" action="${action}"><button type="submit" style="padding:.5rem 1rem;font-weight:700">Unsubscribe</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const { claims } = claimsFrom(request);
  if (!claims) return page("Link expired", "<p>This unsubscribe link is invalid or has expired.</p>", 400);
  const service = createServiceRoleClient();
  if (!service) return page("Try again later", "<p>Unsubscribing is temporarily unavailable.</p>", 503);
  try {
    await unsubscribe(buildDeps(request, { user: null, service }), claims);
  } catch {
    return page("Try again later", "<p>We could not update your preferences. Please try again.</p>", 500);
  }
  return page("Unsubscribed", `<p>You will no longer receive payment requests by ${claims.channel}.</p>`);
}
