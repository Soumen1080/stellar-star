"use client";

import { useMemo } from "react";
import { useTripContext } from "@/context/TripContext";
import type { Trip } from "@/types/trip";

export const useTrip = useTripContext;

export function filterTrips(trips: Trip[], query: string): Trip[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return trips;
  return trips.filter((trip) =>
    [
      trip.name,
      trip.description ?? "",
      ...trip.members.flatMap((member) => [member.name, member.walletAddress ?? ""]),
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}

/** Filters the already-loaded wallet collection after the debounced query changes. */
export function useTripSearch(query: string) {
  const tripContext = useTripContext();
  const filteredTrips = useMemo(
    () => filterTrips(tripContext.trips, query),
    [query, tripContext.trips],
  );

  return {
    ...tripContext,
    trips: filteredTrips,
    totalTrips: tripContext.trips.length,
  };
}
