/**
 * @jest-environment jsdom
 *
 * Unit tests for <ExpenseForm />.
 *
 * Strategy: ExpenseForm delegates all logic to useExpenseForm, which itself
 * calls useExpense (context) and useToast. We mock both so the component can
 * be rendered in isolation without a real Supabase or Freighter connection.
 *
 * Tests cover:
 *  - Rendering required fields
 *  - Title / amount validation errors on empty submit
 *  - Successful submit path (valid data → addExpense + onSuccess called)
 *  - Cancel button fires onCancel
 *  - Member-level validation (missing address, invalid address)
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";

// ─── Valid Stellar addresses ──────────────────────────────────────────────────
const VALID_ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const VALID_ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockAddExpense = jest.fn().mockResolvedValue(undefined);

jest.mock("@/hooks/useExpense", () => ({
  useExpense: () => ({
    addExpense: mockAddExpense,
    expenses: [],
    deleteExpense: jest.fn(),
    isLoading: false,
    isOffline: false,
  }),
}));

jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
  }),
}));

// framer-motion's AnimatePresence / motion.div don't work in jsdom; stub them.
jest.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, ...rest }: any) => <div {...rest}>{children}</div>,
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultMembers = [
  { id: "m1", name: "Alice", walletAddress: VALID_ADDR_A, weight: 1 },
  { id: "m2", name: "Bob",   walletAddress: VALID_ADDR_B, weight: 1 },
];

function renderForm(overrides: Partial<React.ComponentProps<typeof ExpenseForm>> = {}) {
  const onSuccess = jest.fn();
  const onCancel  = jest.fn();
  const result = render(
    <ExpenseForm
      onSuccess={onSuccess}
      onCancel={onCancel}
      currentUserPublicKey={VALID_ADDR_A}
      currentUserName="Alice"
      defaultMembers={defaultMembers}
      {...overrides}
    />
  );
  return { ...result, onSuccess, onCancel };
}

function fillTitle(title: string) {
  const input = screen.getByLabelText(/expense title/i);
  fireEvent.change(input, { target: { value: title } });
}

function fillAmount(amount: string) {
  const input = screen.getByLabelText(/total amount/i);
  fireEvent.change(input, { target: { value: amount } });
}

function clickSubmit(container: HTMLElement) {
  const form = container.querySelector<HTMLFormElement>("form")!;
  fireEvent.submit(form);
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe("ExpenseForm — rendering", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders the Expense title input", () => {
    renderForm();
    expect(screen.getByLabelText(/expense title/i)).toBeTruthy();
  });

  it("renders the Total amount input", () => {
    renderForm();
    expect(screen.getByLabelText(/total amount/i)).toBeTruthy();
  });

  it("renders a Cancel button", () => {
    renderForm();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  });

  it("renders a submit button", () => {
    const { container } = renderForm();
    expect(container.querySelector("button[type='submit']")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ExpenseForm — validation errors", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows a title-required error when submitting with an empty title", () => {
    const { container } = renderForm();
    fillAmount("10");
    clickSubmit(container);
    expect(screen.getByText(/title is required/i)).toBeTruthy();
  });

  it("shows an amount error when submitting with no amount", () => {
    const { container } = renderForm();
    fillTitle("Dinner");
    clickSubmit(container);
    expect(screen.getByText(/valid XLM amount/i)).toBeTruthy();
  });

  it("shows an amount error for a negative amount", () => {
    const { container } = renderForm();
    fillTitle("Dinner");
    fillAmount("-5");
    clickSubmit(container);
    expect(screen.getByText(/valid XLM amount/i)).toBeTruthy();
  });

  it("shows an amount error for zero", () => {
    const { container } = renderForm();
    fillTitle("Dinner");
    fillAmount("0");
    clickSubmit(container);
    expect(screen.getByText(/valid XLM amount/i)).toBeTruthy();
  });

  it("does NOT call onSuccess when validation fails", () => {
    const { container, onSuccess } = renderForm();
    clickSubmit(container); // blank title + blank amount
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does NOT call addExpense when validation fails", () => {
    const { container } = renderForm();
    clickSubmit(container);
    expect(mockAddExpense).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ExpenseForm — successful submit", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls addExpense with correct title and amount when all fields are valid", async () => {
    const { container } = renderForm();
    fillTitle("Team Lunch");
    fillAmount("50");
    clickSubmit(container);

    await waitFor(() => expect(mockAddExpense).toHaveBeenCalledTimes(1));

    const expense = mockAddExpense.mock.calls[0][0];
    expect(expense.title).toBe("Team Lunch");
    expect(parseFloat(expense.totalAmount)).toBeCloseTo(50, 4);
    expect(expense.currency).toBe("XLM");
  });

  it("calls onSuccess after a valid submission", async () => {
    const { container, onSuccess } = renderForm();
    fillTitle("Team Lunch");
    fillAmount("50");
    clickSubmit(container);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("passes the correct number of members to addExpense", async () => {
    const { container } = renderForm();
    fillTitle("Trip Costs");
    fillAmount("100");
    clickSubmit(container);

    await waitFor(() => expect(mockAddExpense).toHaveBeenCalledTimes(1));
    const expense = mockAddExpense.mock.calls[0][0];
    expect(expense.members.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ExpenseForm — cancel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fires onCancel when the Cancel button is clicked", () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call addExpense when the user cancels", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockAddExpense).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ExpenseForm — member-level validation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows an error when a member has an invalid Stellar address", () => {
    const badMembers = [
      { id: "m1", name: "Alice", walletAddress: "INVALID_NOT_56_CHARS", weight: 1 },
      { id: "m2", name: "Bob",   walletAddress: VALID_ADDR_B, weight: 1 },
    ];
    const { container } = renderForm({ defaultMembers: badMembers });
    fillTitle("Trip");
    fillAmount("20");
    clickSubmit(container);
    expect(screen.getByText(/invalid stellar address/i)).toBeTruthy();
  });

  it("allows a named member without a wallet address (placeholder member)", async () => {
    const noAddrMembers = [
      { id: "m1", name: "Alice", walletAddress: "", weight: 1 },
      { id: "m2", name: "Bob",   walletAddress: VALID_ADDR_B, weight: 1 },
    ];
    const { container, onSuccess } = renderForm({ defaultMembers: noAddrMembers });
    fillTitle("Trip");
    fillAmount("20");
    clickSubmit(container);
    await waitFor(() => expect(mockAddExpense).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("shows a members error when fewer than 2 named members exist", () => {
    const oneNamedMember = [
      { id: "m1", name: "Alice", walletAddress: VALID_ADDR_A, weight: 1 },
      { id: "m2", name: "",      walletAddress: "",           weight: 1 },
    ];
    const { container } = renderForm({ defaultMembers: oneNamedMember });
    fillTitle("Solo Trip");
    fillAmount("20");
    clickSubmit(container);
    expect(screen.getByText(/at least 2 members/i)).toBeTruthy();
  });
});
