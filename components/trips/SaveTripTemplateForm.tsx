"use client";

import React, { useMemo, useRef, useState } from "react";
import { TripCopyPreview } from "@/components/trips/TripCopyPreview";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { useTripTemplates } from "@/hooks/useTripTemplates";
import { describeCopy, newCopyIdempotencyKey } from "@/lib/trip/templates";
import { sanitizeText } from "@/lib/utils";
import type { Trip } from "@/types/trip";

interface SaveTripTemplateFormProps {
  trip: Trip;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * Saves a trip's structure as a reusable template. The preview is computed
 * from the same allow-list the save uses, so what the user reads is what is
 * stored: members, recurring rules and permissions — never balances.
 */
export function SaveTripTemplateForm({ trip, onSaved, onCancel }: SaveTripTemplateFormProps) {
  const { saveFromTrip } = useTripTemplates(false);
  const { success: toastSuccess, error: toastError } = useToast();
  const [name, setName] = useState(trip.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One key per open dialog: a double click or a retry after a lost response
  // resolves to the template the first request created.
  const idempotencyKey = useRef(newCopyIdempotencyKey());

  const preview = useMemo(() => describeCopy({ kind: "trip", trip }), [trip]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Template name is required");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveFromTrip(trip, name, idempotencyKey.current);
      toastSuccess("Template saved", `Start new trips from "${sanitizeText(saved.name)}".`);
      onSaved();
    } catch (err) {
      toastError("Could not save template", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Input
        label="Template name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        error={error ?? undefined}
        required
      />
      <TripCopyPreview preview={preview} title="Saved in the template" />
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl border border-[#E5E5E5] text-sm font-semibold text-[#555] hover:bg-[#F0F0F0] transition-all"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="flex-1 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save template"}
        </button>
      </div>
    </form>
  );
}
