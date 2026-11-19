/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { Trip } from "@/types/trip";
import type { TravelWorkspace } from "@/types/workspace";

const mockUpdateTrip = jest.fn();
const mockAppendChoreCompletion = jest.fn();
let mockPublicKey = "WALLET_A";

jest.mock("@/hooks/useTrip", () => ({
  useTrip: () => ({
    updateTrip: mockUpdateTrip,
    appendChoreCompletion: mockAppendChoreCompletion,
  }),
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({ publicKey: mockPublicKey }),
}));

const mockToastError = jest.fn();
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: mockToastError,
  }),
}));

describe("useWorkspace chore mutations", () => {
  const workspace: TravelWorkspace = {
    itinerary: [],
    checklists: [],
    bookings: [],
    chores: [{
      id: "chore-dishes",
      tripId: "trip-1",
      title: "Wash dishes",
      cadence: "weekly",
      rotationMemberIds: ["member-a", "member-b"],
      completionHistory: [],
      createdByWallet: "WALLET_A",
      createdAt: "2026-10-19T08:00:00.000Z",
    }],
    choreOptOutWallets: [],
    choresEnabled: true,
  };

  const trip: Trip = {
    id: "trip-1",
    name: "Trip",
    members: [
      { id: "member-a", name: "Alice", walletAddress: "WALLET_A" },
      { id: "member-b", name: "Bob", walletAddress: "WALLET_B" },
    ],
    expenseIds: [],
    createdAt: "2026-10-19T08:00:00.000Z",
    settled: false,
    createdByWallet: "WALLET_A",
    workspace,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPublicKey = "WALLET_A";
    mockUpdateTrip.mockResolvedValue(undefined);
  });

  it("rejects non-owner chore creation and module changes in the mutation layer", async () => {
    mockPublicKey = "WALLET_B";
    const { result } = renderHook(() => useWorkspace(trip));

    await act(async () => {
      await expect(result.current.addChore({
        title: "Sweep",
        cadence: "weekly",
        rotationMemberIds: ["member-a"],
      })).rejects.toThrow("Only the trip owner can add chores.");
      await expect(result.current.setChoresEnabled(false)).rejects.toThrow(
        "Only the trip owner can change chore coordination.",
      );
    });

    expect(mockUpdateTrip).not.toHaveBeenCalled();
  });

  it("rejects completion by a member other than the current assignee", async () => {
    mockPublicKey = "WALLET_B";
    const { result } = renderHook(() => useWorkspace(trip));

    await act(async () => {
      await expect(result.current.completeChore("chore-dishes")).rejects.toThrow(
        "Only the currently assigned member can complete this chore.",
      );
    });

    expect(mockAppendChoreCompletion).not.toHaveBeenCalled();
  });

  it("uses atomic completion and stores the server-returned workspace", async () => {
    const savedWorkspace: TravelWorkspace = {
      ...workspace,
      chores: [{
        ...workspace.chores[0],
        completionHistory: [{
          completedAt: "2026-11-19T10:00:00.000Z",
          completedByWallet: "WALLET_A",
          assignedMemberId: "member-a",
          periodKey: "2026-11-16",
        }],
      }],
    };
    mockAppendChoreCompletion.mockResolvedValue({ ...trip, workspace: savedWorkspace });
    const { result } = renderHook(() => useWorkspace(trip));

    await act(async () => {
      await result.current.completeChore("chore-dishes");
    });

    expect(mockAppendChoreCompletion).toHaveBeenCalledWith("trip-1", "chore-dishes");
    expect(mockUpdateTrip).not.toHaveBeenCalled();
    expect(result.current.workspace.chores[0].completionHistory).toHaveLength(1);
  });

  it("keeps local state unchanged and reports a failed workspace write", async () => {
    mockUpdateTrip.mockRejectedValueOnce(new Error("Database unavailable"));
    const { result } = renderHook(() => useWorkspace(trip));

    await act(async () => {
      await expect(result.current.addItineraryItem({
        title: "Dinner",
        startDate: "2026-11-20T18:00:00.000Z",
        category: "food",
      })).rejects.toThrow("Database unavailable");
    });

    expect(result.current.workspace.itinerary).toEqual([]);
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not save travel workspace",
      "Database unavailable",
    );
  });
});
