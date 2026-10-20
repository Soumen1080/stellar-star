/**
 * Production and Network Configuration Validation Tests (Issue #306).
 *
 * Verifies:
 *  1. Valid testnet configuration (defaults and overrides).
 *  2. Valid public network configuration (derived and explicit).
 *  3. Cross-network failures:
 *     - PUBLIC network with testnet Horizon, Soroban, Explorer, or USDC issuer.
 *     - TESTNET network with public endpoints or public USDC issuer.
 *     - Inconsistent endpoints across different networks.
 *  4. Production deployment rejection of placeholder or testnet contract IDs.
 *  5. Startup diagnostic non-sensitivity and secret leakage protection.
 */

import { validateConfig, CANONICAL_ENDPOINTS, CIRCLE_USDC, TESTNET_DEMO_CONTRACT } from "../../scripts/validate-config";
import * as constants from "@/lib/utils/constants";

describe("Production Configuration Validation (CI & Startup)", () => {
  const VALID_MAINNET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const VALID_MAINNET_POOL_CONTRACT = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const VALID_PUBLIC_URL = "https://stellar-star.app";

  describe("1. Valid Testnet Configuration", () => {
    it("accepts canonical testnet defaults with no errors", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.summary.network).toBe("TESTNET");
      expect(result.summary.horizon).toBe(CANONICAL_ENDPOINTS.TESTNET.horizon);
      expect(result.summary.sorobanRpc).toBe(CANONICAL_ENDPOINTS.TESTNET.sorobanRpc);
      expect(result.summary.explorer).toBe(CANONICAL_ENDPOINTS.TESTNET.explorer);
    });

    it("accepts valid testnet configuration with demo contract ID and testnet USDC issuer", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_CONTRACT_ID: TESTNET_DEMO_CONTRACT,
        NEXT_PUBLIC_USDC_ISSUER: CIRCLE_USDC.TESTNET,
        NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("2. Valid Public Network Configuration", () => {
    it("accepts valid public network configuration with mainnet contract and public USDC issuer", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_POOL_CONTRACT_ID: VALID_MAINNET_POOL_CONTRACT,
          NEXT_PUBLIC_USDC_ISSUER: CIRCLE_USDC.PUBLIC,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.summary.network).toBe("PUBLIC");
      expect(result.summary.horizon).toBe(CANONICAL_ENDPOINTS.PUBLIC.horizon);
      expect(result.summary.sorobanRpc).toBe(CANONICAL_ENDPOINTS.PUBLIC.sorobanRpc);
      expect(result.summary.explorer).toBe(CANONICAL_ENDPOINTS.PUBLIC.explorer);
    });
  });

  describe("3. Cross-Network Failures", () => {
    it("rejects testnet Horizon endpoint in public network configuration", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_HORIZON_URL: CANONICAL_ENDPOINTS.TESTNET.horizon,
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("HORIZON_URL") && e.includes("TESTNET"))).toBe(true);
    });

    it("rejects testnet Soroban RPC in public network configuration", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_SOROBAN_RPC_URL: CANONICAL_ENDPOINTS.TESTNET.sorobanRpc,
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("SOROBAN_RPC_URL") && e.includes("TESTNET"))).toBe(true);
    });

    it("rejects testnet Explorer in public network configuration", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_STELLAR_EXPLORER: CANONICAL_ENDPOINTS.TESTNET.explorer,
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("STELLAR_EXPLORER") && e.includes("TESTNET"))).toBe(true);
    });

    it("rejects public Horizon endpoint in testnet configuration", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_HORIZON_URL: CANONICAL_ENDPOINTS.PUBLIC.horizon,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("HORIZON_URL") && e.includes("PUBLIC"))).toBe(true);
    });

    it("rejects contradictory endpoints pointing to different networks", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_HORIZON_URL: CANONICAL_ENDPOINTS.PUBLIC.horizon,
        NEXT_PUBLIC_STELLAR_EXPLORER: CANONICAL_ENDPOINTS.TESTNET.explorer,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("contradictory") || e.includes("inconsistent"))).toBe(true);
    });

    it("rejects Circle's testnet USDC issuer on public network", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_USDC_ISSUER: CIRCLE_USDC.TESTNET,
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("USDC") && e.includes("testnet"))).toBe(true);
    });

    it("rejects Circle's public USDC issuer on testnet network", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_USDC_ISSUER: CIRCLE_USDC.PUBLIC,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("USDC") && e.includes("public"))).toBe(true);
    });
  });

  describe("4. Production Rejection of Placeholders and Testnet Artifacts", () => {
    it("rejects testnet demo contract ID in a production deployment", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_CONTRACT_ID: TESTNET_DEMO_CONTRACT,
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(TESTNET_DEMO_CONTRACT))).toBe(true);
    });

    it("rejects placeholder contract IDs (e.g. 'replace-me', 'TODO')", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_CONTRACT_ID: "replace-me-with-real-contract",
          NEXT_PUBLIC_SITE_URL: VALID_PUBLIC_URL,
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("placeholder"))).toBe(true);
    });

    it("rejects localhost site URL in production deployment", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("localhost"))).toBe(true);
    });

    it("rejects non-HTTPS site URL in production deployment", () => {
      const result = validateConfig(
        {
          NEXT_PUBLIC_STELLAR_NETWORK: "PUBLIC",
          NEXT_PUBLIC_CONTRACT_ID: VALID_MAINNET_CONTRACT,
          NEXT_PUBLIC_SITE_URL: "http://stellar-star.app",
        },
        { isProduction: true }
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("HTTPS"))).toBe(true);
    });
  });

  describe("5. Secrets Hygiene & Non-Sensitive Diagnostics", () => {
    it("rejects server secrets exposed as NEXT_PUBLIC_ variables", () => {
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_SUPABASE_JWT_SECRET: "my-jwt-secret-that-should-not-be-public",
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Security violation") && e.includes("NEXT_PUBLIC_SUPABASE_JWT_SECRET"))).toBe(true);
    });

    it("never leaks secret values in error messages", () => {
      const secretValue = "super-secret-token-value-xyz123";
      const result = validateConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "TESTNET",
        NEXT_PUBLIC_SETTLEMENT_ORACLE_SECRET: secretValue,
      });

      const joinedErrors = result.errors.join(" ");
      expect(joinedErrors).not.toContain(secretValue);
    });
  });

  describe("6. Startup Diagnostic & Invariant Consistency in constants.ts", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("constants.getNetworkConfigErrors surfaces actionable diagnostics without crashing", () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
      process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";

      const errors = constants.getNetworkConfigErrors();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("HORIZON_URL"))).toBe(true);
    });

    it("constants.assertValidNetworkConfig throws NetworkConfigError on unsafe config", () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
      process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";

      expect(() => constants.assertValidNetworkConfig()).toThrow(constants.NetworkConfigError);
    });
  });
});
