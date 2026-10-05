/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { TripSearch } from "@/components/trips/TripSearch";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";

describe("debounced list controls", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it("keeps typing responsive but publishes one trip search after the pause", () => {
    const onSearchChange = jest.fn();
    render(
      <TripSearch value="" onSearchChange={onSearchChange} delayMs={300} />,
    );
    onSearchChange.mockClear();

    const input = screen.getByRole("searchbox", { name: "Search trips" });
    fireEvent.change(input, { target: { value: "r" } });
    fireEvent.change(input, { target: { value: "ro" } });
    fireEvent.change(input, { target: { value: "road" } });

    expect(input).toHaveValue("road");
    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(299));
    expect(onSearchChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenLastCalledWith("road");
  });

  it("debounces expense text while applying the status selector immediately", () => {
    const onQueryChange = jest.fn();
    const onStatusChange = jest.fn();
    render(
      <ExpenseFilters
        query=""
        status="all"
        onQueryChange={onQueryChange}
        onStatusChange={onStatusChange}
        delayMs={300}
      />,
    );
    onQueryChange.mockClear();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search expenses" }), {
      target: { value: "hotel" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Expense status" }), {
      target: { value: "open" },
    });

    expect(onStatusChange).toHaveBeenCalledWith("open");
    expect(onQueryChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(300));
    expect(onQueryChange).toHaveBeenCalledWith("hotel");
  });
});
