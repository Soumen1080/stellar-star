import { NextRequest, NextResponse } from "next/server";

/** Emit RFC 9745 Deprecation and RFC 8594 Sunset headers when configured. */
export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
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
  return response;
}

export const config = { matcher: "/api/v1/:path*" };
