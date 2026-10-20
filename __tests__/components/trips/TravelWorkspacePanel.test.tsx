/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TravelWorkspacePanel } from "@/components/trips/workspace/TravelWorkspacePanel";
import type { Trip } from "@/types/trip";
import type { Expense } from "@/types/expense";

const mockUpdateTrip = jest.fn().mockResolvedValue(undefined);
jest.mock("@/hooks/useTrip", () => ({
  useTrip: () => ({
    updateTrip: mockUpdateTrip,
  }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: mockToastSuccess,
    error: mockToastError,
  }),
}));

describe("TravelWorkspacePanel", () => {
  const mockTrip: Trip = {
    id: "trip-kyoto-1",
    name: "Kyoto Autumn Trip",
    members: [
      { id: "mem-1", name: "Alice", walletAddress: "GALICE111" },
      { id: "mem-2", name: "Bob", walletAddress: "GBOB222" },
    ],
    expenseIds: ["exp-shinkansen-1"],
    createdAt: "2026-10-20T10:00:00Z",
    settled: false,
    createdByWallet: "GALICE111",
    workspace: {
      itinerary: [
        {
          id: "itin-1",
          tripId: "trip-kyoto-1",
          title: "Bullet Train to Kyoto",
          location: "Tokyo Station",
          startDate: "2026-11-10T09:00:00Z",
          category: "transit",
          reminderMinutesBefore: 60,
          linkedExpenseIds: ["exp-shinkansen-1"],
          createdAt: "2026-10-20T10:00:00Z",
        },
      ],
      checklists: [
        {
          id: "chk-1",
          tripId: "trip-kyoto-1",
          title: "JR Rail Pass Exchange Order",
          category: "documents",
          isCompleted: false,
          assignedToMemberId: "mem-1",
          createdAt: "2026-10-20T10:00:00Z",
        },
      ],
      bookings: [
        {
          id: "bk-1",
          tripId: "trip-kyoto-1",
          title: "Ryokan Reservation",
          bookingType: "hotel",
          confirmationCode: "RYOKAN-CONF-1234",
          permission: "all_members",
          createdByWallet: "GALICE111",
          linkedExpenseId: "exp-shinkansen-1",
          createdAt: "2026-10-20T10:00:00Z",
        },
        {
          id: "bk-restricted",
          tripId: "trip-kyoto-1",
          title: "Alice Private Flight Ticket",
          bookingType: "flight",
          confirmationCode: "SECRET-PNR-999",
          permission: "creator_only",
          createdByWallet: "GALICE111",
          createdAt: "2026-10-20T10:00:00Z",
        },
      ],
    },
  };

  const mockExpenses: Expense[] = [
    {
      id: "exp-shinkansen-1",
      title: "Shinkansen Tickets",
      totalAmount: "280.0000000",
      currency: "USD",
      splitMode: "equal",
      paidByMemberId: "mem-1",
      members: mockTrip.members,
      shares: [],
      createdAt: "2026-10-20T10:00:00Z",
      settled: false,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders workspace summary statistics and sub-navigation", () => {
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GALICE111"
      />
    );

    expect(screen.getByText("Shared Travel Workspace")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy(); // 1 Itinerary event
    expect(screen.getByText("Itinerary Events")).toBeTruthy();
    expect(screen.getByText("Bookings & Passes")).toBeTruthy();
  });

  it("renders itinerary events with reminders and linked expenses", () => {
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GALICE111"
      />
    );

    expect(screen.getByText("Bullet Train to Kyoto")).toBeTruthy();
    expect(screen.getByText("Tokyo Station")).toBeTruthy();
    expect(screen.getByText(/Reminder:\s*60m before/i)).toBeTruthy();

    // Linked expense badge (without duplicating financial fields)
    expect(screen.getByText("Shinkansen Tickets")).toBeTruthy();
    expect(screen.getByText(/\(280\.0000000\s*USD\)/i)).toBeTruthy();
  });

  it("switches to Packing & Tasks and displays checklist items", () => {
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GALICE111"
      />
    );

    const checklistTab = screen.getByRole("button", { name: /Packing & Tasks/i });
    fireEvent.click(checklistTab);

    expect(screen.getByText("JR Rail Pass Exchange Order")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("switches to Bookings & Files and respects permission controls", () => {
    // Rendered for Bob (not creator)
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GBOB222"
      />
    );

    const bookingsTab = screen.getByRole("button", { name: /Bookings & Files/i });
    fireEvent.click(bookingsTab);

    // All-members booking is visible with its confirmation code
    expect(screen.getByText("Ryokan Reservation")).toBeTruthy();
    expect(screen.getByText("RYOKAN-CONF-1234")).toBeTruthy();

    // Creator-only booking has restricted notice for Bob
    expect(screen.getByText("Alice Private Flight Ticket")).toBeTruthy();
    expect(screen.getByText(/Restricted Access:\s*Confirmation details are only visible to authorized members/i)).toBeTruthy();
    expect(screen.queryByText("SECRET-PNR-999")).toBeNull();
  });

  it("opens the Calendar Export modal when export button is clicked", () => {
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GALICE111"
      />
    );

    const exportBtn = screen.getByRole("button", { name: /Export Calendar \(\.ics\)/i });
    fireEvent.click(exportBtn);

    expect(screen.getByText("Export Trip Calendar")).toBeTruthy();
    expect(screen.getByText("Download .ics Calendar")).toBeTruthy();
  });

  it("opens the Privacy & Data Policy modal with export and purge options", () => {
    render(
      <TravelWorkspacePanel
        trip={mockTrip}
        expenses={mockExpenses}
        currentUserPublicKey="GALICE111"
      />
    );

    const privacyBtn = screen.getByRole("button", { name: /Privacy & Data Policy/i });
    fireEvent.click(privacyBtn);

    expect(screen.getByText("Travel Workspace Privacy & Data Policy")).toBeTruthy();
    expect(screen.getByText("Export Travel Data (.json)")).toBeTruthy();
    expect(screen.getByText("Delete Travel Content")).toBeTruthy();
  });
});
