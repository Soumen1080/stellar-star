import fs from "fs";
import path from "path";

describe("Security Review & Audit Findings (#309)", () => {
  const rootDir = path.resolve(__dirname, "../..");

  describe("SEC-F01 & SEC-F02: Supabase Stored Procedure Authorization and RLS", () => {
    const setupSqlPath = path.join(rootDir, "supabase-setup.sql");
    const migration12Path = path.join(rootDir, "migrations", "0012_security_review_hardening.sql");
    const setupSql = fs.readFileSync(setupSqlPath, "utf8");
    const migration12 = fs.readFileSync(migration12Path, "utf8");

    it("revokes execute from anon on mark_share_paid and update_expense_versioned", () => {
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.update_expense_versioned");
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.mark_share_paid");
      expect(setupSql).toContain("REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch");

      expect(migration12).toContain("REVOKE EXECUTE ON FUNCTION public.update_expense_versioned");
      expect(migration12).toContain("REVOKE EXECUTE ON FUNCTION public.mark_share_paid");
      expect(migration12).toContain("REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch");
    });

    it("verifies caller membership in update_expense_versioned", () => {
      expect(setupSql).toContain("member_wallets @> ARRAY[v_caller]");
      expect(migration12).toContain("member_wallets @> ARRAY[v_caller]");
    });

    it("pins search_path = public, pg_temp on SECURITY DEFINER functions", () => {
      expect(setupSql).toMatch(/CREATE OR REPLACE FUNCTION public\.update_expense_versioned[\s\S]*?SET search_path = public, pg_temp/);
      expect(setupSql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_trip_invite[\s\S]*?SET search_path = public, pg_temp/);
      expect(migration12).toMatch(/CREATE OR REPLACE FUNCTION public\.update_expense_versioned[\s\S]*?SET search_path = public, pg_temp/);
      expect(migration12).toMatch(/CREATE OR REPLACE FUNCTION public\.mark_share_paid[\s\S]*?SET search_path = public, pg_temp/);
    });
  });

  describe("SEC-F06: Content Security Policy & Security Headers", () => {
    const nextConfigPath = path.join(rootDir, "next.config.mjs");
    const nextConfig = fs.readFileSync(nextConfigPath, "utf8");

    it("enforces Content-Security-Policy header in production next config", () => {
      expect(nextConfig).toContain("Content-Security-Policy");
      expect(nextConfig).toContain("default-src 'self'");
      expect(nextConfig).toContain("frame-ancestors 'self'");
    });

    it("maintains Strict-Transport-Security header", () => {
      expect(nextConfig).toContain("Strict-Transport-Security");
      expect(nextConfig).toContain("max-age=63072000");
    });
  });

  describe("Responsible Disclosure & Documentation", () => {
    it("publishes SECURITY.md with security contact and response SLA", () => {
      const securityMdPath = path.join(rootDir, "SECURITY.md");
      expect(fs.existsSync(securityMdPath)).toBe(true);
      const content = fs.readFileSync(securityMdPath, "utf8");
      expect(content).toContain("security@stellarstar.app");
      expect(content).toContain("Reporting a Vulnerability");
      expect(content).toContain("Response & Remediation Timelines");
    });

    it("publishes SECURITY_AUDIT_REPORT.md with verified contract WASM and IDs", () => {
      const reportPath = path.join(rootDir, "docs", "SECURITY_AUDIT_REPORT.md");
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = fs.readFileSync(reportPath, "utf8");
      expect(report).toContain("d4b8e2194c776fa3528b17cebf33df0175b902eb7483842cbb105e165463f109");
      expect(report).toContain("CBS2BJQ4ZC2ZSAZ5XS47BGC6Q7VTMJA4SE2PVHFXGXAZI5ES6H645WHO");
      expect(report).toContain("SEC-F01");
      expect(report).toContain("SEC-F02");
    });
  });
});
