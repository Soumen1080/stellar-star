/** @jest-environment jsdom */

import React from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { TripProvider, useTripContext } from "@/context/TripContext";
import { useWalletContext } from "@/context/WalletContext";
import * as eventWatcherModule from "@/hooks/useContractEvents";

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: jest.fn(() => ({ publicKey: "G_TEST_WALLET" })),
}));

jest.mock("@/lib/supabase/queries", () => {
  const actual = jest.requireActual("@/lib/supabase/queries");
  return {
    ...actual,
    fetchTrips: jest.fn().mockResolvedValue([
      {
        id: "trip-1",
        name: "Tokyo Trip",
        settled: false,
        members: [{ id: "m1", name: "Alice", walletAddress: "G_TEST_WALLET" }],
        expenseIds: [],
        createdAt: new Date().toISOString(),
      },
      {
        id: "trip-2",
        name: "Kyoto Trip",
        settled: true,
        members: [{ id: "m2", name: "Bob", walletAddress: "G_TEST_WALLET" }],
        expenseIds: [],
        createdAt: new Date().toISOString(),
      },
    ]),
    updateTripRow: jest.fn().mockImplementation((id, updates) => ({
      id,
      name: "Tokyo Trip",
      settled: true,
      members: [],
      expenseIds: [],
      createdAt: new Date().toISOString(),
      ...updates,
    })),
    deleteTripRow: jest.fn().mockResolvedValue(true),
  };
});

jest.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: jest.fn(() => true),
  getSupabaseClient: jest.fn(() => null),
  requireSupabaseClient: jest.fn(),
  requireAuthenticatedClient: jest.fn(),
  resetSupabaseClient: jest.fn(),
}));

describe("TripContext Activity & Watcher Management", () => {
  let cancelTripWatcherSpy: jest.SpyInstance;
  let cancelAllTripWatchersSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    cancelTripWatcherSpy = jest.spyOn(eventWatcherModule, "cancelTripWatcher");
    cancelAllTripWatchersSpy = jest.spyOn(eventWatcherModule, "cancelAllTripWatchers");
  });

  afterEach(() => {
    cancelTripWatcherSpy.mockRestore();
    cancelAllTripWatchersSpy.mockRestore();
  });

  it("cancels stale watcher when switching active trips", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TripProvider>{children}</TripProvider>
    );

    const { result } = renderHook(() => useTripContext(), { wrapper });

    act(() => {
      result.current.setActiveTripId("trip-1");
    });
    expect(result.current.activeTripId).toBe("trip-1");
    expect(cancelTripWatcherSpy).not.toHaveBeenCalled();

    // Switch active trip to trip-2
    act(() => {
      result.current.setActiveTripId("trip-2");
    });
    expect(result.current.activeTripId).toBe("trip-2");
    // Cancels watcher for trip-1
    expect(cancelTripWatcherSpy).toHaveBeenCalledWith("trip-1");
  });

  it("evaluates isTripActive accurately based on activeTripId and settled status", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TripProvider>{children}</TripProvider>
    );

    const { result } = renderHook(() => useTripContext(), { wrapper });

    act(() => {
      result.current.setActiveTripId("trip-1");
    });

    // trip-1 is active and not settled
    expect(result.current.isTripActive("trip-1")).toBe(true);

    // trip-2 is settled
    expect(result.current.isTripActive("trip-2")).toBe(false);
  });

  it("cancels trip watcher upon settling a trip", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TripProvider>{children}</TripProvider>
    );

    const { result } = renderHook(() => useTripContext(), { wrapper });

    await act(async () => {
      await result.current.settleTrip("trip-1");
    });

    expect(cancelTripWatcherSpy).toHaveBeenCalledWith("trip-1");
  });

  it("cancels trip watcher and clears activeTripId upon deleting active trip", async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TripProvider>{children}</TripProvider>
    );

    const { result } = renderHook(() => useTripContext(), { wrapper });

    act(() => {
      result.current.setActiveTripId("trip-1");
    });
    expect(result.current.activeTripId).toBe("trip-1");

    await act(async () => {
      await result.current.deleteTrip("trip-1");
    });

    expect(cancelTripWatcherSpy).toHaveBeenCalledWith("trip-1");
    expect(result.current.activeTripId).toBeNull();
  });
});
