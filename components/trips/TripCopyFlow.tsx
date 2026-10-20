"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Copy, History, LayoutTemplate, Trash2 } from "lucide-react";
import { TripCopyPreview } from "@/components/trips/TripCopyPreview";
import { TripForm } from "@/components/trips/TripForm";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useTrip } from "@/hooks/useTrip";
import { useTripTemplates } from "@/hooks/useTripTemplates";
import {
  buildTripDraftFromTemplate,
  buildTripDraftFromTrip,
  describeCopy,
  newCopyIdempotencyKey,
} from "@/lib/trip/templates";
import { cn, sanitizeText } from "@/lib/utils";
import type { Trip, TripCopySource, TripFormData, TripTemplate } from "@/types/trip";

interface TripCopyFlowProps {
  /** Past trips the user may duplicate. */
  trips: Trip[];
  /** Skip the picker and duplicate this trip ("Duplicate" on a trip page). */
  initialTripId?: string;
  currentUserPublicKey?: string | null;
  currentUserName?: string | null;
  onCreated: (trip: Trip) => void;
  onCancel: () => void;
}

interface Attempt {
  source: TripCopySource;
  draft: TripFormData;
  /** Fixed for the life of this attempt so every retry is the same request. */
  idempotencyKey: string;
  tripId: string;
}

function startAttempt(source: TripCopySource, draft: TripFormData): Attempt {
  return { source, draft, idempotencyKey: newCopyIdempotencyKey(), tripId: crypto.randomUUID() };
}

/**
 * Start a trip from a template or a past trip.
 *
 * Step 1 picks the source; step 2 shows what will (and will not) be copied
 * above an editable form, so names, dates, members, recurring rules and
 * permissions can all change before anything is written.
 */
