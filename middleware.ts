import { NextRequest, NextResponse } from "next/server";
import { generateCSPNonce, buildContentSecurityPolicy, CSP_HEADER_NAME, CSP_NONCE_HEADER } from "@/lib/security/csp";

async function verifiedWalletClaim(token: string, secret: string): Promise<string | null> {
  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return null;
    const decode = (segment: string) => {
      const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    };
    const header = JSON.parse(new TextDecoder().decode(decode(headerPart)));
    const claims = JSON.parse(new TextDecoder().decode(decode(payloadPart)));
    if (header.alg !== "HS256" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    if (typeof claims.wallet_address !== "string" || !claims.wallet_address) return null;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, decode(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    return valid ? claims.wallet_address.toUpperCase() : null;
  } catch { return null; }
}

/** Emit RFC 9745 Deprecation and RFC 8594 Sunset headers when configured. */
export async function middleware(request: NextRequest) {
  // Generate cryptographic nonce for HTML page renders
  const nonce = generateCSPNonce();
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Attach dynamic nonce-hardened Content-Security-Policy to HTML navigation requests
  if (!isApi) {
    const csp = buildContentSecurityPolicy({
      nonce,
      isDev: process.env.NODE_ENV === "development",
    });
    response.headers.set(CSP_HEADER_NAME, csp);
    response.headers.set(CSP_NONCE_HEADER, nonce);
  }

  if (request.nextUrl.pathname.startsWith("/api/v1/")) {
    const deprecationDate = process.env.API_V1_DEPRECATION_DATE;
    const sunsetDate = process.env.API_V1_SUNSET_DATE;
    if (deprecationDate) {
      const seconds = Math.floor(Date.parse(deprecationDate) / 1000);
      if (Number.isFinite(seconds)) response.headers.set("Deprecation", `@${seconds}`);
    }
    if (sunsetDate) {
      const timestamp = Date.parse(sunsetDate);
      if (Number.isFinite(timestamp)) response.headers.set("Sunset", new Date(timestamp).toUTCString());
    }
    if (deprecationDate || sunsetDate) {
      response.headers.set("Link", '</developer/api-lifecycle>; rel="deprecation"');
    }
  }

  // Wallet sessions are JWTs. Checking the durable tombstone at the edge
  // invalidates sessions on every app route and also blocks API-token-free flows.
  // The delete endpoint remains reachable so a failed workflow can be resumed.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const jwtSecret = process.env.SUPABASE_JWT_SECRET ?? process.env.JWT_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (token && jwtSecret && serviceKey && supabaseUrl && request.nextUrl.pathname !== "/api/account/delete") {
    try {
      const wallet = await verifiedWalletClaim(token, jwtSecret);
      if (wallet) {
        const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/deleted_accounts`);
        url.searchParams.set("select", "wallet_address");
        url.searchParams.set("wallet_address", `eq.${wallet}`);
        const check = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, cache: "no-store" });
        if (!check.ok) return NextResponse.json({ error: "Account status is unavailable." }, { status: 503 });
        const rows = await check.json();
        if (Array.isArray(rows) && rows.length) {
          return NextResponse.json({ error: "This account has been deleted.", code: "ACCOUNT_DELETED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
        }
      }
    } catch {
      return NextResponse.json({ error: "Account status is unavailable." }, { status: 503 });
    }
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
