"use client";

import React, { useState } from "react";
import { Lock, FileText, Globe, Paperclip, Link as LinkIcon, Shield } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { Expense, Member } from "@/types/expense";
import type {
  BookingPermission,
  BookingReference,
  BookingType,
  BookingAttachment,
} from "@/types/workspace";

interface BookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (booking: Omit<BookingReference, "id" | "tripId" | "createdAt">) => Promise<void>;
  members: Member[];
  expenses: Expense[];
  currentUserWallet?: string | null;
  initialBooking?: BookingReference | null;
}

const BOOKING_TYPES: { label: string; value: BookingType }[] = [
  { label: "Flight / Air Booking", value: "flight" },
  { label: "Hotel / Accommodation", value: "hotel" },
  { label: "Car Rental / Vehicle", value: "rental" },
  { label: "Train / Rail", value: "train" },
  { label: "Event Ticket / Pass", value: "ticket" },
  { label: "Other Booking", value: "other" },
];

export function BookingModal({
  isOpen,
  onClose,
  onSave,
  members,
  expenses,
  currentUserWallet,
  initialBooking,
}: BookingModalProps) {
  const [title, setTitle] = useState(initialBooking?.title ?? "");
  const [bookingType, setBookingType] = useState<BookingType>(
    initialBooking?.bookingType ?? "flight"
  );
  const [confirmationCode, setConfirmationCode] = useState(
    initialBooking?.confirmationCode ?? ""
  );
  const [referenceUrl, setReferenceUrl] = useState(
    initialBooking?.referenceUrl ?? ""
  );
  const [notes, setNotes] = useState(initialBooking?.notes ?? "");
  const [permission, setPermission] = useState<BookingPermission>(
    initialBooking?.permission ?? "all_members"
  );
  const [permittedMemberIds, setPermittedMemberIds] = useState<string[]>(
    initialBooking?.permittedMemberIds ?? []
  );
  const [selectedExpenseId, setSelectedExpenseId] = useState<string>(
    initialBooking?.linkedExpenseId ?? ""
  );
  const [attachment, setAttachment] = useState<BookingAttachment | null>(
    initialBooking?.fileAttachment ?? null
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setError("File is too large (max 2MB).");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAttachment({
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        dataUrl: reader.result as string,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleMemberToggle = (memberId: string) => {
    setPermittedMemberIds((prev) =>
      prev.includes(memberId)
        ? prev.filter((id) => id !== memberId)
        : [...prev, memberId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("Please provide a title for this booking reference.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: title.trim(),
        bookingType,
        confirmationCode: confirmationCode.trim() || undefined,
        referenceUrl: referenceUrl.trim() || undefined,
        notes: notes.trim() || undefined,
        permission,
        permittedMemberIds: permission === "permitted_members" ? permittedMemberIds : [],
        createdByWallet: initialBooking?.createdByWallet ?? currentUserWallet ?? "local-user",
        linkedExpenseId: selectedExpenseId || null,
        fileAttachment: attachment,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to save booking reference.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={initialBooking ? "Edit Booking Reference" : "Add Booking Reference"}
      description="Store private confirmation codes, tickets, and booking links with permission controls."
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        {error && (
          <div className="p-3 bg-red-50 text-red-700 text-xs rounded-xl border border-red-200">
            {error}
          </div>
        )}

        <div className="flex items-start gap-2 p-3 bg-emerald-50/80 border border-emerald-200/80 rounded-xl text-emerald-800 text-[11px] leading-relaxed">
          <Shield size={16} className="text-emerald-600 mt-0.5 shrink-0" />
          <span>
            <strong>Zero On-Chain Leakage:</strong> Confirmation codes, attachments, and URLs
            are stored strictly off-chain and will NEVER appear in public blockchain memos or contracts.
          </span>
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#555] mb-1">
            Booking / Reference Title *
          </label>
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. United Airlines UA456, Marriott Ginza"
            className="w-full px-3 py-2 text-sm bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-[#555] mb-1">
              Booking Type
            </label>
            <select
              value={bookingType}
              onChange={(e) => setBookingType(e.target.value as BookingType)}
              className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            >
              {BOOKING_TYPES.map((bt) => (
                <option key={bt.value} value={bt.value}>
                  {bt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
              <Lock size={12} />
              Confirmation / PNR Code
            </label>
            <input
              type="text"
              value={confirmationCode}
              onChange={(e) => setConfirmationCode(e.target.value)}
              placeholder="e.g. ABC123XYZ"
              className="w-full px-3 py-2 text-xs font-mono uppercase bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
            <Globe size={12} />
            Booking / Check-in URL
          </label>
          <input
            type="url"
            value={referenceUrl}
            onChange={(e) => setReferenceUrl(e.target.value)}
            placeholder="https://airline.com/manage-booking"
            className="w-full px-3 py-2 text-xs bg-white border border-[#DDD] rounded-xl focus:border-[#2DD4BF] focus:outline-none"
          />
        </div>

        {/* Permission control */}
        <div className="p-3 bg-[#F9F9F9] rounded-xl border border-[#EBEBEB] space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#0F0F14]">
            <Lock size={12} className="text-[#2DD4BF]" />
            Access Permission Controls
          </label>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <label className="flex items-center gap-1.5 p-2 bg-white rounded-lg border border-[#DDD] cursor-pointer">
              <input
                type="radio"
                name="permission"
                checked={permission === "all_members"}
                onChange={() => setPermission("all_members")}
                className="text-[#2DD4BF] focus:ring-[#2DD4BF]"
              />
              <span>All Members</span>
            </label>
            <label className="flex items-center gap-1.5 p-2 bg-white rounded-lg border border-[#DDD] cursor-pointer">
              <input
                type="radio"
                name="permission"
                checked={permission === "permitted_members"}
                onChange={() => setPermission("permitted_members")}
                className="text-[#2DD4BF] focus:ring-[#2DD4BF]"
              />
              <span>Specific Only</span>
            </label>
            <label className="flex items-center gap-1.5 p-2 bg-white rounded-lg border border-[#DDD] cursor-pointer">
              <input
                type="radio"
                name="permission"
                checked={permission === "creator_only"}
                onChange={() => setPermission("creator_only")}
                className="text-[#2DD4BF] focus:ring-[#2DD4BF]"
              />
              <span>Creator Only</span>
            </label>
          </div>

          {permission === "permitted_members" && (
            <div className="pt-2 border-t border-[#EBEBEB]">
              <span className="block text-[11px] font-semibold text-[#666] mb-1.5">
                Select Members Who Can View:
              </span>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <label
                    key={m.id}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border cursor-pointer ${
                      permittedMemberIds.includes(m.id)
                        ? "bg-[#2DD4BF]/10 border-[#2DD4BF] text-[#0F0F14] font-medium"
                        : "bg-white border-[#DDD] text-[#777]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={permittedMemberIds.includes(m.id)}
                      onChange={() => handleMemberToggle(m.id)}
                      className="sr-only"
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Link to related expense without copying financial data */}
        <div className="p-3 bg-[#F9F9F9] rounded-xl border border-[#EBEBEB]">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-[#0F0F14] mb-1">
            <LinkIcon size={12} className="text-[#2DD4BF]" />
            Link to Related Trip Expense
          </label>
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

        {/* File attachment */}
        <div>
          <label className="flex items-center gap-1 text-xs font-semibold text-[#555] mb-1">
            <Paperclip size={12} />
            File / Document Attachment (PDF, Ticket, Boarding Pass)
          </label>
          {attachment ? (
            <div className="flex items-center justify-between p-2.5 bg-white border border-[#DDD] rounded-xl text-xs">
              <span className="truncate max-w-[200px] font-medium text-[#0F0F14]">
                {attachment.name} ({Math.round(attachment.size / 1024)} KB)
              </span>
              <button
                type="button"
                onClick={() => setAttachment(null)}
                className="text-xs text-red-600 hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt"
              onChange={handleFileUpload}
              className="block w-full text-xs text-[#777] file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#EBEBEB] file:text-[#0F0F14] hover:file:bg-[#DDD] cursor-pointer"
            />
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-[#555] mb-1">
            Notes & Instructions
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Gate info, baggage allowances, check-in instructions..."
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
            {saving ? "Saving…" : initialBooking ? "Update Booking" : "Save Booking"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
