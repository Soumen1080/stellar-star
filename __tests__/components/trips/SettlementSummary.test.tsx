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

const mockUseWallet = useWallet as jest.MockedFunction<typeof useWallet>;
const mockUseExpense = useExpense as jest.MockedFunction<typeof useExpense>;

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

describe("SettlementSummary", () => {
  beforeEach(() => {
    mockUseWallet.mockReturnValue({ publicKey: "G".padEnd(56, "B") });
    mockUseExpense.mockReturnValue({ markSharePaid: jest.fn() });
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

    render(<SettlementSummary trip={trip} expenses={expenses} onChainEvents={onChainEvents} />);

    expect(screen.getByText("On-chain")).toBeTruthy();
    expect(screen.getByText("Pay 3.5000 XLM")).toBeTruthy();
    expect(screen.queryByText("Confirmed on Stellar — ledger proof recorded")).toBeTruthy();

    // The second payment row should still show a pay button because it has no exact matching event.
    expect(screen.getByText("Pay 3.5000 XLM")).toBeTruthy();
    expect(screen.queryByText(/Pay 2.5000 XLM/i)).toBeNull();
  });
});
