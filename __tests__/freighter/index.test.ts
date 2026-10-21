const isConnectedMock = jest.fn();
const openModalMock = jest.fn();
const setWalletMock = jest.fn();
const getAddressMock = jest.fn();
const signTransactionMock = jest.fn();
const getNetworkFromWalletMock = jest.fn();
const detectCapabilitiesMock = jest.fn();
const getSelectedWalletIdMock = jest.fn();

jest.mock("@stellar/freighter-api", () => ({
  isConnected: (...args: unknown[]) => isConnectedMock(...args),
}));

jest.mock("@/lib/stellar/walletsKit", () => ({
  getWalletsKit: () => ({
    openModal: (...args: unknown[]) => openModalMock(...args),
    setWallet: (...args: unknown[]) => setWalletMock(...args),
    getAddress: (...args: unknown[]) => getAddressMock(...args),
    signTransaction: (...args: unknown[]) => signTransactionMock(...args),
    getNetworkFromWallet: (...args: unknown[]) => getNetworkFromWalletMock(...args),
    detectCapabilities: (...args: unknown[]) => detectCapabilitiesMock(...args),
    getSelectedWalletId: (...args: unknown[]) => getSelectedWalletIdMock(...args),
  }),
}));

import {
  isFreighterInstalled,
  connectFreighter,
  signXDR,
  getFreighterNetwork,
} from "@/lib/freighter";

describe("freighter helpers", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    getSelectedWalletIdMock.mockReturnValue("freighter");
    getAddressMock.mockResolvedValue({ address: "GTESTADDRESS" });
    detectCapabilitiesMock.mockResolvedValue({ installed: true, canReadAddress: true, canSignTransactions: true });
    getNetworkFromWalletMock.mockResolvedValue("TESTNET");
  });

  it("returns false when window is undefined", async () => {
    const originalWindow = (global as any).window;
    delete (global as any).window;
    const res = await isFreighterInstalled();
    (global as any).window = originalWindow;
    expect(res).toBe(false);
  });

  it("returns true when freighter reports connected", async () => {
    (global as any).window = {};
    isConnectedMock.mockResolvedValue({ error: null, isConnected: true });

    await expect(isFreighterInstalled()).resolves.toBe(true);
  });

  it("connectFreighter resolves selected wallet address", async () => {
    getAddressMock.mockResolvedValue({ address: "GTESTADDRESS" });
    openModalMock.mockImplementation(async (opts: any) => {
      await opts.onWalletSelected({ id: "freighter" });
    });

    await expect(connectFreighter()).resolves.toBe("GTESTADDRESS");
    expect(setWalletMock).toHaveBeenCalledWith("freighter");
  });

  it("signXDR throws on empty signed payload", async () => {
    signTransactionMock.mockResolvedValue({ signedTxXdr: "" });

    await expect(signXDR("ABC", "Test SDF Network ; September 2015", "GTESTADDRESS")).rejects.toThrow(
      "The wallet returned an empty signed transaction.",
    );
  });

  it("rechecks the active address immediately before signing", async () => {
    getAddressMock.mockResolvedValue({ address: "GOTHER" });
    await expect(signXDR("ABC", "Test SDF Network ; September 2015", "GTESTADDRESS")).rejects.toThrow("active wallet address changed");
    expect(signTransactionMock).not.toHaveBeenCalled();
  });

  it("does not sign when the wallet cannot prove its selected network", async () => {
    getNetworkFromWalletMock.mockResolvedValue(null);
    await expect(signXDR("ABC", "Test SDF Network ; September 2015", "GTESTADDRESS")).rejects.toThrow("No compatible wallet");
    expect(signTransactionMock).not.toHaveBeenCalled();
  });

  it("getFreighterNetwork reports an unknown network instead of guessing TESTNET", async () => {
    getNetworkFromWalletMock.mockRejectedValue(new Error("boom"));

    await expect(getFreighterNetwork()).resolves.toBeNull();
  });
});
