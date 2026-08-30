/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { RecentExpenseRow } from "@/components/dashboard/RecentExpenseRow";
import type { Expense } from "@/types/expense";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { LocaleProvider } from "@/context/LocaleContext";

describe("RecentExpenseRow", () => {
  it("renders expense summary and payment progress", () => {
    const { container } = render(
      <LocaleProvider>
        <RecentExpenseRow expense={makeExpense()} />
      </LocaleProvider>
    );

    expect(screen.getByText("Dinner")).toBeTruthy();
    const cleanText = container.textContent?.replace(/\u00a0/g, " ");
    expect(cleanText).toContain("XLM 12.5000");
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/expenses");
  });
});

function makeExpense(): Expense {
  return {
    id: "expense-1",
    title: "Dinner",
    totalAmount: "12.5",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-1",
    members: [
      { id: "member-1", name: "Asha", walletAddress: "G".padEnd(56, "A") },
      { id: "member-2", name: "Ravi", walletAddress: "G".padEnd(56, "B") },
    ],
    shares: [
      { memberId: "member-1", name: "Asha", amount: "6.2500000", paid: true },
      { memberId: "member-2", name: "Ravi", amount: "6.2500000", paid: false },
    ],
    createdAt: "2026-01-02T00:00:00.000Z",
    settled: false,
  };
}
