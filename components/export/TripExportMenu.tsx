"use client";

import { useState } from "react";
import Link from "next/link";
import { Archive, Calendar, FileSpreadsheet, Printer } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { CSV_BOM, downloadArchive, downloadText } from "@/lib/export/download";
import { buildTripCsv, exportFileStem } from "@/lib/export/tripExport";
import { buildTripCalendarIcs } from "@/lib/workspace/calendarExport";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

interface TripExportMenuProps {
  trip: Trip;
  expenses: Expense[];
}

const buttonClass =
  "inline-flex items-center gap-1 rounded-lg border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-[11px] font-bold text-[#555] hover:bg-[#F0F0F0] hover:text-[#0F0F14] disabled:opacity-50";

/** CSV, print/PDF summary, Calendar .ics, and portable archive for one trip. */
export function TripExportMenu({ trip, expenses }: TripExportMenuProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [archiving, setArchiving] = useState(false);

  const exportCsv = () => {
    try {
      const csv = buildTripCsv(trip, expenses, { explorerBase: STELLAR_EXPLORER });
      downloadText(`${exportFileStem(trip.name)}.csv`, CSV_BOM + csv, "text/csv;charset=utf-8");
    } catch (err) {
      toastError("Could not export CSV", err instanceof Error ? err.message : "Please try again.");
    }
  };

  const exportCalendar = () => {
    try {
      const ics = buildTripCalendarIcs(trip, trip.workspace?.itinerary ?? []);
      downloadText(`${exportFileStem(trip.name)}-itinerary.ics`, ics, "text/calendar;charset=utf-8");
      toastSuccess("Calendar exported", "Downloaded standards-compliant iCalendar file.");
    } catch (err) {
      toastError("Could not export calendar", err instanceof Error ? err.message : "Please try again.");
    }
  };

  const exportArchive = async () => {
    setArchiving(true);
    try {
      await downloadArchive([trip.id]);
      toastSuccess("Archive downloaded", "The export was recorded in your export history.");
    } catch (err) {
      toastError("Could not export archive", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 mb-6" aria-label="Export">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[#AAA]">Export</span>
      <button type="button" onClick={exportCsv} className={buttonClass}>
        <FileSpreadsheet size={11} />
        CSV
      </button>
      <button type="button" onClick={exportCalendar} className={buttonClass}>
        <Calendar size={11} />
        Calendar
      </button>
      <Link href={`/trips/${encodeURIComponent(trip.id)}/summary`} className={buttonClass}>
        <Printer size={11} />
        PDF summary
      </Link>
      <button type="button" onClick={exportArchive} disabled={archiving} className={buttonClass}>
        <Archive size={11} />
        {archiving ? "Preparing…" : "Archive"}
      </button>
    </div>
  );
}
