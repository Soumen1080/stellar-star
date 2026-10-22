"use client";

import React, { useState } from "react";
import {
  Lock,
  ExternalLink,
  Paperclip,
  Trash2,
  Edit2,
  Copy,
  Check,
  ShieldAlert,
  Plus,
  Plane,
  Building,
  Car,
  Train,
  Ticket,
  FileQuestion,
  Receipt,
} from "lucide-react";
import type { Expense, Member } from "@/types/expense";
import {
  canViewBookingDetails,
  type BookingReference,
  type BookingType,
} from "@/types/workspace";

interface BookingReferencesPanelProps {
  bookings: BookingReference[];
  expenses: Expense[];
  members: Member[];
  currentUserWallet?: string | null;
  tripCreatedByWallet?: string;
  onOpenAddModal: () => void;
  onEditBooking: (booking: BookingReference) => void;
  onDeleteBooking: (bookingId: string) => Promise<void>;
}

const TYPE_ICONS: Record<BookingType, React.ComponentType<any>> = {
  flight: Plane,
  hotel: Building,
  rental: Car,
  train: Train,
  ticket: Ticket,
  other: FileQuestion,
};

export function BookingReferencesPanel({
  bookings,
  expenses,
  members,
  currentUserWallet,
  tripCreatedByWallet,
  onOpenAddModal,
  onEditBooking,
  onDeleteBooking,
}: BookingReferencesPanelProps) {
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  const currentMember = members.find(
    (m) =>
      m.walletAddress &&
      currentUserWallet &&
      m.walletAddress.toLowerCase() === currentUserWallet.toLowerCase()
  );
  const isTripCreator = Boolean(
    currentUserWallet &&
      tripCreatedByWallet &&
      currentUserWallet.toLowerCase() === tripCreatedByWallet.toLowerCase()
  );

  const handleCopyCode = (id: string, code?: string) => {
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 1500);
  };

  return (
    <div className="space-y-4">
      {/* Top Banner & Add Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-white rounded-2xl border border-[#EBEBEB] shadow-sm">
        <div>
          <h3 className="text-xs font-bold text-[#0F0F14]">Booking References & Passes</h3>
          <p className="text-[11px] text-[#777] leading-relaxed">
            Store tickets, reservation codes, and documents. Private booking details are kept strictly off-chain.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenAddModal}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition-all shadow-sm shrink-0"
        >
          <Plus size={13} />
          Add Booking
        </button>
      </div>

      {/* Bookings List */}
      <div className="space-y-3">
        {bookings.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-[#DDD] text-[#888] text-xs">
            No booking references yet. Add flight tickets, hotel reservations, or event passes.
          </div>
        ) : (
          bookings.map((booking) => {
            const hasAccess = canViewBookingDetails(
              booking,
              currentUserWallet,
              currentMember?.id,
              isTripCreator
            );
            const Icon = TYPE_ICONS[booking.bookingType] || FileQuestion;
            const linkedExpense = booking.linkedExpenseId
              ? expenses.find((e) => e.id === booking.linkedExpenseId)
              : null;

            return (
              <div
                key={booking.id}
                className="p-4 bg-white rounded-2xl border border-[#EBEBEB] space-y-3 shadow-sm hover:border-[#DDD] transition-all"
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center text-[#2DD4BF] shrink-0">
                      <Icon size={16} />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-[#0F0F14]">{booking.title}</h4>
                      <span className="text-[10px] uppercase font-semibold text-[#888] tracking-wider">
                        {booking.bookingType} • {booking.permission.replace("_", " ")}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    {hasAccess && (
                      <button
                        type="button"
                        onClick={() => onEditBooking(booking)}
                        aria-label="Edit booking"
                        className="p-1 text-[#AAA] hover:text-[#0F0F14] transition-colors"
                      >
                        <Edit2 size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteBooking(booking.id)}
                      aria-label="Delete booking"
                      className="p-1 text-[#AAA] hover:text-red-600 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* Restricted View Notice */}
                {!hasAccess ? (
                  <div className="flex items-center gap-2 p-3 bg-[#F9F9F9] rounded-xl border border-[#EBEBEB] text-xs text-[#888]">
                    <Lock size={14} className="text-[#AAA] shrink-0" />
                    <span>
                      Restricted Access: Confirmation details are only visible to authorized members.
                    </span>
                  </div>
                ) : (
                  /* Permitted Content */
                  <div className="space-y-2.5 pt-1">
                    {/* Confirmation Code */}
                    {booking.confirmationCode && (
                      <div className="flex items-center justify-between p-2.5 bg-[#F6F6F6] rounded-xl">
                        <div className="space-y-0.5">
                          <span className="block text-[10px] uppercase font-bold text-[#888]">
                            Confirmation Code
                          </span>
                          <span className="font-mono text-xs font-bold text-[#0F0F14] tracking-wider">
                            {booking.confirmationCode}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleCopyCode(booking.id, booking.confirmationCode)}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-lg bg-white border border-[#DDD] text-[#555] hover:text-[#0F0F14]"
                        >
                          {copiedCodeId === booking.id ? (
                            <>
                              <Check size={12} className="text-emerald-600" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy size={12} />
                              Copy
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Booking Link & Attachment */}
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {booking.referenceUrl && (
                        <a
                          href={booking.referenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-[#DDD] text-[#0F0F14] font-medium hover:bg-[#F6F6F6] transition-colors"
                        >
                          <ExternalLink size={12} className="text-[#2DD4BF]" />
                          Open Booking Portal
                        </a>
                      )}

                      {booking.fileAttachment?.dataUrl && (
                        <a
                          href={booking.fileAttachment.dataUrl}
                          download={booking.fileAttachment.name}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-[#DDD] text-[#0F0F14] font-medium hover:bg-[#F6F6F6] transition-colors"
                        >
                          <Paperclip size={12} className="text-[#2DD4BF]" />
                          Download {booking.fileAttachment.name}
                        </a>
                      )}
                    </div>

                    {/* Linked Expense without copying financial data */}
                    {linkedExpense && (
                      <div className="flex items-center gap-2 pt-1 text-xs text-[#555]">
                        <Receipt size={13} className="text-[#2DD4BF]" />
                        <span>
                          Linked Expense:{" "}
                          <strong className="text-[#0F0F14]">{linkedExpense.title}</strong> (
                          {linkedExpense.totalAmount} {linkedExpense.currency})
                        </span>
                      </div>
                    )}

                    {/* Notes */}
                    {booking.notes && (
                      <p className="text-xs text-[#666] bg-[#FAFAFA] p-2.5 rounded-xl border border-[#EBEBEB]">
                        {booking.notes}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
