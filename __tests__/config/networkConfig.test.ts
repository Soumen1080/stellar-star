/**
 * Configuration derivation + startup validation (invariant 1).
 *
 * `constants.ts` reads `process.env` at import time, so each case re-requires
 * the module after mutating the environment.
 */

const BASE_ENV = { ...process.env };

describe("network configuration", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...BASE_ENV };
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    delete process.env.NEXT_PUBLIC_HORIZON_URL;
    delete process.env.NEXT_PUBLIC_SOROBAN_RPC_URL;
    delete process.env.NEXT_PUBLIC_STELLAR_EXPLORER;
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
  });

  it("derives consistent testnet endpoints by default", () => {
    const c = require("@/lib/utils/constants");
    expect(c.STELLAR_NETWORK).toBe("TESTNET");
    expect(c.HORIZON_URL).toContain("horizon-testnet.stellar.org");
    expect(c.SOROBAN_RPC_URL).toContain("soroban-testnet.stellar.org");
    expect(c.STELLAR_EXPLORER).toContain("/explorer/testnet");
    expect(c.getNetworkConfigErrors()).toEqual([]);
  });

  it("derives consistent public endpoints when STELLAR_NETWORK=PUBLIC", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
    const c = require("@/lib/utils/constants");
    expect(c.HORIZON_URL).toContain("horizon.stellar.org");
    expect(c.SOROBAN_RPC_URL).toContain("rpc.stellar.org");
    expect(c.STELLAR_EXPLORER).toContain("/explorer/public");
    expect(c.getNetworkConfigErrors()).toEqual([]);
  });

  it("flags PUBLIC with an explicit testnet HORIZON_URL", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";
    const c = require("@/lib/utils/constants");
    const errs = c.getNetworkConfigErrors();
    expect(errs.some((e: string) => e.includes("HORIZON_URL"))).toBe(true);
    expect(() => c.assertValidNetworkConfig()).toThrow();
  });

  it("flags PUBLIC with an explicit testnet SOROBAN_RPC_URL", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    const c = require("@/lib/utils/constants");
    const errs = c.getNetworkConfigErrors();
    expect(errs.some((e: string) => e.includes("SOROBAN_RPC_URL"))).toBe(true);
  });

  it("flags PUBLIC with an explicit testnet STELLAR_EXPLORER", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
    process.env.NEXT_PUBLIC_STELLAR_EXPLORER = "https://stellar.expert/explorer/testnet";
    const c = require("@/lib/utils/constants");
    const errs = c.getNetworkConfigErrors();
    expect(errs.some((e: string) => e.includes("STELLAR_EXPLORER"))).toBe(true);
  });

  it("flags cross-network endpoints even when STELLAR_NETWORK matches one", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "TESTNET";
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon.stellar.org";
    process.env.NEXT_PUBLIC_STELLAR_EXPLORER = "https://stellar.expert/explorer/testnet";
    const c = require("@/lib/utils/constants");
    const errs = c.getNetworkConfigErrors();
    expect(errs.some((e: string) => e.toLowerCase().includes("inconsistent"))).toBe(true);
  });

  it("accepts unrecognised (custom) endpoints without false positives", () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "PUBLIC";
    process.env.NEXT_PUBLIC_HORIZON_URL = "https://my-private-horizon.example.com";
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://my-private-soroban.example.com";
    process.env.NEXT_PUBLIC_STELLAR_EXPLORER = "https://my-explorer.example.com/public";
    const c = require("@/lib/utils/constants");
    expect(c.getNetworkConfigErrors()).toEqual([]);
  });

  it("exposes network labels without hardcoding them elsewhere", () => {
    const c = require("@/lib/utils/constants");
    expect(c.NETWORK_LABEL).toBe("Testnet");
    expect(c.NETWORK_DISPLAY_NAME).toBe("Stellar Testnet");
    expect(c.networkLabel("PUBLIC")).toBe("Mainnet");
    expect(c.networkLabel("TESTNET")).toBe("Testnet");
    expect(c.networkLabel(null)).toBe("an unknown network");
  });
});
