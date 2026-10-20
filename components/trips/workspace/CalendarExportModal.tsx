"use client";

import React, { useState } from "react";
import { Calendar, Globe, Download, CheckCircle2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { Trip } from "@/types/trip";
import type { ItineraryItem } from "@/types/workspace";
import {
  buildTripCalendarIcs,
  COMMON_TIMEZONES,
  getSystemTimezone,
} from "@/lib/workspace/calendarExport";
import { downloadText } from "@/lib/export/download";
import { useToast } from "@/components/ui/Toast";

interface CalendarExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip: Trip;
  itinerary: ItineraryItem[];
}

export function CalendarExportModal({
  isOpen,
  onClose,
  trip,
  itinerary,
}: CalendarExportModalProps) {
  const [timezone, setTimezone] = useState<string>(getSystemTimezone());
  const { success: toastSuccess, error: toastError } = useToast();
  const [downloaded, setDownloaded] = useState(false);

  const handleExport = () => {
    try {
      const ics = buildTripCalendarIcs(trip, itinerary, { timezone });
      const filename = `${trip.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "trip"}-itinerary.ics`;
      downloadText(filename, ics, "text/calendar;charset=utf-8");
      setDownloaded(true);
      toastSuccess("Calendar exported", `Saved ${itinerary.length} event(s) in ${timezone}`);
      setTimeout(() => {
        onClose();
        setDownloaded(false);
      }, 1200);
    } catch (err: any) {
      toastError("Calendar export failed", err?.message || "Please try again.");
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Export Trip Calendar"
      description="Export your itinerary as a standard iCalendar (.ics) file respecting each member's timezone."
      size="md"
    >
      <div className="space-y-4 pt-1">
        <div className="p-3 bg-white rounded-xl border border-[#DDD] space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#0F0F14]">
            <Globe size={14} className="text-[#2DD4BF]" />
            Select Your Timezone
          </label>
          <p className="text-[11px] text-[#777] leading-relaxed">
            All itinerary event start/end times and alarms will be calculated relative to your selected timezone.
          </p>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          >
            {!COMMON_TIMEZONES.includes(timezone) && (
              <option value={timezone}>{timezone} (System Detected)</option>
            )}
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>

        <div className="p-3 bg-[#F9F9F9] rounded-xl border border-[#EBEBEB] text-xs space-y-1.5">
          <div className="flex items-center justify-between text-[#555]">
            <span>Itinerary events to export:</span>
            <span className="font-semibold text-[#0F0F14]">{itinerary.length} items</span>
          </div>
          <div className="flex items-center justify-between text-[#555]">
            <span>Standard format:</span>
            <span className="font-mono text-[11px] text-[#2DD4BF]">RFC 5545 (.ics)</span>
          </div>
          <div className="flex items-center justify-between text-[#555]">
            <span>Supported apps:</span>
            <span className="text-[11px] text-[#777]">Apple Calendar, Google Calendar, Outlook</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#EBEBEB]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#777] hover:text-[#0F0F14] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition-all shadow-sm"
          >
            {downloaded ? (
              <>
                <CheckCircle2 size={13} />
                Downloaded!
              </>
            ) : (
              <>
                <Download size={13} />
                Download .ics Calendar
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
