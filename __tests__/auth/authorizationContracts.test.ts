import fs from "node:fs";
import path from "node:path";
import { ROUTE_AUTHORIZATION_CATALOG, ROUTE_AUTH_MAP } from "@/lib/auth/routeCatalog";
import { generateRouteAuthMatrix } from "@/lib/auth/routeMatrixGenerator";

/**
 * Finds all route.ts files in app/api
 */
function discoverApiRouteFiles(dir: string, baseDir = dir): string[] {
  let routes: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routes = routes.concat(discoverApiRouteFiles(fullPath, baseDir));
    } else if (entry.name === "route.ts" || entry.name === "route.js") {
      // Normalize to relative URL path e.g. /api/trips/[id]
      const relPath = path.relative(baseDir, path.dirname(fullPath)).replace(/\\/g, "/");
      routes.push(`/api/${relPath}`);
    }
  }

  return routes;
}

describe("Authorization Contract Tests (#456)", () => {
  const rootDir = process.cwd();
  const apiDir = path.join(rootDir, "app", "api");

  describe("1. Route Classification Coverage (CI Gate)", () => {
    it("ensures EVERY route file on disk is classified in ROUTE_AUTHORIZATION_CATALOG", () => {
      const discoveredRoutes = discoverApiRouteFiles(apiDir);
      const catalogPaths = new Set(ROUTE_AUTHORIZATION_CATALOG.map((r) => r.path));

      const unclassified: string[] = [];
      for (const route of discoveredRoutes) {
        if (!catalogPaths.has(route)) {
          unclassified.push(route);
        }
      }

      if (unclassified.length > 0) {
        throw new Error(
          `CI rejected unclassified routes! The following ${unclassified.length} routes are missing from ROUTE_AUTHORIZATION_CATALOG in lib/auth/routeCatalog.ts:\n` +
            unclassified.map((r) => ` - ${r}`).join("\n") +
            `\nPlease classify each route as 'public', 'wallet', 'staff', 'cron', 'api_token', 'wallet_or_staff', or 'wallet_or_cron'.`
        );
      }

      expect(unclassified).toHaveLength(0);
      expect(discoveredRoutes.length).toBeGreaterThan(50);
    });

    it("ensures no stale/dead routes exist in the catalog", () => {
      const discoveredRoutes = new Set(discoverApiRouteFiles(apiDir));
      const staleRoutes: string[] = [];

      for (const meta of ROUTE_AUTHORIZATION_CATALOG) {
        if (!discoveredRoutes.has(meta.path)) {
          staleRoutes.push(meta.path);
        }
      }

      expect(staleRoutes).toHaveLength(0);
    });

    it("validates every catalog entry has valid HTTP methods and auth category", () => {
      const validCategories = new Set([
        "public",
        "wallet",
        "staff",
        "cron",
        "api_token",
        "wallet_or_staff",
        "wallet_or_cron",
      ]);

      const validMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

      for (const entry of ROUTE_AUTHORIZATION_CATALOG) {
        expect(validCategories.has(entry.authCategory)).toBe(true);
        expect(entry.methods.length).toBeGreaterThan(0);
        for (const m of entry.methods) {
          expect(validMethods.has(m)).toBe(true);
        }
      }
    });
  });

  describe("2. Authorization Matrix Generator", () => {
    it("generates comprehensive matrix covering anonymous, wrong-wallet, expired, and authorized cases", () => {
      const testCases = generateRouteAuthMatrix();
      expect(testCases.length).toBeGreaterThan(100);

      const scenarios = new Set(testCases.map((tc) => tc.scenario));
      expect(scenarios.has("anonymous")).toBe(true);
      expect(scenarios.has("wrong_wallet")).toBe(true);
      expect(scenarios.has("expired_token")).toBe(true);
      expect(scenarios.has("malformed_token")).toBe(true);
      expect(scenarios.has("authorized")).toBe(true);
    });

    it("verifies wallet routes enforce 401 for anonymous and expired cases", () => {
      const testCases = generateRouteAuthMatrix().filter(
        (tc) => tc.category === "wallet" && (tc.scenario === "anonymous" || tc.scenario === "expired_token")
      );

      for (const tc of testCases) {
        expect(tc.expectedStatus).toBe(401);
      }
    });

    it("verifies cron routes enforce 401 for anonymous and wrong-wallet cases", () => {
      const testCases = generateRouteAuthMatrix().filter(
        (tc) => tc.category === "cron" && (tc.scenario === "anonymous" || tc.scenario === "wrong_wallet")
      );

      for (const tc of testCases) {
        expect(tc.expectedStatus).toBe(401);
      }
    });

    it("verifies staff routes enforce 401/403 for anonymous and regular wallet callers", () => {
      const testCases = generateRouteAuthMatrix().filter(
        (tc) => tc.category === "staff" && (tc.scenario === "anonymous" || tc.scenario === "wrong_wallet")
      );

      for (const tc of testCases) {
        expect([401, 403]).toContain(Array.isArray(tc.expectedStatus) ? tc.expectedStatus[0] : tc.expectedStatus);
      }
    });
  });
});
