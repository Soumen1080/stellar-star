"use client";

import React, { useState } from "react";
import { Calendar, Clock, MapPin, Tag, Bell, Link as LinkIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { Expense } from "@/types/expense";
import type { ItineraryCategory, ItineraryItem } from "@/types/workspace";

interface ItineraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (item: Omit<ItineraryItem, "id" | "tripId" | "createdAt">) => Promise<void>;
  expenses: Expense[];
  initialItem?: ItineraryItem | null;
}

const CATEGORIES: { label: string; value: ItineraryCategory }[] = [
  { label: "Activity / Sightseeing", value: "activity" },
  { label: "Flight / Air Travel", value: "flight" },
  { label: "Lodging / Hotel", value: "lodging" },
  { label: "Transit / Transport", value: "transit" },
  { label: "Food & Dining", value: "food" },
  { label: "Meeting / Event", value: "meeting" },
  { label: "Other", value: "other" },
];

const REMINDER_OPTIONS = [
  { label: "No reminder", value: 0 },
  { label: "15 minutes before", value: 15 },
  { label: "30 minutes before", value: 30 },
  { label: "1 hour before", value: 60 },
  { label: "2 hours before", value: 120 },
  { label: "1 day before", value: 1440 },
];

export function ItineraryModal({
  isOpen,
  onClose,
  onSave,
  expenses,
  initialItem,
}: ItineraryModalProps) {
  const [title, setTitle] = useState(initialItem?.title ?? "");
  const [description, setDescription] = useState(initialItem?.description ?? "");
  const [location, setLocation] = useState(initialItem?.location ?? "");
  const [startDate, setStartDate] = useState(
    initialItem?.startDate ?? new Date().toISOString().slice(0, 16)
  );
  const [endDate, setEndDate] = useState(initialItem?.endDate ?? "");
  const [category, setCategory] = useState<ItineraryCategory>(
    initialItem?.category ?? "activity"
  );
  const [reminder, setReminder] = useState<number>(
    initialItem?.reminderMinutesBefore ?? 0
  );
  const [selectedExpenseId, setSelectedExpenseId] = useState<string>(
    initialItem?.linkedExpenseIds?.[0] ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Please enter a title for this itinerary item.");
      return;
    }
    if (!startDate) {
      setError("Please choose a start date.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        startDate,
        endDate: endDate ? endDate : undefined,
        category,
        reminderMinutesBefore: reminder > 0 ? reminder : null,
        linkedExpenseIds: selectedExpenseId ? [selectedExpenseId] : [],
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save itinerary item.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={initialItem ? "Edit Itinerary Item" : "Add Itinerary Item"}
      description="Schedule dated events, flights, activities, and link related trip expenses."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        {error && (
          <div className="p-3 bg-red-50 text-red-700 text-xs rounded-xl border border-red-200">
            {error}
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-[#555] mb-1">
            Event / Activity Title *
          </label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Flight to Tokyo, Hotel Check-in, Team Dinner"
            className="w-full px-3 py-2 text-sm bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none focus:ring-1 focus:ring-[#2DD4BF]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
              <Calendar size={12} />
              Start Date & Time *
            </label>
            <input
              type="datetime-local"
              required
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            />
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
              <Clock size={12} />
              End Date & Time (Optional)
            </label>
            <input
              type="datetime-local"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
              <Tag size={12} />
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ItineraryCategory)}
              className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
              <Bell size={12} />
              Optional Reminder
            </label>
            <select
              value={reminder}
              onChange={(e) => setReminder(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            >
              {REMINDER_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
            <MapPin size={12} />
            Location
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. Haneda Airport (HND), Shibuya Sky"
            className="w-full px-3 py-2 text-sm bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          />
        </div>

        {/* Link to related expense without copying financial data */}
        <div className="p-3 bg-[#F9F9F9] rounded-xl border border-[#EBEBEB]">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#0F0F14] mb-1">
            <LinkIcon size={12} className="text-[#2DD4BF]" />
            Link to Related Expense (Off-Chain Reference)
          </label>
          <p className="text-[11px] text-[#777] mb-2 leading-relaxed">
            Links directly to an existing trip expense by ID without copying or duplicating financial ledger data.
          </p>
          <select
            value={selectedExpenseId}
            onChange={(e) => setSelectedExpenseId(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          >
            <option value="">No linked expense</option>
            {expenses.map((exp) => (
              <option key={exp.id} value={exp.id}>
                {exp.title} ({exp.totalAmount} {exp.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#555] mb-1">
            Notes / Description
          </label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Additional details, confirmation notes, or instructions"
            className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          />
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
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-xs font-bold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition-all disabled:opacity-50 shadow-sm"
          >
            {saving ? "Saving…" : initialItem ? "Update Item" : "Add to Itinerary"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
