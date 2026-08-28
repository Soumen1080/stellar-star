import {
  networkMismatchMessage,
  isWalletNetworkMismatched,
} from "@/lib/stellar/networkMismatch";

// STELLAR_NETWORK defaults to TESTNET in the test environment.
describe("networkMismatch", () => {
  it("returns null when the wallet is on the app's network", () => {
    expect(networkMismatchMessage("TESTNET")).toBeNull();
    expect(isWalletNetworkMismatched("TESTNET")).toBe(false);
  });

  it("returns null when the wallet network is unknown", () => {
    expect(networkMismatchMessage(null)).toBeNull();
    expect(networkMismatchMessage(undefined)).toBeNull();
    expect(isWalletNetworkMismatched(null)).toBe(false);
  });

  it("returns an actionable message when the wallet is on the wrong network", () => {
    const msg = networkMismatchMessage("PUBLIC");
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/configured for/);
    expect(isWalletNetworkMismatched("PUBLIC")).toBe(true);
  });
});
