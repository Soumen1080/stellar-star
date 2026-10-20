/**
 * @jest-environment jsdom
 *
 * #321 — the fields a copied trip starts with (dates, recurring rules,
 * permissions) are editable in TripForm before creation, and the preview
 * states what is and is not copied.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TripForm } from "@/components/trips/TripForm";
import { TripCopyPreview } from "@/components/trips/TripCopyPreview";
import type { TripFormData } from "@/types/trip";

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

const draft: TripFormData = {
  name: "Flat 4B (copy)",
  description: "Monthly bills",
  members: [
    { id: "a", name: "Alice", walletAddress: ADDR_A },
    { id: "b", name: "Bob" },
  ],
  startsOn: "2026-03-01",
  endsOn: "2026-03-30",
  recurringRules: [
    { id: "r1", title: "Rent", amount: "1200.0000000", splitMode: "equal", cadence: "monthly", paidByMemberId: "a" },
  ],
  permissions: { membersCanAddExpenses: true, membersCanInvite: false },
};

function renderDraft() {
  const onSubmit = jest.fn();
  const utils = render(
    <TripForm initialData={draft} onSubmit={onSubmit} onCancel={jest.fn()} submitLabel="Create trip" />
  );
  return { ...utils, onSubmit };
}

describe("TripForm — copied structure is editable before creation", () => {
  it("pre-fills dates, rules and permissions from the draft", () => {
    const { container } = renderDraft();

    expect(container.querySelector<HTMLInputElement>("input#starts-on")!.value).toBe("2026-03-01");
    expect(container.querySelector<HTMLInputElement>("input#ends-on")!.value).toBe("2026-03-30");
    expect(screen.getByDisplayValue("Rent")).toBeTruthy();
    expect(
      (screen.getByLabelText(/Members can invite people/) as HTMLInputElement).checked
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Create trip" })).toBeTruthy();
  });

  it("submits the edited structure", () => {
    const { container, onSubmit } = renderDraft();

    fireEvent.change(screen.getByDisplayValue("Rent"), { target: { value: "Rent + bills" } });
    fireEvent.click(screen.getByLabelText(/Members can invite people/));
    fireEvent.change(container.querySelector("input#ends-on")!, { target: { value: "2026-04-15" } });
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const data: TripFormData = onSubmit.mock.calls[0][0];
    expect(data.recurringRules?.[0].title).toBe("Rent + bills");
    expect(data.recurringRules?.[0].amount).toBe("1200.0000000");
    expect(data.permissions).toEqual({ membersCanAddExpenses: true, membersCanInvite: true });
    expect(data.endsOn).toBe("2026-04-15");
    expect("expenseIds" in data).toBe(false);
  });

  it("blocks an end date earlier than the start date", () => {
    const { container, onSubmit } = renderDraft();

    fireEvent.change(container.querySelector("input#ends-on")!, { target: { value: "2026-02-01" } });
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/on or after the start date/i)).toBeTruthy();
  });

  it("blocks a recurring rule with an inexact amount", () => {
    const { container, onSubmit } = renderDraft();

    fireEvent.change(screen.getByDisplayValue("1200.0000000"), { target: { value: "1.123456789" } });
    fireEvent.submit(container.querySelector("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/positive amount/i)).toBeTruthy();
  });
});

describe("TripCopyPreview", () => {
  it("lists copied and never-copied items", () => {
    render(
      <TripCopyPreview
        preview={{
          copied: ["2 members (1 with a wallet address)"],
          excluded: ["Balances and who-owes-whom"],
        }}
      />
    );

    expect(screen.getByText("What will be copied")).toBeTruthy();
    expect(screen.getByText("Never copied")).toBeTruthy();
    expect(screen.getByText("2 members (1 with a wallet address)")).toBeTruthy();
    expect(screen.getByText("Balances and who-owes-whom")).toBeTruthy();
  });
});
