/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { LocaleProvider } from "@/context/LocaleContext";
import { HouseholdCoordinationPanel } from "@/components/household/HouseholdCoordinationPanel";
import { useHouseholdChores } from "@/hooks/useHouseholdChores";
import type { Trip } from "@/types/trip";

jest.mock("@/hooks/useHouseholdChores", () => ({
  useHouseholdChores: jest.fn(),
}));

const mockUseHouseholdChores = useHouseholdChores as jest.Mock;
const trip: Trip = {
  id: "trip-1",
  name: "Flat",
  members: [
    { id: "member-1", name: "Alice", walletAddress: "GALICE" },
    { id: "member-2", name: "Bob", walletAddress: "GBOB" },
  ],
  expenseIds: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  settled: false,
};

function renderPanel(tripEnabled = false) {
  mockUseHouseholdChores.mockReturnValue({
    chores: [],
    completions: [],
    preferences: [],
    myPreference: undefined,
    isLoading: false,
    isMutating: false,
    error: null,
    createChore: jest.fn().mockResolvedValue(true),
    completeChore: jest.fn().mockResolvedValue(true),
    archiveChore: jest.fn().mockResolvedValue(true),
    setOptOut: jest.fn().mockResolvedValue(true),
  });
  const onToggleModule = jest.fn().mockResolvedValue(undefined);
  render(
    <LocaleProvider>
      <HouseholdCoordinationPanel
        trip={{ ...trip, householdCoordinationEnabled: tripEnabled }}
        expenses={[]}
        currentWallet="GALICE"
        isOwner
        onToggleModule={onToggleModule}
      />
    </LocaleProvider>,
  );
  return { onToggleModule };
}

describe("HouseholdCoordinationPanel", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the prototype disabled until the owner opts in", () => {
    const { onToggleModule } = renderPanel();
    expect(screen.getByText("The trip owner has turned off household coordination.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enable research pilot" }));
    expect(onToggleModule).toHaveBeenCalledWith(true);
  });

  it("shows the research disclosure and opt-out control without touching finance UI", () => {
    renderPanel(true);
    expect(screen.getByText(/pilot feedback and success metrics/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Opt out of chore rotation" })).toBeTruthy();
    expect(screen.queryByText(/balance|payment/i)).toBeNull();
  });
});
