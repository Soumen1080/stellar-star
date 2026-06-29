/** @jest-environment jsdom */

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { TripProvider, useTripContext } from "@/context/TripContext";
import { ExpenseProvider, useExpenseContext } from "@/context/ExpenseContext";
import { useWalletContext } from "@/context/WalletContext";

// Mock WalletContext
jest.mock("@/context/WalletContext", () => ({
  useWalletContext: jest.fn(),
}));

// Mock Supabase Config
jest.mock("@/lib/supabase/client", () => {
  const mockChannel = {
    on: jest.fn().mockReturnThis(),
    subscribe: jest.fn().mockReturnThis(),
    unsubscribe: jest.fn().mockReturnThis(),
  };
  return {
    isSupabaseConfigured: jest.fn(() => true),
    supabase: {
      channel: jest.fn(() => mockChannel),
    },
    createAuthenticatedClient: jest.fn(),
    clearAuthenticatedClientCache: jest.fn(),
  };
});

const mockUseWalletContext = useWalletContext as jest.Mock;

// Helper to consume context in tests
function TestConsumer({ onContext }: { onContext: (ctx: any) => void }) {
  const tripCtx = useTripContext();
  const expenseCtx = useExpenseContext();
  onContext({ trips: tripCtx.trips, expenses: expenseCtx.expenses });
  return null;
}

describe("Wallet Cache Isolation (Issue #17)", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  it("isolates cached trips and expenses per connected wallet", async () => {
    const mockClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockImplementation(() => {
        // Return database error to force loading from cache
        return Promise.resolve({ data: null, error: { message: "Network offline" } });
      }),
    };

    const verifyClientModule = jest.requireMock("@/lib/supabase/client") as { createAuthenticatedClient: jest.Mock };
    verifyClientModule.createAuthenticatedClient.mockReturnValue(mockClient);

    // Seed mock data for wallet A and wallet B in localStorage
    const walletA = "G_WALLET_A_1234567890";
    const walletB = "G_WALLET_B_0987654321";

    const tripsA = [{ id: "trip-a", name: "Trip A", members: [], expenseIds: [], createdAt: "", settled: false }];
    const tripsB = [{ id: "trip-b", name: "Trip B", members: [], expenseIds: [], createdAt: "", settled: false }];

    const expensesA = [{ id: "expense-a", title: "Expense A", totalAmount: "10", currency: "XLM", splitMode: "equal", paidByMemberId: "m1", members: [], shares: [], createdAt: "", settled: false, createdByWallet: walletA, memberWallets: [] }];
    const expensesB = [{ id: "expense-b", title: "Expense B", totalAmount: "20", currency: "XLM", splitMode: "equal", paidByMemberId: "m2", members: [], shares: [], createdAt: "", settled: false, createdByWallet: walletB, memberWallets: [] }];

    localStorage.setItem(`StellarStar:trips:${walletA}`, JSON.stringify(tripsA));
    localStorage.setItem(`StellarStar:trips:${walletB}`, JSON.stringify(tripsB));
    localStorage.setItem(`StellarStar:expenses:${walletA}`, JSON.stringify(expensesA));
    localStorage.setItem(`StellarStar:expenses:${walletB}`, JSON.stringify(expensesB));

    // 1. Render with Wallet A
    mockUseWalletContext.mockReturnValue({ publicKey: walletA });
    let captured: any = { trips: [], expenses: [] };

    const { rerender } = render(
      <TripProvider>
        <ExpenseProvider>
          <TestConsumer onContext={(ctx) => { captured = ctx; }} />
        </ExpenseProvider>
      </TripProvider>
    );

    // Wait for providers to finish loading fallback from localStorage
    await waitFor(() => {
      expect(captured.trips).toEqual(tripsA);
      expect(captured.expenses).toEqual(expensesA);
    });

    // 2. Rerender / switch to Wallet B
    mockUseWalletContext.mockReturnValue({ publicKey: walletB });
    rerender(
      <TripProvider>
        <ExpenseProvider>
          <TestConsumer onContext={(ctx) => { captured = ctx; }} />
        </ExpenseProvider>
      </TripProvider>
    );

    await waitFor(() => {
      expect(captured.trips).toEqual(tripsB);
      expect(captured.expenses).toEqual(expensesB);
    });

    // 3. Rerender / disconnect wallet (null publicKey) -> safe empty state
    mockUseWalletContext.mockReturnValue({ publicKey: null });
    rerender(
      <TripProvider>
        <ExpenseProvider>
          <TestConsumer onContext={(ctx) => { captured = ctx; }} />
        </ExpenseProvider>
      </TripProvider>
    );

    await waitFor(() => {
      expect(captured.trips).toEqual([]);
      expect(captured.expenses).toEqual([]);
    });
  });
});
