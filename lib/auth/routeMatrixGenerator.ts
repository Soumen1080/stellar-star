/**
 * lib/auth/routeMatrixGenerator.ts
 *
 * Issue #456: Generates test cases across Anonymous, Wrong-Wallet, Expired,
 * Malformed, and Authorized callers for all routes.
 */

import { ROUTE_AUTHORIZATION_CATALOG } from "./routeCatalog";
import type { RouteAuthCategory, RouteAuthMatrixTestCase } from "@/types/authContract";

/**
 * Generates authorization matrix test cases for all classified routes.
 */
export function generateRouteAuthMatrix(): RouteAuthMatrixTestCase[] {
  const cases: RouteAuthMatrixTestCase[] = [];

  for (const entry of ROUTE_AUTHORIZATION_CATALOG) {
    for (const method of entry.methods) {
      if (method === "OPTIONS" || method === "HEAD") continue;

      switch (entry.authCategory) {
        case "public":
          cases.push({
            route: entry.path,
            method,
            category: "public",
            scenario: "anonymous",
            expectedStatus: [200, 201, 202, 400], // Public routes never fail with 401/403 for missing auth
            description: `${method} ${entry.path} allows anonymous access (does not reject with 401/403)`,
          });
          break;

        case "wallet":
          cases.push(
            {
              route: entry.path,
              method,
              category: "wallet",
              scenario: "anonymous",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects anonymous callers with 401`,
            },
            {
              route: entry.path,
              method,
              category: "wallet",
              scenario: "expired_token",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects expired session token with 401`,
            },
            {
              route: entry.path,
              method,
              category: "wallet",
              scenario: "malformed_token",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects malformed session token with 401`,
            },
            {
              route: entry.path,
              method,
              category: "wallet",
              scenario: "wrong_wallet",
              expectedStatus: [403, 404],
              description: `${method} ${entry.path} refuses unrelated/unauthorized wallet with 403 or 404`,
            },
            {
              route: entry.path,
              method,
              category: "wallet",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts valid authorized wallet session without 401/403`,
            }
          );
          break;

        case "staff":
          cases.push(
            {
              route: entry.path,
              method,
              category: "staff",
              scenario: "anonymous",
              expectedStatus: [401, 403],
              description: `${method} ${entry.path} rejects anonymous callers with 401/403`,
            },
            {
              route: entry.path,
              method,
              category: "staff",
              scenario: "wrong_wallet",
              expectedStatus: [401, 403],
              description: `${method} ${entry.path} rejects non-staff regular wallet callers with 401/403`,
            },
            {
              route: entry.path,
              method,
              category: "staff",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts authorized staff caller`,
            }
          );
          break;

        case "cron":
          cases.push(
            {
              route: entry.path,
              method,
              category: "cron",
              scenario: "anonymous",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects anonymous callers with 401`,
            },
            {
              route: entry.path,
              method,
              category: "cron",
              scenario: "wrong_wallet",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects regular user wallet bearer with 401 (requires cron secret)`,
            },
            {
              route: entry.path,
              method,
              category: "cron",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts authorized cron secret`,
            }
          );
          break;

        case "api_token":
          cases.push(
            {
              route: entry.path,
              method,
              category: "api_token",
              scenario: "anonymous",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects anonymous callers without API token`,
            },
            {
              route: entry.path,
              method,
              category: "api_token",
              scenario: "malformed_token",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects invalid API token format`,
            },
            {
              route: entry.path,
              method,
              category: "api_token",
              scenario: "expired_token",
              expectedStatus: 401,
              description: `${method} ${entry.path} rejects expired API token`,
            },
            {
              route: entry.path,
              method,
              category: "api_token",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts valid scoped token`,
            }
          );
          break;

        case "wallet_or_staff":
          cases.push(
            {
              route: entry.path,
              method,
              category: "wallet_or_staff",
              scenario: "anonymous",
              expectedStatus: [401, 403],
              description: `${method} ${entry.path} rejects anonymous callers`,
            },
            {
              route: entry.path,
              method,
              category: "wallet_or_staff",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts authenticated wallet or staff caller`,
            }
          );
          break;

        case "wallet_or_cron":
          cases.push(
            {
              route: entry.path,
              method,
              category: "wallet_or_cron",
              scenario: "anonymous",
              expectedStatus: [401, 403],
              description: `${method} ${entry.path} rejects anonymous callers`,
            },
            {
              route: entry.path,
              method,
              category: "wallet_or_cron",
              scenario: "authorized",
              expectedStatus: [200, 201, 202, 400],
              description: `${method} ${entry.path} accepts wallet or cron credentials`,
            }
          );
          break;
      }
    }
  }

  return cases;
}
