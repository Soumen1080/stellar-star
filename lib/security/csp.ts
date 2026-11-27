/**
 * lib/security/csp.ts
 *
 * Issue #457: Tightened Content Security Policy (CSP) Generator.
 *
 * Replaces global 'unsafe-inline' and 'unsafe-eval' with:
 *  - Nonce / hash policy for inline scripts
 *  - Removal of 'unsafe-eval' in production
 *  - Minimized, explicit origins for connect-src, img-src, and frame-ancestors
 *  - Support for QR generation (svg/canvas), OCR workers (blob:/data:), and Freighter/Stellar wallets
 *  - CSP violation reporting endpoint integration (`report-uri` / `report-to`)
 */

import type { CSPOptions } from "@/types/csp";

export const CSP_HEADER_NAME = "Content-Security-Policy";
export const CSP_REPORT_ONLY_HEADER_NAME = "Content-Security-Policy-Report-Only";
export const CSP_NONCE_HEADER = "x-nonce";

/**
 * Standard trusted Stellar and Supabase origins.
 */
export const TRUSTED_CONNECT_ORIGINS = [
  "'self'",
  "https://*.stellar.org",
  "https://horizon.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://rpc.stellar.org",
  "https://soroban-testnet.stellar.org",
  "https://*.supabase.co",
  "wss://*.supabase.co",
];

export const TRUSTED_IMG_ORIGINS = [
  "'self'",
  "data:",
  "blob:",
  "https://stellar.expert",
  "https://*.stellar.org",
];

/**
 * Generates a cryptographically random, base64-encoded nonce.
 */
export function generateCSPNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
/**
 * Builds the hardened Content Security Policy string.
 */
export function buildContentSecurityPolicy(options: CSPOptions = {}): string {
  const {
    nonce,
    isDev = process.env.NODE_ENV === "development",
    reportUri = "/api/csp/report",
    additionalConnectOrigins = [],
    additionalScriptHashes = [],
  } = options;

  // 1. Script directive:
  // In production, 'unsafe-eval' is NEVER allowed.
  // When a nonce is available, 'strict-dynamic' and 'nonce-...' are used.
  const scriptSources: string[] = ["'self'"];

  if (nonce) {
    scriptSources.push(`'nonce-${nonce}'`);
    // 'strict-dynamic' tells modern browsers that scripts loaded by a nonced script are trusted.
    scriptSources.push("'strict-dynamic'");
  }

  for (const hash of additionalScriptHashes) {
    scriptSources.push(`'${hash}'`);
  }

  if (isDev) {
    // Only in development: Next.js Fast Refresh requires 'unsafe-eval'
    scriptSources.push("'unsafe-eval'");
    // Fallback for dev inline hot-reload scripts if nonce is absent
    if (!nonce) {
      scriptSources.push("'unsafe-inline'");
    }
  }

  // 2. Style directive:
  // Note: Tailwind and dynamic inline component styles use 'unsafe-inline' or nonces.
  const styleSources: string[] = ["'self'", "'unsafe-inline'"];
  if (nonce) {
    styleSources.push(`'nonce-${nonce}'`);
  }

  // 3. Connect directive:
  const connectSources = Array.from(
    new Set([...TRUSTED_CONNECT_ORIGINS, ...additionalConnectOrigins])
  );

  // 4. Image directive:
  const imgSources = [...TRUSTED_IMG_ORIGINS];

  // 5. Worker directive:
  // Workers (OCR client, web workers) require blob: or 'self'
  const workerSources = ["'self'", "blob:"];

  // 6. Directives mapping
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSources,
    "style-src": styleSources,
    "img-src": imgSources,
    "font-src": ["'self'", "data:"],
    "connect-src": connectSources,
    "worker-src": workerSources,
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'self'"],
  };

  if (reportUri) {
    directives["report-uri"] = [reportUri];
  }

  return Object.entries(directives)
    .map(([directive, values]) => `${directive} ${values.join(" ")};`)
    .join(" ");
}
