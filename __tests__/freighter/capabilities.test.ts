const isConnectedMock = jest.fn();
const getNetworkMock = jest.fn();

jest.mock("@stellar/freighter-api", () => ({
  isConnected: (...args: unknown[]) => isConnectedMock(...args),
  isAllowed: jest.fn(),
  requestAccess: jest.fn(),
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  getNetwork: (...args: unknown[]) => getNetworkMock(...args),
}));

import { StellarWalletsKit, WalletNetwork, FREIGHTER_ID, XBULL_ID, LOBSTR_ID } from "@/lib/stellar/walletsKit";

describe("wallet capability detection matrix", () => {
  const kit = new StellarWalletsKit({ network: WalletNetwork.TESTNET });

  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = {};
    isConnectedMock.mockResolvedValue({ isConnected: true });
    getNetworkMock.mockResolvedValue({ network: "TESTNET" });
  });

  it.each([
    [FREIGHTER_ID, "freighterApi", { getPublicKey: jest.fn(), signXDR: jest.fn() }],
    [XBULL_ID, "xBulls", { getPublicKey: jest.fn(), signXDR: jest.fn(), getNetwork: async (): Promise<string> => "TESTNET" }],
    [LOBSTR_ID, "lobstr", { getPublicKey: jest.fn(), signTransaction: jest.fn(), getNetwork: async (): Promise<string> => "TESTNET" }],
  ] as const)("detects address, signing, network, and path-XDR support for %s", async (walletId, globalName, api) => {
    (window as unknown as Record<string, unknown>)[globalName] = api;
    const capabilities = await kit.detectCapabilities(walletId);
    expect(capabilities).toMatchObject({ installed: true, canReadAddress: true, canSignTransactions: true, canVerifyNetwork: true, supportsPathPaymentXdr: true, network: "TESTNET" });
  });

  it("reports no-wallet mode and keeps copy-XDR fallback available", async () => {
    isConnectedMock.mockResolvedValue({ isConnected: false });
    const capabilities = await kit.detectCapabilities(FREIGHTER_ID);
    expect(capabilities).toMatchObject({ installed: false, canReadAddress: false, canSignTransactions: false, qrOrDeepLinkFallback: true, copyXdrFallback: true });
  });

  it("does not claim network verification when an adapter omits network detection", async () => {
    (window as unknown as Record<string, unknown>).xBulls = { getPublicKey: jest.fn(), signXDR: jest.fn() };
    const capabilities = await kit.detectCapabilities(XBULL_ID);
    expect(capabilities.canVerifyNetwork).toBe(false);
    expect(capabilities.network).toBeNull();
  });
});
