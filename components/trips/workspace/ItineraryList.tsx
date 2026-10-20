"use client";

import React from "react";
import {
  Calendar,
  Clock,
  MapPin,
  Bell,
  Trash2,
  Edit2,
  ExternalLink,
  Receipt,
  Plane,
  Building,
  Coffee,
  Car,
  Compass,
  Users,
  Plus,
} from "lucide-react";
import type { Expense } from "@/types/expense";
import type { ItineraryCategory, ItineraryItem } from "@/types/workspace";
import { getGoogleCalendarUrl } from "@/lib/workspace/calendarExport";
import { useLocale } from "@/context/LocaleContext";

interface ItineraryListProps {
  itinerary: ItineraryItem[];
  expenses: Expense[];
  onOpenAddModal: () => void;
  onEditItem: (item: ItineraryItem) => void;
  onDeleteItem: (itemId: string) => Promise<void>;
}

const CATEGORY_ICONS: Record<
  ItineraryCategory,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  activity: Compass,
  flight: Plane,
  lodging: Building,
  transit: Car,
  food: Coffee,
  meeting: Users,
  other: Calendar,
};

export function ItineraryList({
  itinerary,
  expenses,
  onOpenAddModal,
  onEditItem,
  onDeleteItem,
}: ItineraryListProps) {
  // Sort items chronologically
  const sorted = [...itinerary].sort((a, b) => {
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  });

  const { formatDate } = useLocale();

  // Group by day string
  const groupedByDate: Record<string, ItineraryItem[]> = {};
  for (const item of sorted) {
    let dateKey = "Unscheduled";
    try {
      const d = new Date(item.startDate);
      if (!isNaN(d.getTime())) {
        dateKey = formatDate(d, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }
    } catch {
      // keep fallback
    }
    if (!groupedByDate[dateKey]) groupedByDate[dateKey] = [];
    groupedByDate[dateKey].push(item);
  }

  const formatTime = (isoString?: string) => {
    if (!isoString) return "";
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      return "";
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Add Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-white rounded-2xl border border-[#EBEBEB] shadow-sm">
        <div>
          <h3 className="text-xs font-bold text-[#0F0F14]">Dated Itinerary & Events</h3>
          <p className="text-[11px] text-[#777] leading-relaxed">
            Organize daily travel events, flights, and activities with optional reminders.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenAddModal}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition-all shadow-sm shrink-0"
        >
          <Plus size={13} />
          Add Event
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-[#DDD] text-[#888] text-xs">
          No itinerary items scheduled yet. Add flights, check-ins, or tours to your trip schedule!
        </div>
      ) : (
        Object.entries(groupedByDate).map(([dateLabel, items]) => (
          <div key={dateLabel} className="space-y-3">
            {/* Day Header */}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[#2DD4BF]" />
              <h4 className="text-xs font-bold text-[#0F0F14]">{dateLabel}</h4>
              <span className="text-[10px] text-[#888] font-mono">({items.length} events)</span>
            </div>

            {/* Events for this day */}
            <div className="space-y-2.5">
              {items.map((item) => {
                const Icon = CATEGORY_ICONS[item.category] || Calendar;
                const startTime = formatTime(item.startDate);
                const endTime = formatTime(item.endDate);
                const googleUrl = getGoogleCalendarUrl(item);

                // Find linked expenses without duplicating financial data
                const linkedExpenses = (item.linkedExpenseIds ?? [])
                  .map((id) => expenses.find((e) => e.id === id))
                  .filter(Boolean) as Expense[];

                return (
                  <div
                    key={item.id}
                    className="p-4 bg-white rounded-2xl border border-[#EBEBEB] space-y-3 shadow-sm hover:border-[#DDD] transition-all"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center text-[#2DD4BF] shrink-0 mt-0.5">
                          <Icon size={16} />
                        </div>

                        <div className="space-y-0.5">
                          <h5 className="text-xs font-bold text-[#0F0F14]">{item.title}</h5>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#777]">
                            {startTime && (
                              <span className="inline-flex items-center gap-1 font-medium text-[#0F0F14]">
                                <Clock size={11} className="text-[#2DD4BF]" />
                                {startTime} {endTime ? `– ${endTime}` : ""}
                              </span>
                            )}
                            {item.location && (
                              <span className="inline-flex items-center gap-1 text-[#666]">
                                <MapPin size={11} className="text-[#888]" />
                                {item.location}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={googleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Add to Google Calendar"
                          className="p-1 text-[#AAA] hover:text-[#2DD4BF] transition-colors"
                        >
                          <ExternalLink size={13} />
                        </a>
                        <button
                          type="button"
                          onClick={() => onEditItem(item)}
                          aria-label="Edit item"
                          className="p-1 text-[#AAA] hover:text-[#0F0F14] transition-colors"
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteItem(item.id)}
                          aria-label="Delete item"
                          className="p-1 text-[#AAA] hover:text-red-600 transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {/* Optional reminder badge */}
                    {typeof item.reminderMinutesBefore === "number" &&
                      item.reminderMinutesBefore > 0 && (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-800 border border-amber-200/60 text-[10px] font-semibold">
                          <Bell size={11} className="text-amber-600" />
                          <span>
                            Reminder:{" "}
                            {item.reminderMinutesBefore >= 1440
                              ? `${Math.round(item.reminderMinutesBefore / 1440)} day(s) before`
                              : `${item.reminderMinutesBefore}m before`}
                          </span>
                        </div>
                      )}

                    {/* Linked trip expenses without copying financial data */}
                    {linkedExpenses.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        {linkedExpenses.map((exp) => (
                          <div
                            key={exp.id}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#F6F6F6] border border-[#EBEBEB] text-[11px] text-[#555]"
                          >
                            <Receipt size={11} className="text-[#2DD4BF]" />
                            <span>
                              <strong className="text-[#0F0F14]">{exp.title}</strong> (
                              {exp.totalAmount} {exp.currency})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Description / Notes */}
                    {item.description && (
                      <p className="text-xs text-[#666] bg-[#FAFAFA] p-2.5 rounded-xl border border-[#EBEBEB]">
                        {item.description}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
