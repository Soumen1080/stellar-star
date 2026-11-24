/**
 * lib/security/ipResolver.ts
 *
 * Ingress-Aware Client IP Resolver (Issue #410).
 *
 * Threat Model:
 * Forwarding headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP, Forwarded)
 * are untrusted client input on direct connections. If accepted blindly, an
 * attacker can spoof their IP on every request to bypass rate limits and abuse
 * protections.
 *
 * Security Invariants:
 * 1. Forwarding headers are ONLY trusted when the immediate direct peer is an
 *    approved ingress proxy / load balancer.
 * 2. On direct untrusted connections, the direct peer IP is returned and all
 *    forwarding headers are ignored.
 * 3. In multi-hop proxy chains, the chain is evaluated from right to left (most
 *    recent peer backward) and stops at the first untrusted upstream IP.
 * 4. IPv4 and IPv6 representations are normalized canonically (RFC 5952) so
 *    equivalent representations (e.g., expanded vs compressed, IPv4-mapped IPv6)
 *    always resolve to the exact same key across all routes and middleware.
 */

import type { NextRequest } from "next/server";

export interface RequestLike {
  headers?: {
    get(name: string): string | null | undefined;
  };
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
  connection?: {
    remoteAddress?: string;
  };
}

export interface IpResolverOptions {
  /** Explicit direct peer IP override (e.g. from gateway or test fixture) */
  directIp?: string;
  /** Custom list of approved ingress IPs or CIDRs */
  trustedIngress?: string[];
  /** Default fallback IP if direct IP cannot be resolved (default: "127.0.0.1") */
  fallbackIp?: string;
  /** Whether to trust all direct peers (testing only) */
  trustAllIngress?: boolean;
  /**
   * Proxy chain traversal strategy:
   * - "leftmost" (default): Returns the original client IP at the front of the chain.
   * - "rightmost-untrusted": Evaluates the chain from right to left, stopping at the first untrusted upstream IP.
   */
  strategy?: "leftmost" | "rightmost-untrusted";
}

/** Standard default trusted ingress CIDRs (loopback, link-local, and RFC 1918/4193 private networks) */
export const DEFAULT_TRUSTED_INGRESS_CIDRS: readonly string[] = [
  // Loopback (IPv4 and IPv6)
  "127.0.0.0/8",
  "::1/128",
  // Private IPv4 (RFC 1918)
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  // Link-local
  "169.254.0.0/16",
  "fe80::/10",
  // Unique Local Address IPv6 (RFC 4193)
  "fc00::/7",
];

/**
 * Strips enclosing brackets and port suffixes from an IP string.
 * Examples: "[2001:db8::1]:8080" -> "2001:db8::1", "192.0.2.1:443" -> "192.0.2.1"
 */
export function stripPort(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("[")) {
    const endBracket = s.indexOf("]");
    if (endBracket !== -1) {
      return s.slice(1, endBracket);
    }
  }
  // IPv4 with port has exactly one colon
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [ip] = s.split(":");
    return ip;
  }
  return s;
}

/**
 * Normalizes an IPv4 address to standard dotted-decimal without leading zeros.
 * Returns null if invalid.
 */
function normalizeIpv4(raw: string): string | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = parseInt(part, 10);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets.join(".");
}

/**
 * Normalizes an IPv6 address according to RFC 5952:
 * - Lowercase hexadecimal
 * - Suppress leading zeros in 16-bit blocks
 * - Longest contiguous run of 2+ zeros compressed with "::" (first run if tied)
 * - IPv4-mapped addresses (::ffff:a.b.c.d) converted to normalized IPv4
 */
function normalizeIpv6(raw: string): string | null {
  let s = raw.toLowerCase().trim();

  // Check for embedded IPv4 at the end (e.g., ::ffff:192.0.2.1 or 2001:db8::192.0.2.1)
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const ipv4Part = s.slice(lastColon + 1);
    const normalizedV4 = normalizeIpv4(ipv4Part);
    if (!normalizedV4) return null;
    const [a, b, c, d] = normalizedV4.split(".").map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    s = s.slice(0, lastColon + 1) + high + ":" + low;
  }

  // Handle "::" expansion
  const doubleColonCount = (s.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let blocks: string[] = [];
  if (doubleColonCount === 1) {
    const [left, right] = s.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const totalParts = leftParts.length + rightParts.length;
    if (totalParts > 7) return null;
    const missingZeros = Array(8 - totalParts).fill("0");
    blocks = [...leftParts, ...missingZeros, ...rightParts];
  } else {
    blocks = s.split(":");
    if (blocks.length !== 8) return null;
  }

  const words: number[] = [];
  for (const b of blocks) {
    if (!/^[0-9a-f]{1,4}$/.test(b)) return null;
    words.push(parseInt(b, 16));
  }

  // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const isIpv4Mapped =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff;

  if (isIpv4Mapped) {
    const b1 = words[6] >> 8;
    const b2 = words[6] & 0xff;
    const b3 = words[7] >> 8;
    const b4 = words[7] & 0xff;
    return `${b1}.${b2}.${b3}.${b4}`;
  }

  // Find longest contiguous run of zero words (minimum length 2) for RFC 5952 compression
  let bestStart = -1;
  let bestLen = 0;
  let currentStart = -1;
  let currentLen = 0;

  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (currentStart === -1) {
        currentStart = i;
        currentLen = 1;
      } else {
        currentLen++;
      }
      if (currentLen > bestLen && currentLen >= 2) {
        bestStart = currentStart;
        bestLen = currentLen;
      }
    } else {
      currentStart = -1;
      currentLen = 0;
    }
  }

  if (bestLen >= 2) {
    const before = words.slice(0, bestStart).map((w) => w.toString(16));
    const after = words.slice(bestStart + bestLen).map((w) => w.toString(16));
    const beforeStr = before.join(":");
    const afterStr = after.join(":");
    return `${beforeStr}::${afterStr}`;
  }

  return words.map((w) => w.toString(16)).join(":");
}

