"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteTripTemplateRow,
  fetchTripTemplates,
  saveTripTemplateRow,
} from "@/lib/supabase/queries";
import { buildTemplateFromTrip, newCopyIdempotencyKey } from "@/lib/trip/templates";
import type { Trip, TripTemplate } from "@/types/trip";

/**
 * The signed-in wallet's trip templates.
 *
 * Deliberately not a context provider: templates are only needed while the
 * copy flow or the save-as-template dialog is open, so they load lazily when
 * `enabled` turns true instead of on every page.
 */
export function useTripTemplates(enabled = true) {
  const [templates, setTemplates] = useState<TripTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await fetchTripTemplates();
      if (mounted.current) setTemplates(rows);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not load templates.");
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void refresh();
    return () => {
      mounted.current = false;
    };
  }, [enabled, refresh]);

  /**
   * Saves `trip` as a template. Pass the same `idempotencyKey` when retrying
   * one save so a double submit cannot produce two templates.
   */
  const saveFromTrip = useCallback(
    async (trip: Trip, name: string, idempotencyKey: string = newCopyIdempotencyKey()) => {
      const draft = { ...buildTemplateFromTrip(trip), name: name.trim() || trip.name };
      const saved = await saveTripTemplateRow(idempotencyKey, trip.id, draft);
      if (mounted.current) {
        setTemplates((previous) =>
          previous.some((t) => t.id === saved.id) ? previous : [saved, ...previous],
        );
      }
      return saved;
    },
    [],
  );

  const removeTemplate = useCallback(async (id: string) => {
    await deleteTripTemplateRow(id);
    if (mounted.current) setTemplates((previous) => previous.filter((t) => t.id !== id));
  }, []);

  return { templates, isLoading, error, refresh, saveFromTrip, removeTemplate };
}
