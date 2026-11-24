/**
 * __tests__/security/ingressIpResolver.test.ts
 *
 * Verification & Deployment Fixtures for Ingress-Aware IP Resolution (Issue #410).
 *
 * Verifies:
 * 1. Direct traffic from untrusted callers ignores forged forwarding headers.
 * 2. Approved ingress connections accept forwarding headers.
 * 3. Proxy chains are parsed correctly (both leftmost and rightmost-untrusted).
 * 4. IPv4 and IPv6 representations are normalized canonically (RFC 5952).
 * 5. Equivalent representations produce identical results across all routes and rate limits.
 */

import { NextRequest } from "next/server";
import {
  getClientIp,
  resolveClientIp,
  normalizeIp,
  isApprovedIngress,
  isIpInCidr,
  stripPort,
  DEFAULT_TRUSTED_INGRESS_CIDRS,
} from "@/lib/security/ipResolver";
import { getClientIp as getRateLimiterIp } from "@/lib/auth/rateLimiter";

describe("Ingress-Aware Client IP Resolver (Issue #410)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // --------------------------------------------------------------------------
  // 1. IP Normalization (RFC 5952 & IPv4)
  // --------------------------------------------------------------------------
  describe("IP Normalization & Canonical Representation", () => {
    it("strips ports and enclosing brackets from IPv4 and IPv6 addresses", () => {
      expect(stripPort("192.0.2.1:8080")).toBe("192.0.2.1");
      expect(stripPort("[2001:db8::1]:443")).toBe("2001:db8::1");
      expect(stripPort("[::1]:3000")).toBe("::1");
      expect(stripPort("192.0.2.1")).toBe("192.0.2.1");
      expect(stripPort("2001:db8::1")).toBe("2001:db8::1");
    });

    it("normalizes IPv4 dotted-quads without octal or leading zeroes", () => {
      expect(normalizeIp("192.168.001.001")).toBe("192.168.1.1");
      expect(normalizeIp("10.000.000.001")).toBe("10.0.0.1");
      expect(normalizeIp("127.0.0.1")).toBe("127.0.0.1");
      expect(normalizeIp("256.0.0.1")).toBeNull();
      expect(normalizeIp("invalid.ip")).toBeNull();
    });

    it("normalizes IPv4-mapped IPv6 addresses to canonical IPv4", () => {
      expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
      expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
      expect(normalizeIp("0:0:0:0:0:ffff:192.0.2.1")).toBe("192.0.2.1");
      expect(normalizeIp("[::ffff:192.0.2.1]:8080")).toBe("192.0.2.1");
    });

    it("normalizes equivalent IPv6 representations to canonical RFC 5952 format", () => {
      // Expanded vs compressed
      const expanded = "2001:0db8:0000:0000:0000:0000:0000:0001";
      const uncompressedZeros = "2001:db8:0:0:0:0:0:1";
      const compressed = "2001:db8::1";
      const uppercase = "2001:DB8::1";

      const norm1 = normalizeIp(expanded);
      const norm2 = normalizeIp(uncompressedZeros);
      const norm3 = normalizeIp(compressed);
      const norm4 = normalizeIp(uppercase);

      expect(norm1).toBe("2001:db8::1");
      expect(norm2).toBe("2001:db8::1");
      expect(norm3).toBe("2001:db8::1");
      expect(norm4).toBe("2001:db8::1");

      // All formats resolve to identical string
      expect(norm1).toBe(norm2);
      expect(norm2).toBe(norm3);
      expect(norm3).toBe(norm4);
    });

    it("normalizes loopback IPv6 representations consistently to ::1", () => {
      expect(normalizeIp("::1")).toBe("::1");
      expect(normalizeIp("0:0:0:0:0:0:0:1")).toBe("::1");
      expect(normalizeIp("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
      expect(normalizeIp("[::1]:8080")).toBe("::1");
    });

    it("normalizes unspecified IPv6 to ::", () => {
      expect(normalizeIp("::")).toBe("::");
      expect(normalizeIp("0:0:0:0:0:0:0:0")).toBe("::");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Approved Ingress Detection & CIDR Matching
  // --------------------------------------------------------------------------
  describe("Approved Ingress CIDR Matching", () => {
    it("matches IPv4 in IPv4 CIDR blocks", () => {
      expect(isIpInCidr("127.0.0.1", "127.0.0.0/8")).toBe(true);
      expect(isIpInCidr("10.5.2.1", "10.0.0.0/8")).toBe(true);
      expect(isIpInCidr("172.20.1.1", "172.16.0.0/12")).toBe(true);
      expect(isIpInCidr("192.168.1.100", "192.168.0.0/16")).toBe(true);
      expect(isIpInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
      expect(isIpInCidr("203.0.113.1", "127.0.0.0/8")).toBe(false);
    });

    it("matches IPv6 in IPv6 CIDR blocks", () => {
      expect(isIpInCidr("::1", "::1/128")).toBe(true);
      expect(isIpInCidr("fe80::1", "fe80::/10")).toBe(true);
      expect(isIpInCidr("fc00::1", "fc00::/7")).toBe(true);
      expect(isIpInCidr("2001:db8::1", "fc00::/7")).toBe(false);
    });

    it("identifies default approved ingress ranges correctly", () => {
      expect(isApprovedIngress("127.0.0.1")).toBe(true);
      expect(isApprovedIngress("::1")).toBe(true);
      expect(isApprovedIngress("10.0.0.1")).toBe(true);
      expect(isApprovedIngress("172.16.0.5")).toBe(true);
      expect(isApprovedIngress("192.168.1.1")).toBe(true);
      expect(isApprovedIngress("169.254.1.1")).toBe(true);

      // Untrusted public IPs are NOT approved ingresses
      expect(isApprovedIngress("203.0.113.50")).toBe(false);
      expect(isApprovedIngress("198.51.100.25")).toBe(false);
      expect(isApprovedIngress("8.8.8.8")).toBe(false);
    });

    it("respects custom TRUSTED_INGRESS_PROXIES environment variable", () => {
      process.env.TRUSTED_INGRESS_PROXIES = "203.0.113.0/24, 198.51.100.1";
      expect(isApprovedIngress("203.0.113.50")).toBe(true);
      expect(isApprovedIngress("198.51.100.1")).toBe(true);
      expect(isApprovedIngress("198.51.100.2")).toBe(false);
      expect(isApprovedIngress("10.0.0.1")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Deployment Fixture: Direct Traffic vs Forged Headers
  // --------------------------------------------------------------------------
  describe("Deployment Fixture: Direct Traffic (Untrusted Direct Peer)", () => {
    it("rejects forged X-Forwarded-For on direct untrusted connection and returns direct peer IP", () => {
      const directReq = new NextRequest("http://example.com/api/test", {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });

      // Direct caller connecting from public IP 198.51.100.25 (not an approved ingress)
      const ip = resolveClientIp(directReq, { directIp: "198.51.100.25" });
      expect(ip).toBe("198.51.100.25");
    });

    it("rejects forged X-Real-IP on direct untrusted connection", () => {
      const directReq = new NextRequest("http://example.com/api/test", {
        headers: { "x-real-ip": "8.8.8.8" },
      });

      const ip = resolveClientIp(directReq, { directIp: "203.0.113.77" });
      expect(ip).toBe("203.0.113.77");
    });

    it("rejects forged CF-Connecting-IP on direct untrusted connection", () => {
      const directReq = new NextRequest("http://example.com/api/test", {
        headers: { "cf-connecting-ip": "9.9.9.9" },
      });

      const ip = resolveClientIp(directReq, { directIp: "203.0.113.88" });
      expect(ip).toBe("203.0.113.88");
    });

    it("rejects forged RFC 7239 Forwarded header on direct untrusted connection", () => {
      const directReq = new NextRequest("http://example.com/api/test", {
        headers: { forwarded: "for=1.1.1.1;proto=https" },
      });

      const ip = resolveClientIp(directReq, { directIp: "203.0.113.99" });
      expect(ip).toBe("203.0.113.99");
    });

    it("prevents direct caller from evading IP limits by rotating forwarded headers", () => {
      // Caller sending different spoofed headers on each request
      const reqA = new NextRequest("http://example.com/api/test", {
        headers: { "x-forwarded-for": "100.1.1.1" },
      });
      const reqB = new NextRequest("http://example.com/api/test", {
        headers: { "x-forwarded-for": "100.1.1.2" },
      });

      const callerDirectIp = "198.51.100.42";
      const resolvedA = resolveClientIp(reqA, { directIp: callerDirectIp });
      const resolvedB = resolveClientIp(reqB, { directIp: callerDirectIp });

      // Both requests resolve to caller's real direct IP
      expect(resolvedA).toBe("198.51.100.42");
      expect(resolvedB).toBe("198.51.100.42");
      expect(resolvedA).toBe(resolvedB);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Deployment Fixture: Ingress Reverse Proxies & Proxy Chains
  // --------------------------------------------------------------------------
  describe("Deployment Fixture: Approved Ingress & Proxy Chains", () => {
    it("accepts X-Forwarded-For when direct peer is an approved ingress", () => {
      const ingressReq = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "203.0.113.195" },
      });

      // Direct peer is 10.0.0.1 (approved cluster ingress / load balancer)
      const ip = resolveClientIp(ingressReq, { directIp: "10.0.0.1" });
      expect(ip).toBe("203.0.113.195");
    });

    it("extracts client IP from proxy chain through approved ingress (leftmost)", () => {
      const ingressReq = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
      });

      const ip = resolveClientIp(ingressReq, { directIp: "10.0.0.1" });
      expect(ip).toBe("203.0.113.195");
    });

    it("supports rightmost-untrusted traversal strategy in multi-hop chains", () => {
      // Attacker injected spoofed 1.1.1.1, connects from 198.51.100.77 through ingress
      const chainReq = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.77, 10.0.0.5" },
      });

      // Direct peer is 10.0.0.1 (approved ingress)
      // 10.0.0.5 is trusted upstream ingress; 198.51.100.77 is first untrusted upstream
      const ip = resolveClientIp(chainReq, {
        directIp: "10.0.0.1",
        strategy: "rightmost-untrusted",
      });
      expect(ip).toBe("198.51.100.77");
    });

    it("parses RFC 7239 Forwarded header correctly through approved ingress", () => {
      const forwardedReq = new NextRequest("http://example.com/api/auth", {
        headers: { forwarded: 'for="[2001:db8::1]:443";proto=https, for=10.0.0.2' },
      });

      const ip = resolveClientIp(forwardedReq, { directIp: "10.0.0.1" });
      expect(ip).toBe("2001:db8::1");
    });

    it("accepts CF-Connecting-IP and X-Real-IP when from approved ingress", () => {
      const cfReq = new NextRequest("http://example.com/api/auth", {
        headers: { "cf-connecting-ip": "198.51.100.200" },
      });
      expect(resolveClientIp(cfReq, { directIp: "10.0.0.1" })).toBe("198.51.100.200");

      const realIpReq = new NextRequest("http://example.com/api/auth", {
        headers: { "x-real-ip": "198.51.100.201" },
      });
      expect(resolveClientIp(realIpReq, { directIp: "10.0.0.1" })).toBe("198.51.100.201");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Cross-Route Uniformity & Rate Limiter Integration
  // --------------------------------------------------------------------------
  describe("Cross-Route Uniformity (Single Resolver Invariant)", () => {
    it("ensures rateLimiter getClientIp delegates to the single ingress-aware resolver", () => {
      const req = new NextRequest("http://localhost/api/auth", {
        headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
      });

      const resolverIp = getClientIp(req);
      const rateLimiterResolved = getRateLimiterIp(req);

      expect(resolverIp).toBe("203.0.113.195");
      expect(rateLimiterResolved).toBe("203.0.113.195");
      expect(resolverIp).toBe(rateLimiterResolved);
    });

    it("maps equivalent IPv6 representations to the same rate limit key", () => {
      const req1 = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "2001:0DB8:0000:0000:0000:0000:0000:0001" },
      });
      const req2 = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "2001:db8::1" },
      });
      const req3 = new NextRequest("http://example.com/api/auth", {
        headers: { "x-forwarded-for": "[2001:db8::1]:8080" },
      });

      const ip1 = getClientIp(req1, { directIp: "127.0.0.1" });
      const ip2 = getClientIp(req2, { directIp: "127.0.0.1" });
      const ip3 = getClientIp(req3, { directIp: "127.0.0.1" });

      expect(ip1).toBe("2001:db8::1");
      expect(ip2).toBe("2001:db8::1");
      expect(ip3).toBe("2001:db8::1");
      expect(ip1).toBe(ip2);
      expect(ip2).toBe(ip3);
    });
  });
});