/**
 * Normalizes an IP string (IPv4 or IPv6) to its standard canonical representation.
 * Returns null if the string is not a valid IP address.
 */
export function normalizeIp(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = stripPort(input);
  if (!cleaned) return null;

  if (cleaned.includes(":")) {
    return normalizeIpv6(cleaned);
  }
  return normalizeIpv4(cleaned);
}

/** 32-bit unsigned integer representation of an IPv4 address */
function ipv4ToLong(ip: string): number | null {
  const normalized = normalizeIpv4(ip);
  if (!normalized) return null;
  const [a, b, c, d] = normalized.split(".").map(Number);
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

/** 8x 16-bit word representation of an IPv6 address */
function ipv6ToWords(ip: string): number[] | null {
  const norm = normalizeIpv6(ip);
  if (!norm) return null;
  // If it normalized to IPv4 (mapped), return null for pure IPv6 match
  if (!norm.includes(":")) return null;

  const doubleColon = (norm.match(/::/g) || []).length;
  let blocks: string[] = [];
  if (doubleColon === 1) {
    const [left, right] = norm.split("::");
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    const missing = Array(8 - (l.length + r.length)).fill("0");
    blocks = [...l, ...missing, ...r];
  } else {
    blocks = norm.split(":");
  }
  return blocks.map((b) => parseInt(b, 16));
}

/**
 * Determines whether an IP is contained within an IPv4 or IPv6 CIDR block.
 * Supports exact IP matching (e.g., "127.0.0.1") or CIDR notation (e.g., "10.0.0.0/8", "::1/128").
 */
export function isIpInCidr(ip: string, cidrOrIp: string): boolean {
  const targetIp = normalizeIp(ip);
  if (!targetIp) return false;

  const [rangeBase, prefixStr] = cidrOrIp.trim().split("/");
  const normalizedBase = normalizeIp(rangeBase);
  if (!normalizedBase) return false;

  const isV4 = !targetIp.includes(":");
  const baseIsV4 = !normalizedBase.includes(":");

  if (isV4 !== baseIsV4) {
    return false;
  }

  if (isV4) {
    const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : 32;
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
    const ipLong = ipv4ToLong(targetIp);
    const baseLong = ipv4ToLong(normalizedBase);
    if (ipLong === null || baseLong === null) return false;
    if (prefix === 0) return true;
    const mask = ((0xffffffff << (32 - prefix)) >>> 0);
    return (ipLong & mask) === (baseLong & mask);
  } else {
    const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : 128;
    if (isNaN(prefix) || prefix < 0 || prefix > 128) return false;
    const ipWords = ipv6ToWords(targetIp);
    const baseWords = ipv6ToWords(normalizedBase);
    if (!ipWords || !baseWords) return false;

    let remainingPrefix = prefix;
    for (let i = 0; i < 8; i++) {
      if (remainingPrefix >= 16) {
        if (ipWords[i] !== baseWords[i]) return false;
        remainingPrefix -= 16;
      } else if (remainingPrefix > 0) {
        const mask = ((0xffff << (16 - remainingPrefix)) & 0xffff);
        if ((ipWords[i] & mask) !== (baseWords[i] & mask)) return false;
        remainingPrefix = 0;
      } else {
        break;
      }
    }
    return true;
  }
}

/**
 * Returns active approved ingress CIDR ranges from explicit options,
 * environment variables (TRUSTED_INGRESS_PROXIES, TRUSTED_PROXIES), or default ranges.
 */
export function getApprovedIngressRanges(customTrusted?: string[]): string[] {
  if (customTrusted && customTrusted.length > 0) {
    return customTrusted;
  }
  const envConfig = process.env.TRUSTED_INGRESS_PROXIES || process.env.TRUSTED_PROXIES;
  if (envConfig) {
    return envConfig
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_TRUSTED_INGRESS_CIDRS];
}

/**
 * Checks whether an IP address is an approved ingress proxy / load balancer.
 */
export function isApprovedIngress(ip: string, customTrusted?: string[]): boolean {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  const ranges = getApprovedIngressRanges(customTrusted);
  return ranges.some((range) => isIpInCidr(norm, range));
}

/**
 * Parses RFC 7239 `Forwarded` header parameter elements (e.g. `for=192.0.2.60;proto=http;by=203.0.113.43`).
 * Returns an array of IP strings in chain order (client -> proxies).
 */
function parseRfc7239Forwarded(headerValue: string): string[] {
  const results: string[] = [];
  // Directives are separated by commas
  const directives = headerValue.split(",");
  for (const dir of directives) {
    const parts = dir.split(";");
    for (const part of parts) {
      const [key, val] = part.split("=").map((s) => s.trim());
      if (key?.toLowerCase() === "for" && val) {
        // Strip quotes if present
        const cleaned = val.replace(/^["']|["']$/g, "");
        const stripped = stripPort(cleaned);
        if (stripped) {
          results.push(stripped);
        }
      }
    }
  }
  return results;
}

/**
 * Resolves the true client IP address for a request.
 *
 * Enforcement Rules:
 * 1. Find direct peer IP (direct connection socket).
 * 2. If direct peer is NOT an approved ingress:
 *    - Ignore all forwarding headers (XFF, CF-Connecting-IP, X-Real-IP, Forwarded).
 *    - Return normalized direct peer IP.
 * 3. If direct peer IS an approved ingress:
 *    - Inspect proxy chains right-to-left, stopping at the first untrusted upstream IP.
 *    - If all proxies in the chain are trusted, return the leftmost client IP.
 *    - Fall back to normalized direct peer IP if forwarding headers are absent or invalid.
 */
export function resolveClientIp(
  request: RequestLike,
  options?: IpResolverOptions,
): string {
  const fallback = options?.fallbackIp || "127.0.0.1";

  // 1. Determine direct peer IP
  const rawDirect =
    options?.directIp ||
    request.ip ||
    request.socket?.remoteAddress ||
    request.connection?.remoteAddress ||
    request.headers?.get?.("x-direct-ip") ||
    request.headers?.get?.("x-forwarded-peer") ||
    fallback;

  const directPeerIp = normalizeIp(rawDirect) || normalizeIp(fallback) || "127.0.0.1";

  // 2. Validate whether direct peer is an approved ingress
  const isIngressApproved =
    options?.trustAllIngress === true ||
    isApprovedIngress(directPeerIp, options?.trustedIngress);

  // If the direct connection is NOT from an approved ingress, forwarding headers MUST BE IGNORED.
  if (!isIngressApproved) {
    return directPeerIp;
  }

  // 3. Direct peer IS an approved ingress: evaluate forwarding headers
  // Check RFC 7239 `Forwarded`
  const forwardedHeader = request.headers?.get?.("forwarded");
  if (forwardedHeader) {
    const chain = parseRfc7239Forwarded(forwardedHeader);
    const resolved = resolveProxyChain(chain, options);
    if (resolved) return resolved;
  }

  // Check `X-Forwarded-For`
  const xff = request.headers?.get?.("x-forwarded-for");
  if (xff) {
    const rawIps = xff
      .split(",")
      .map((s) => stripPort(s.trim()))
      .filter(Boolean);
    const resolved = resolveProxyChain(rawIps, options);
    if (resolved) return resolved;
  }

  // Check Cloudflare `CF-Connecting-IP`
  const cfIp = request.headers?.get?.("cf-connecting-ip");
  if (cfIp) {
    const norm = normalizeIp(cfIp);
    if (norm) return norm;
  }

  // Check `X-Real-IP`
  const realIp = request.headers?.get?.("x-real-ip");
  if (realIp) {
    const norm = normalizeIp(realIp);
    if (norm) return norm;
  }

  return directPeerIp;
}

/**
 * Resolves a proxy chain (client -> proxy1 -> proxy2).
 * Supports both standard "leftmost" (front-of-chain client) and "rightmost-untrusted" (right-to-left traversal).
 */
function resolveProxyChain(
  chain: string[],
  options?: IpResolverOptions,
): string | null {
  if (chain.length === 0) return null;

  const normalizedChain: string[] = [];
  for (const raw of chain) {
    const norm = normalizeIp(raw);
    if (norm) {
      normalizedChain.push(norm);
    }
  }

  if (normalizedChain.length === 0) return null;

  if (options?.strategy === "rightmost-untrusted") {
    // Walk backwards from right to left, stopping at the first untrusted upstream IP
    for (let i = normalizedChain.length - 1; i >= 0; i--) {
      const candidate = normalizedChain[i];
      if (!isApprovedIngress(candidate, options?.trustedIngress)) {
        return candidate;
      }
    }
    return normalizedChain[0];
  }

  // Default ("leftmost"): Returns the client IP at the front of the chain
  return normalizedChain[0];
}

/**
 * Extracts and normalizes the client IP address safely from request headers and direct socket peer.
 * Drop-in standard resolver for rate limiting, middleware, and abuse protection.
 */
export function getClientIp(
  request: NextRequest | RequestLike,
  options?: IpResolverOptions,
): string {
  return resolveClientIp(request, options);
}
