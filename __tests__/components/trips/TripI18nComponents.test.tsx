/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { LocaleProvider, useLocale } from "@/context/LocaleContext";
import { TripTabs } from "@/components/trips/TripTabs";
import { ExpenseList } from "@/components/trips/ExpenseList";
import { ExpenseCard } from "@/components/expenses/ExpenseCard";
import type { Expense } from "@/types/expense";

jest.mock("@/hooks/usePayment", () => ({
  usePayment: () => ({
    payShare: jest.fn(),
    paymentState: { status: "idle" },
    reset: jest.fn(),
    retryOnChainRecord: jest.fn(),
    poolBalance: null,
    depositLoading: false,
    depositPool: jest.fn(),
  }),
}));

// Helper component to switch locale inside tests
function LocaleSwitcher({ locale }: { locale: any }) {
  const { setLocale } = useLocale();
  React.useEffect(() => {
    setLocale(locale);
  }, [locale, setLocale]);
  return null;
}

const mockExpense: Expense = {
  id: "exp-1",
  title: "Dinner in Ginza",
  totalAmount: "120.0000000",
  currency: "JPY",
  enteredAmount: "12000",
  splitMode: "equal",
  paidByMemberId: "mem-1",
  members: [
    { id: "mem-1", name: "Alice", walletAddress: "GALICE111" },
    { id: "mem-2", name: "Bob", walletAddress: "GBOB222" },
  ],
  shares: [
    { memberId: "mem-1", name: "Alice", amount: "60.0000000", paid: true },
    { memberId: "mem-2", name: "Bob", amount: "60.0000000", paid: false },
  ],
  createdAt: "2026-10-20T12:00:00Z",
  settled: false,
};

describe("Localized Trip Components", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("TripTabs Localization", () => {
    it("renders tab labels in English by default", () => {
      render(
        <LocaleProvider>
          <TripTabs activeTab="expenses" onChange={() => {}} />
        </LocaleProvider>
      );

      expect(screen.getByText("Expenses")).toBeTruthy();
      expect(screen.getByText("Workspace")).toBeTruthy();
      expect(screen.getByText("Recurring")).toBeTruthy();
      expect(screen.getByText("Settle Up")).toBeTruthy();
    });

    it("renders tab labels in German when locale is de-DE", async () => {
      render(
        <LocaleProvider>
          <LocaleSwitcher locale="de-DE" />
          <TripTabs activeTab="expenses" onChange={() => {}} />
        </LocaleProvider>
      );

      expect(screen.getByText("Ausgaben")).toBeTruthy();
      expect(screen.getByText("Reisebereich")).toBeTruthy();
      expect(screen.getByText("Wiederkehrend")).toBeTruthy();
      expect(screen.getByText("Abrechnen")).toBeTruthy();
    });

    it("renders tab labels in Arabic when locale is ar-SA", async () => {
      render(
        <LocaleProvider>
          <LocaleSwitcher locale="ar-SA" />
          <TripTabs activeTab="expenses" onChange={() => {}} />
        </LocaleProvider>
      );

      expect(screen.getByText("المصاريف")).toBeTruthy();
      expect(screen.getByText("مساحة العمل")).toBeTruthy();
      expect(screen.getByText("متكرر")).toBeTruthy();
      expect(screen.getByText("تسوية الحساب")).toBeTruthy();
    });
  });

  describe("ExpenseList Localization", () => {
    it("renders localized empty state message in German", () => {
      render(
        <LocaleProvider>
          <LocaleSwitcher locale="de-DE" />
          <ExpenseList expenses={[]} />
        </LocaleProvider>
      );

      expect(
        screen.getByText("Noch keine Ausgaben in dieser Reise.")
      ).toBeTruthy();
    });

    it("renders localized paid ratio for expenses", () => {
      render(
        <LocaleProvider>
          <LocaleSwitcher locale="de-DE" />
          <ExpenseList expenses={[mockExpense]} />
        </LocaleProvider>
      );

      expect(screen.getByText("1/2 bezahlt")).toBeTruthy();
    });
  });

  describe("ExpenseCard Localization", () => {
    it("renders localized members count and agreed-as text in German", () => {
      render(
        <LocaleProvider>
          <LocaleSwitcher locale="de-DE" />
          <ExpenseCard expense={mockExpense} />
        </LocaleProvider>
      );

      expect(screen.getByText(/\(vereinbart als/i)).toBeTruthy();
      expect(screen.getByText(/2 Mitglieder/i)).toBeTruthy();
      expect(screen.getByText("1/2 bezahlt")).toBeTruthy();
    });
  });
});
