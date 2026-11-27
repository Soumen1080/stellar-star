import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  buildContentSecurityPolicy,
  generateCSPNonce,
  CSP_HEADER_NAME,
  CSP_NONCE_HEADER,
  TRUSTED_CONNECT_ORIGINS,
  TRUSTED_IMG_ORIGINS,
} from "@/lib/security/csp";
import { POST as cspReportRoute, GET as cspGetRoute } from "@/app/api/csp/report/route";

describe("Tightened Content Security Policy (#457)", () => {
  const rootDir = process.cwd();

  describe("1. Policy Hardening (No unsafe-eval / unsafe-inline in production)", () => {
    it("never includes 'unsafe-eval' in production CSP", () => {
      const prodCsp = buildContentSecurityPolicy({ isDev: false });
      expect(prodCsp).not.toContain("'unsafe-eval'");
    });

    it("includes nonce and 'strict-dynamic' when nonce is provided", () => {
      const nonce = generateCSPNonce();
      const policy = buildContentSecurityPolicy({ nonce, isDev: false });

      expect(policy).toContain(`'nonce-${nonce}'`);
      expect(policy).toContain("'strict-dynamic'");
      expect(policy).toContain("script-src 'self'");
    });

    it("permits 'unsafe-eval' ONLY when isDev is true (for Next.js Fast Refresh)", () => {
      const devCsp = buildContentSecurityPolicy({ isDev: true });
      expect(devCsp).toContain("'unsafe-eval'");
    });

    it("verifies next.config.mjs has no 'unsafe-eval' or 'unsafe-inline' in script-src", () => {
      const nextConfigPath = path.join(rootDir, "next.config.mjs");
      const nextConfig = fs.readFileSync(nextConfigPath, "utf8");

      expect(nextConfig).toContain("Content-Security-Policy");
      // Script-src in nextConfig must not allow unsafe-eval or unsafe-inline
      const cspMatch = nextConfig.match(/key:\s*"Content-Security-Policy",\s*value:\s*"([^"]+)"/);
      expect(cspMatch).not.toBeNull();
      const cspValue = cspMatch![1];

      const scriptSrcDirective = cspValue
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("script-src"));

      expect(scriptSrcDirective).toBeDefined();
      expect(scriptSrcDirective).not.toContain("'unsafe-eval'");
      expect(scriptSrcDirective).not.toContain("'unsafe-inline'");
      expect(cspValue).toContain("report-uri /api/csp/report");
    });
  });

  describe("2. Origin Minimization & Core Flows Support (Wallet, QR, OCR)", () => {
    it("allows QR code rendering (data: and inline SVG/canvas)", () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("img-src 'self' data: blob:");
    });

    it("allows OCR local image preview and web workers (blob: and data:)", () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("worker-src 'self' blob:");
    });

    it("restricts connect-src strictly to self, Stellar network endpoints, and Supabase", () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("https://*.stellar.org");
      expect(csp).toContain("https://horizon.stellar.org");
      expect(csp).toContain("https://horizon-testnet.stellar.org");
      expect(csp).toContain("https://rpc.stellar.org");
      expect(csp).toContain("https://soroban-testnet.stellar.org");
      expect(csp).toContain("https://*.supabase.co");
      expect(csp).toContain("wss://*.supabase.co");
    });

    it("strictly forbids external frames and embeds", () => {
      const csp = buildContentSecurityPolicy({ isDev: false });
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
    });
  });

  describe("3. Nonce Generation and Middleware Injection", () => {
    it("generates a high-entropy base64 nonce", () => {
      const nonce1 = generateCSPNonce();
      const nonce2 = generateCSPNonce();

      expect(typeof nonce1).toBe("string");
      expect(nonce1).toHaveLength(24); // 16 bytes base64 = 24 chars
      expect(nonce1).not.toBe(nonce2);
    });

    it("verifies middleware.ts injects CSP headers and nonce", () => {
      const middlewarePath = path.join(rootDir, "middleware.ts");
      const middlewareContent = fs.readFileSync(middlewarePath, "utf8");

      expect(middlewareContent).toContain("generateCSPNonce");
      expect(middlewareContent).toContain("buildContentSecurityPolicy");
      expect(middlewareContent).toContain("CSP_HEADER_NAME");
      expect(middlewareContent).toContain("CSP_NONCE_HEADER");
    });
  });

  describe("4. CSP Violation Reporting Endpoint (/api/csp/report)", () => {
    it("accepts and sanitizes standard application/csp-report violations", async () => {
      const violationPayload = {
        "csp-report": {
          "document-uri": "https://stellarstar.app/trips/123",
          referrer: "",
          "violated-directive": "script-src",
          "effective-directive": "script-src",
          "original-policy": "default-src 'self'; script-src 'self';",
          disposition: "enforce",
          "blocked-uri": "https://malicious-cdn.com/evil.js",
          "line-number": 42,
          "column-number": 18,
          "source-file": "https://stellarstar.app/main.js",
          "status-code": 200,
          "script-sample": "console.log('injected')",
        },
      };

      const req = new NextRequest("http://localhost:3000/api/csp/report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body: JSON.stringify(violationPayload),
      });

      const res = await cspReportRoute(req);
      expect(res.status).toBe(204);

      // Verify recorded violation via GET
      const getRes = await cspGetRoute();
      expect(getRes.status).toBe(200);
      const data = await getRes.json();
      expect(data.ok).toBe(true);
      expect(data.count).toBeGreaterThan(0);
      expect(data.violations[0].blockedUri).toBe("https://malicious-cdn.com/evil.js");
      expect(data.violations[0].violatedDirective).toBe("script-src");
      expect(data.violations[0].clientIpHash).toBeDefined();
    });

    it("handles empty or malformed report payloads gracefully with 400", async () => {
      const req = new NextRequest("http://localhost:3000/api/csp/report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body: "invalid-non-json-content",
      });

      const res = await cspReportRoute(req);
      expect(res.status).toBe(400);
    });
  });
});
