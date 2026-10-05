declare const __non_webpack_require__: typeof require | undefined;

/**
 * Lazily loads Node.js crypto in server environments without causing
 * bundlers (Webpack) to drag the Node crypto polyfill into client bundles.
 */
function getNodeCrypto(): typeof import("crypto") | null {
  if (typeof window !== "undefined") {
    return null;
  }
  if (
    typeof process !== "undefined" &&
    typeof (process as unknown as { getBuiltinModule?: (id: string) => typeof import("crypto") }).getBuiltinModule ===
      "function"
  ) {
    const mod = (
      process as unknown as { getBuiltinModule: (id: string) => typeof import("crypto") }
    ).getBuiltinModule("crypto");
    if (mod) return mod;
  }
  try {
    const req =
      typeof __non_webpack_require__ !== "undefined"
        ? __non_webpack_require__
        : typeof require !== "undefined"
          ? require
          : null;
    if (req) return req("crypto");
  } catch {
    // Ignore when require is not available in environment
  }
  return null;
}

/**
 * Generates a 256-bit cryptographically unguessable invitation token.
 * Browser-safe: uses the Web Crypto API (window.crypto.getRandomValues or globalThis.crypto.getRandomValues)
 * with a server-side Node fallback.
 */
export function generateInviteToken(): string {
  const webCrypto =
    typeof window !== "undefined"
      ? window.crypto
      : typeof globalThis !== "undefined"
        ? globalThis.crypto
        : undefined;

  if (webCrypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto?.randomBytes) {
    return nodeCrypto.randomBytes(32).toString("hex");
  }

  throw new Error("No secure cryptographic random number generator available.");
}

/**
 * Computes a deterministic SHA-256 hash of the invitation token.
 * Only the hash is stored in the database, protecting capabilities even if database is read.
 * Server-only synchronous hashing using Node's crypto module (lazily loaded).
 */
export function hashToken(token: string): string {
  const clean = (token ?? "").trim();
  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto?.createHash) {
    return nodeCrypto.createHash("sha256").update(clean).digest("hex");
  }
  throw new Error("hashToken is only supported in server environments.");
}

/**
 * Browser-safe asynchronous SHA-256 hash using the Web Crypto API (crypto.subtle.digest).
 */
export async function hashTokenWebCrypto(token: string): Promise<string> {
  const clean = (token ?? "").trim();
  const webCrypto =
    typeof window !== "undefined"
      ? window.crypto
      : typeof globalThis !== "undefined"
        ? globalThis.crypto
        : undefined;

  if (webCrypto?.subtle?.digest) {
    const data = new TextEncoder().encode(clean);
    const hashBuffer = await webCrypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  return hashToken(clean);
}

/**
 * Formats the public invitation URL for sharing.
 */
export function buildInviteUrl(token: string, baseUrl?: string): string {
  const origin = baseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/join/${token}`;
}
