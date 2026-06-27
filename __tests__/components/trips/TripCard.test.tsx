/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TripCard } from "@/components/trips/TripCard";
import type { Trip } from "@/types/trip";

// Mock next/link
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: any) => <a href={href}>{children}</a>,
}));

describe("TripCard Owner-Aware Delete Controls", () => {
  const mockOnDelete = jest.fn();

  const mockTrip: Trip = {
    id: "trip-1",
    name: "Paris Trip",
    description: "Sightseeing in Paris",
    members: [],
    expenseIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
    createdByWallet: "G_CREATOR_PUBLIC_KEY_1234567890",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the Delete button when connected wallet matches the trip creator", () => {
    render(
      <TripCard
        trip={mockTrip}
        onDelete={mockOnDelete}
        connectedWalletAddress="G_CREATOR_PUBLIC_KEY_1234567890"
      />
    );

    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeTruthy();

    fireEvent.click(deleteBtn);
    expect(mockOnDelete).toHaveBeenCalledWith("trip-1");
  });

  it("hides the Delete button when connected wallet does not match the trip creator", () => {
    render(
      <TripCard
        trip={mockTrip}
        onDelete={mockOnDelete}
        connectedWalletAddress="G_OTHER_PUBLIC_KEY_0987654321"
      />
    );

    const deleteBtn = screen.queryByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeNull();
  });

  it("hides the Delete button when no wallet is connected", () => {
    render(
      <TripCard
        trip={mockTrip}
        onDelete={mockOnDelete}
        connectedWalletAddress={null}
      />
    );

    const deleteBtn = screen.queryByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeNull();
  });
});
