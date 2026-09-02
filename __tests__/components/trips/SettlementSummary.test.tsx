/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

jest.mock("@/hooks/useWallet", () => ({
  useWallet: jest.fn(),
}));

jest.mock("@/hooks/useExpense", () => ({
  useExpense: jest.fn(),
}));

jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  }),
}));

// `as jest.Mock`, matching the other component tests: these stubs deliberately
// supply only the context fields SettlementSummary reads, which a fully typed
// MockedFunction would reject.
const mockUseWallet = useWallet as jest.Mock;
const mockUseExpense = useExpense as jest.Mock;

const trip: Trip = {
  id: "trip-1",
  name: "Goa Weekend",
  description: "Beach trip",
  members: [
    { id: "member-1", name: "Asha", walletAddress: "G".padEnd(56, "A") },
    { id: "member-2", name: "Ravi", walletAddress: "G".padEnd(56, "B") },
    { id: "member-3", name: "Mira", walletAddress: "G".padEnd(56, "C") },
  ],
  expenseIds: ["expense-1", "expense-2"],
  createdAt: "2026-01-01T00:00:00.000Z",
  settled: false,
};

const expenses: Expense[] = [
  {
    id: "expense-1",
    title: "Lunch",
    totalAmount: "5",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-1",
    members: trip.members,
    shares: [
      {
        memberId: "member-2",
        name: "Ravi",
        walletAddress: "G".padEnd(56, "B"),
        amount: "2.5000000",
        paid: false,
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  },
  {
    id: "expense-2",
    title: "Dinner",
    totalAmount: "8",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-3",
    members: trip.members,
    shares: [
      {
        memberId: "member-2",
        name: "Ravi",
        walletAddress: "G".padEnd(56, "B"),
        amount: "3.5000000",
        paid: false,
      },
    ],
    createdAt: "2026-01-02T00:00:00.000Z",
    settled: false,
  },
];

import { LocaleProvider } from "@/context/LocaleContext";

describe("SettlementSummary", () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({
      publicKey: "G".padEnd(56, "B"), // Ravi is logged in
      isConnected: true,
      refreshBalance: jest.fn(),
      network: "testnet",
    });
    mockUseExpense.mockReturnValue({
      expenses: [],
      isLoading: false,
      isOffline: false,
      addExpense: jest.fn(),
      deleteExpense: jest.fn(),
      markSharePaid: jest.fn(),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Verification that only the exact matching payment row is flagged as on-chain when the same member is associated with multiple events.
  it("marks only the exact matching payment row as on-chain when the same member has multiple events", () => {
    const onChainEvents = [
      {
        ledger: 100,
        ledgerClosedAt: "2026-01-01T12:00:00Z",
        tripId: "trip-1",
        expenseId: "expense-1",
        member: "G".padEnd(56, "B"),
        amountStroops: "25000000",
        txHash: "txhash1",
      },
    ];

    const { container } = render(
      <LocaleProvider>
        <SettlementSummary trip={trip} expenses={expenses} onChainEvents={onChainEvents} />
      </LocaleProvider>
    );

    expect(screen.getAllByText("On-chain")).toHaveLength(1);
    expect(screen.getByText("Confirmed on Stellar - ledger proof recorded")).toBeTruthy();

    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    // The unrelated payment row should still be payable because only the matching expense/amount row is on-chain.
    expect(cleanText).toContain("Pay XLM 3.5000");
    expect(cleanText).not.toContain("Pay XLM 2.5000");
  });
});
