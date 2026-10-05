import { filterTrips } from "@/hooks/useTrip";
import type { Trip } from "@/types/trip";

const trips: Trip[] = [
  {
    id: "trip-1",
    name: "Road Trip",
    description: "Goa weekend",
    members: [{ id: "member-1", name: "Alice", walletAddress: "GALICE" }],
    expenseIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  },
  {
    id: "trip-2",
    name: "Conference",
    members: [{ id: "member-2", name: "Bob", walletAddress: "GBOB" }],
    expenseIds: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    settled: false,
  },
];

describe("filterTrips", () => {
  it("matches trip metadata, members, and wallet addresses", () => {
    expect(filterTrips(trips, "goa").map((trip) => trip.id)).toEqual(["trip-1"]);
    expect(filterTrips(trips, "bob").map((trip) => trip.id)).toEqual(["trip-2"]);
    expect(filterTrips(trips, "galice").map((trip) => trip.id)).toEqual(["trip-1"]);
  });

  it("returns the original collection for a blank query", () => {
    expect(filterTrips(trips, "   ")).toBe(trips);
  });
});
