/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { TripDetailHeader } from "@/components/trips/TripDetailHeader";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

import { LocaleProvider } from "@/context/LocaleContext";

describe("TripDetailHeader", () => {
  it("renders trip totals, member count, and share progress", () => {
    const { container } = render(
      <LocaleProvider>
        <TripDetailHeader trip={trip} expenses={expenses} />
      </LocaleProvider>
    );

    expect(screen.getByText("Goa Weekend")).toBeTruthy();
    expect(screen.getByText("2 members")).toBeTruthy();
    expect(screen.getByText("2 expenses")).toBeTruthy();
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("XLM 15.0000");
    expect(cleanText).toContain("total");
    expect(screen.getByText("1/2 shares paid")).toBeTruthy();
    expect(screen.getByText("Asha")).toBeTruthy();
    expect(screen.getByText("Ravi")).toBeTruthy();
  });
});

const trip: Trip = {
  id: "trip-1",
  name: "Goa Weekend",
  description: "Beach trip",
  members: [
    { id: "member-1", name: "Asha", walletAddress: "G".padEnd(56, "A") },
    { id: "member-2", name: "Ravi", walletAddress: "G".padEnd(56, "B") },
  ],
  expenseIds: ["expense-1", "expense-2"],
  createdAt: "2026-01-01T00:00:00.000Z",
  settled: false,
};

const expenses: Expense[] = [
  {
    id: "expense-1",
    title: "Taxi",
    totalAmount: "5",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-1",
    members: trip.members,
    shares: [{ memberId: "member-2", name: "Ravi", amount: "2.5000000", paid: true }],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  },
  {
    id: "expense-2",
    title: "Dinner",
    totalAmount: "10",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-2",
    members: trip.members,
    shares: [{ memberId: "member-1", name: "Asha", amount: "5.0000000", paid: false }],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  },
];
