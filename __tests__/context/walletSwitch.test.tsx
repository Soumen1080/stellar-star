/** @jest-environment jsdom */

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { TripProvider, useTripContext } from "@/context/TripContext";
import { ExpenseProvider, useExpenseContext } from "@/context/ExpenseContext";
import { useWalletContext } from "@/context/WalletContext";
import { setSession, clearSession, __resetSessionForTests } from "@/lib/supabase/session";

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: jest.fn(),
}));

// The database is unreachable in this test, so both providers fall back to
// their per-wallet localStorage cache — which is what the isolation assertions
// below are about.
jest.mock("@/lib/supabase/queries", () => {
  const actual = jest.requireActual("@/lib/supabase/queries");
  return {
    ...actual,
    fetchTrips: jest.fn().mockRejectedValue(new Error("Network offline")),
    fetchExpenses: jest.fn().mockRejectedValue(new Error("Network offline")),
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

const walletA = "G_WALLET_A_1234567890";
const walletB = "G_WALLET_B_0987654321";

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
  const tripCtx = useTripContext();
  const expenseCtx = useExpenseContext();
  onContext({ trips: tripCtx.trips, expenses: expenseCtx.expenses });
  return null;
}

function Providers({ onContext }: { onContext: (ctx: any) => void }) {
  return (
    <TripProvider>
      <ExpenseProvider>
        <TestConsumer onContext={onContext} />
      </ExpenseProvider>
    </TripProvider>
  );
}

describe("Wallet Cache Isolation (Issue #17)", () => {
  const tripsA = [
    { id: "trip-a", name: "Trip A", members: [], expenseIds: [], createdAt: "", settled: false },
  ];
  const tripsB = [
    { id: "trip-b", name: "Trip B", members: [], expenseIds: [], createdAt: "", settled: false },
  ];
  const expensesA = [
    {
      id: "expense-a",
      title: "Expense A",
      totalAmount: "10",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m1",
      members: [],
      shares: [],
      createdAt: "",
      settled: false,
    },
  ];
  const expensesB = [
    {
      id: "expense-b",
      title: "Expense B",
      totalAmount: "20",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m2",
      members: [],
      shares: [],
      createdAt: "",
      settled: false,
    },
  ];

  beforeEach(() => {
    localStorage.clear();
    __resetSessionForTests();
    jest.clearAllMocks();

    localStorage.setItem(`StellarStar:trips:${walletA}`, JSON.stringify(tripsA));
    localStorage.setItem(`StellarStar:trips:${walletB}`, JSON.stringify(tripsB));
    localStorage.setItem(`StellarStar:expenses:${walletA}`, JSON.stringify(expensesA));
    localStorage.setItem(`StellarStar:expenses:${walletB}`, JSON.stringify(expensesB));
  });

  it("isolates cached trips and expenses per connected wallet", async () => {
    // 1. Wallet A, signed in.
    mockUseWalletContext.mockReturnValue({ publicKey: walletA });
    setSession(mintToken(walletA));

    let captured: any = { trips: [], expenses: [] };
    const { rerender } = render(<Providers onContext={(ctx) => { captured = ctx; }} />);

    await waitFor(() => {
      expect(captured.trips).toEqual(tripsA);
      expect(captured.expenses).toEqual(expensesA);
    });

    // 2. Switch to wallet B, with its own session.
    mockUseWalletContext.mockReturnValue({ publicKey: walletB });
    act(() => { setSession(mintToken(walletB)); });
    rerender(<Providers onContext={(ctx) => { captured = ctx; }} />);

    await waitFor(() => {
      expect(captured.trips).toEqual(tripsB);
      expect(captured.expenses).toEqual(expensesB);
    });

    // 3. Disconnect -> empty state, not the last wallet's cache.
    mockUseWalletContext.mockReturnValue({ publicKey: null });
    act(() => { clearSession(); });
    rerender(<Providers onContext={(ctx) => { captured = ctx; }} />);

    await waitFor(() => {
      expect(captured.trips).toEqual([]);
      expect(captured.expenses).toEqual([]);
    });
  });

  it("shows nothing when the wallet is connected but not signed in", async () => {
    // No session: RLS would return no rows anyway, and serving the cache here
    // would show data the current session cannot prove it may read.
    mockUseWalletContext.mockReturnValue({ publicKey: walletA });

    let captured: any = { trips: [], expenses: [] };
    render(<Providers onContext={(ctx) => { captured = ctx; }} />);

    await waitFor(() => {
      expect(captured.trips).toEqual([]);
      expect(captured.expenses).toEqual([]);
    });
  });

  it("does not serve wallet A's data to wallet B on a stale session", async () => {
    // Wallet B is connected but the session still belongs to wallet A.
    mockUseWalletContext.mockReturnValue({ publicKey: walletB });
    setSession(mintToken(walletA));

    let captured: any = { trips: [], expenses: [] };
    render(<Providers onContext={(ctx) => { captured = ctx; }} />);

    await waitFor(() => {
      expect(captured.trips).toEqual([]);
      expect(captured.expenses).toEqual([]);
    });
  });
});
