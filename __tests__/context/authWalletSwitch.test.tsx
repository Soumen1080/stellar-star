/** @jest-environment jsdom */

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { useWalletContext } from "@/context/WalletContext";
import { fetchUserByWallet } from "@/lib/supabase/queries";
import { setSession, clearSession, __resetSessionForTests } from "@/lib/supabase/session";
import { LS_PUBLIC_KEY, LS_USER } from "@/lib/utils/constants";

// Drive `publicKey` directly, per test step.
jest.mock("@/context/WalletContext", () => ({
  useWalletContext: jest.fn(),
}));

// The backend is unreachable, so AuthContext must fall back to whatever is
// cached for the *active* wallet — never another wallet's cached profile.
jest.mock("@/lib/supabase/queries", () => {
  const actual = jest.requireActual("@/lib/supabase/queries");
  return {
    ...actual,
    fetchUserByWallet: jest.fn().mockRejectedValue(new Error("Network offline")),
    updateUserDisplayName: jest.fn(),
  };
});

jest.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: jest.fn(() => true),
  getSupabaseClient: jest.fn(() => null),
  requireSupabaseClient: jest.fn(),
  requireAuthenticatedClient: jest.fn(),
  resetSupabaseClient: jest.fn(),
}));

const mockUseWalletContext = useWalletContext as jest.Mock;
const mockFetchUserByWallet = fetchUserByWallet as jest.Mock;

const walletA = "GAAAA_WALLET_A_1111111111111111111111111111111111111111";
const walletB = "GBBBB_WALLET_B_2222222222222222222222222222222222222222";

const userA = {
  id: "user-a",
  walletAddress: walletA,
  displayName: "Alice",
  createdAt: "",
  updatedAt: "",
  lastLoginAt: "",
};

const userB = {
  id: "user-b",
  walletAddress: walletB,
  displayName: "Bob",
  createdAt: "",
  updatedAt: "",
  lastLoginAt: "",
};

/** A JWT shaped like the one /api/auth/verify mints for `wallet`. */
function mintToken(wallet: string): string {
  const b64 = (value: string) =>
    Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      role: "authenticated",
      sub: wallet,
      wallet_address: wallet,
      iat: now,
      exp: now + 3600,
    })
  );
  return `${header}.${payload}.signature`;
}

function TestConsumer({ onContext }: { onContext: (ctx: any) => void }) {
  const ctx = useAuth();
  onContext({ user: ctx.user, isLoading: ctx.isLoading });
  return null;
}

describe("Auth user cache isolation by wallet (Issue #68)", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetSessionForTests();
    jest.clearAllMocks();
    mockFetchUserByWallet.mockRejectedValue(new Error("Network offline"));
  });

  it("loads the cached profile for the active wallet and never leaks it to a different wallet after switching", async () => {
    // Cached profiles for two wallets, plus an active session for wallet A.
    localStorage.setItem(LS_PUBLIC_KEY, walletA);
    localStorage.setItem(`${LS_USER}:${walletA}`, JSON.stringify(userA));
    localStorage.setItem(`${LS_USER}:${walletB}`, JSON.stringify(userB));
    setSession(mintToken(walletA));

    mockUseWalletContext.mockReturnValue({
      publicKey: walletA,
      isConnected: true,
      isHydrated: true,
    });

    let captured: any = { user: undefined, isLoading: true };
    const { rerender } = render(
      <AuthProvider>
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(captured.isLoading).toBe(false);
    });
    expect(captured.user?.walletAddress).toBe(walletA);
    expect(captured.user?.displayName).toBe("Alice");

    // Disconnect: publicKey goes null, mirroring WalletContext.disconnect().
    localStorage.removeItem(LS_PUBLIC_KEY);
    act(() => { clearSession(); });
    mockUseWalletContext.mockReturnValue({
      publicKey: null,
      isConnected: false,
      isHydrated: true,
    });
    rerender(
      <AuthProvider>
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(captured.user).toBeNull();
    });

    // Connect wallet B with no session yet: wallet A's profile must not reappear.
    mockUseWalletContext.mockReturnValue({
      publicKey: walletB,
      isConnected: true,
      isHydrated: true,
    });
    rerender(
      <AuthProvider>
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(captured.isLoading).toBe(false);
    });
    expect(captured.user).toBeNull();
    expect(captured.user?.displayName).not.toBe("Alice");
  });

  it("drops a session belonging to a wallet other than the connected one", async () => {
    // Wallet B connected, but the stored session is still wallet A's.
    localStorage.setItem(LS_PUBLIC_KEY, walletB);
    localStorage.setItem(`${LS_USER}:${walletA}`, JSON.stringify(userA));
    setSession(mintToken(walletA));

    mockUseWalletContext.mockReturnValue({
      publicKey: walletB,
      isConnected: true,
      isHydrated: true,
    });

    let captured: any = { user: undefined, isLoading: true };
    render(
      <AuthProvider>
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(captured.isLoading).toBe(false);
    });
    expect(captured.user).toBeNull();
    // The mismatched session is discarded rather than used against wallet B.
    expect(mockFetchUserByWallet).not.toHaveBeenCalled();
  });

  it("loads the profile as soon as a session appears, without a remount", async () => {
    // This is the sign-up path: the token is minted while the tree is mounted,
    // and the profile must load off the back of it.
    localStorage.setItem(LS_PUBLIC_KEY, walletA);
    mockFetchUserByWallet.mockResolvedValue(userA);

    mockUseWalletContext.mockReturnValue({
      publicKey: walletA,
      isConnected: true,
      isHydrated: true,
    });

    let captured: any = { user: undefined, isLoading: true };
    render(
      <AuthProvider>
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(captured.isLoading).toBe(false);
    });
    expect(captured.user).toBeNull();

    act(() => { setSession(mintToken(walletA)); });

    await waitFor(() => {
      expect(captured.user?.displayName).toBe("Alice");
    });
    expect(mockFetchUserByWallet).toHaveBeenCalledWith(walletA);
  });
});