export function TripCopyFlow({
  trips,
  initialTripId,
  currentUserPublicKey,
  currentUserName,
  onCreated,
  onCancel,
}: TripCopyFlowProps) {
  const { copyTrip } = useTrip();
  const { templates, isLoading, error, removeTemplate } = useTripTemplates(true);
  const { success: toastSuccess, error: toastError } = useToast();
  const [tab, setTab] = useState<"templates" | "trips">("templates");
  const [submitting, setSubmitting] = useState(false);

  const pick = (source: TripCopySource): Attempt | null => {
    if (source.kind === "template") {
      const template = templates.find((t) => t.id === source.id);
      return template ? startAttempt(source, buildTripDraftFromTemplate(template)) : null;
    }
    const trip = trips.find((t) => t.id === source.id);
    return trip ? startAttempt(source, buildTripDraftFromTrip(trip)) : null;
  };

  const [attempt, setAttempt] = useState<Attempt | null>(() =>
    initialTripId ? pick({ kind: "trip", id: initialTripId }) : null
  );

  const preview = useMemo(() => {
    if (!attempt) return null;
    if (attempt.source.kind === "template") {
      const template = templates.find((t) => t.id === attempt.source.id);
      return template ? describeCopy({ kind: "template", template }) : null;
    }
    const trip = trips.find((t) => t.id === attempt.source.id);
    return trip ? describeCopy({ kind: "trip", trip }) : null;
  }, [attempt, templates, trips]);

  const handleSubmit = async (draft: TripFormData) => {
    if (!attempt) return;
    setSubmitting(true);
    try {
      const trip = await copyTrip({
        idempotencyKey: attempt.idempotencyKey,
        source: attempt.source,
        tripId: attempt.tripId,
        draft,
      });
      toastSuccess("Trip created!", `"${sanitizeText(trip.name)}" is ready.`);
      onCreated(trip);
    } catch (err) {
      // The key is kept, so pressing Create again retries the same request and
      // cannot produce a second trip if the first one actually landed.
      toastError("Could not create trip", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTemplate = async (template: TripTemplate) => {
    try {
      await removeTemplate(template.id);
      toastSuccess("Template deleted", `"${sanitizeText(template.name)}" was removed.`);
    } catch (err) {
      toastError("Could not delete template", err instanceof Error ? err.message : "Please try again.");
    }
  };

  if (attempt) {
    return (
      <div className="space-y-5">
        {!initialTripId && (
          <button
            type="button"
            onClick={() => setAttempt(null)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-[#888] hover:text-[#0F0F14]"
          >
            <ArrowLeft size={12} />
            Choose a different source
          </button>
        )}
        {preview && <TripCopyPreview preview={preview} />}
        <TripForm
          key={attempt.idempotencyKey}
          initialData={attempt.draft}
          currentUserPublicKey={currentUserPublicKey}
          currentUserName={currentUserName}
          submitLabel="Create trip"
          submitting={submitting}
          onSubmit={handleSubmit}
          onCancel={onCancel}
        />
      </div>
    );
  }

  const pastTrips = trips.filter((t) => t.members.length > 0);

  return (
    <div className="space-y-4">
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-[#F0F0F0] p-1">
        {(
          [
            ["templates", "Templates", LayoutTemplate],
            ["trips", "Past trips", History],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition-all",
              tab === key ? "bg-white text-[#0F0F14] shadow-sm" : "text-[#888]"
            )}
          >
            <Icon size={12} />
            {label}
          </button>
        ))}
      </div>

      {tab === "templates" ? (
        isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner size={24} className="text-[#2DD4BF]" />
          </div>
        ) : error ? (
          <p className="text-sm text-red-500">{error}</p>
        ) : templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#E5E5E5] px-4 py-6 text-center text-sm text-[#AAA]">
            No templates yet. Open a trip and choose <strong>Save as template</strong>.
          </p>
        ) : (
          <ul className="space-y-2">
            {templates.map((template) => (
              <SourceRow
                key={template.id}
                title={template.name}
                subtitle={`${template.members.length} members · ${template.recurringRules.length} recurring`}
                onUse={() => setAttempt(pick({ kind: "template", id: template.id }))}
                onDelete={() => handleDeleteTemplate(template)}
              />
            ))}
          </ul>
        )
      ) : pastTrips.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#E5E5E5] px-4 py-6 text-center text-sm text-[#AAA]">
          No past trips to duplicate yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {pastTrips.map((trip) => (
            <SourceRow
              key={trip.id}
              title={trip.name}
              subtitle={`${trip.members.length} members · ${trip.expenseIds.length} expenses (not copied)`}
              onUse={() => setAttempt(pick({ kind: "trip", id: trip.id }))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Duplicates one trip and navigates to the new one. The router lives here,
 * inside the open dialog, rather than on the trip page itself.
 */
export function DuplicateTripFlow({
  onDone,
  ...props
}: Omit<TripCopyFlowProps, "onCreated"> & { onDone: () => void }) {
  const router = useRouter();
  return (
    <TripCopyFlow
      {...props}
      onCreated={(trip) => {
        onDone();
        router.push(`/trips/${trip.id}`);
      }}
    />
  );
}

function SourceRow({
  title,
  subtitle,
  onUse,
  onDelete,
}: {
  title: string;
  subtitle: string;
  onUse: () => void;
  onDelete?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-[#E5E5E5] bg-white px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold text-[#0F0F14]">{title}</p>
        <p className="text-xs text-[#AAA]">{subtitle}</p>
      </div>
      {onDelete && (
        <button
          type="button"
          aria-label={`Delete template ${title}`}
          onClick={onDelete}
          className="p-2 rounded-lg text-[#CCC] hover:text-red-500 hover:bg-red-50"
        >
          <Trash2 size={13} />
        </button>
      )}
      <button
        type="button"
        onClick={onUse}
        className="inline-flex items-center gap-1 rounded-lg bg-[#0F0F14] px-3 py-1.5 text-xs font-bold text-[#2DD4BF] hover:bg-[#1A1A22]"
      >
        <Copy size={11} />
        Use
      </button>
    </li>
  );
}
