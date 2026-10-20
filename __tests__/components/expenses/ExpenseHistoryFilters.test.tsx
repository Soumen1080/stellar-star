/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { ExpenseHistoryFilters } from "@/components/expenses/ExpenseHistoryFilters";
import { EMPTY_HISTORY_FILTERS, type ExpenseHistoryFilters as Filters } from "@/lib/expense/historyFilters";

function setup(overrides: Partial<Filters> = {}) {
  const onChange = jest.fn();
  const onReset = jest.fn();
  const filters: Filters = { ...EMPTY_HISTORY_FILTERS, tags: [], ...overrides };
  const utils = render(
    <ExpenseHistoryFilters
      filters={filters}
      onChange={onChange}
      onReset={onReset}
      payerOptions={[{ value: "GALICE", label: "Alice" }]}
      assetOptions={["native"]}
      tagSuggestions={["goa", "food"]}
      resultSummary="3 expenses match these filters."
      hasActiveFilters={Object.keys(overrides).length > 0}
    />,
  );
  onChange.mockClear();
  return { ...utils, onChange, onReset };
}

describe("ExpenseHistoryFilters accessibility", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it("exposes the advanced panel through a disclosure button", () => {
    setup();
    const toggle = screen.getByRole("button", { name: /more filters/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel).not.toBeNull();
    expect(panel!.hidden).toBe(false);
  });

  it("opens the panel on load when advanced filters come from the URL", () => {
    setup({ category: "food" });
    expect(screen.getByRole("button", { name: /more filters/i }).getAttribute("aria-expanded")).toBe("true");
  });

  it("labels every control so screen readers can name it", () => {
    setup({ category: "food" });
    expect(screen.getByRole("searchbox", { name: "Search expenses" })).toBeTruthy();
    for (const name of [/expense status/i, /category/i, /paid by/i, /settlement asset/i, /^from$/i, /^to$/i, /^tags$/i]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("applies select filters immediately", () => {
    const { onChange } = setup({ category: "food" });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "lodging" } });
    fireEvent.change(screen.getByLabelText(/paid by/i), { target: { value: "GALICE" } });
    expect(onChange).toHaveBeenCalledWith({ category: "lodging" });
    expect(onChange).toHaveBeenCalledWith({ payer: "GALICE" });
  });

  it("adds a normalized tag with the Enter key and removes it with a labelled button", () => {
    const { onChange, rerender } = setup({ category: "food" });
    const input = screen.getByLabelText(/^tags$/i);
    fireEvent.change(input, { target: { value: "#Beach Day" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ tags: ["beach-day"] });

    rerender(
      <ExpenseHistoryFilters
        filters={{ ...EMPTY_HISTORY_FILTERS, tags: ["beach-day"] }}
        onChange={onChange}
        onReset={jest.fn()}
        payerOptions={[]}
        assetOptions={["native"]}
        tagSuggestions={[]}
        resultSummary=""
        hasActiveFilters
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove tag filter beach-day" }));
    expect(onChange).toHaveBeenLastCalledWith({ tags: [] });
  });

  it("announces results in a polite live region and offers a reset", () => {
    const { onReset } = setup({ status: "settled" });
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("3 expenses match these filters.");

    fireEvent.click(screen.getByRole("button", { name: /clear all filters/i }));
    expect(onReset).toHaveBeenCalled();
  });
});
