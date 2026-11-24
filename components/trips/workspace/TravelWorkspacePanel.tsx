"use client";

import React, { useState } from "react";
import {
  Calendar,
  CheckSquare,
  Ticket,
  Shield,
  Download,
  Luggage,
} from "lucide-react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import type { BookingReference, ItineraryItem } from "@/types/workspace";
import { useWorkspace } from "@/hooks/useWorkspace";
import { ItineraryList } from "./ItineraryList";
import { ChecklistPanel } from "./ChecklistPanel";
import { BookingReferencesPanel } from "./BookingReferencesPanel";
import { ItineraryModal } from "./ItineraryModal";
import { BookingModal } from "./BookingModal";
import { CalendarExportModal } from "./CalendarExportModal";
import { WorkspacePrivacyModal } from "./WorkspacePrivacyModal";
import { ChorePanel } from "./ChorePanel";
import { memberRole } from "@/lib/trip/roles";

interface TravelWorkspacePanelProps {
  trip: Trip;
  expenses: Expense[];
  currentUserPublicKey?: string | null;
}

type WorkspaceSubTab = "itinerary" | "checklist" | "chores" | "bookings";

export function TravelWorkspacePanel({
  trip,
  expenses,
  currentUserPublicKey,
}: TravelWorkspacePanelProps) {
  const {
    workspace,
    addItineraryItem,
    updateItineraryItem,
    deleteItineraryItem,
    addChecklistItem,
    toggleChecklistItem,
    updateChecklistItem,
    deleteChecklistItem,
    addChore,
    completeChore,
    toggleChoreOptOut,
    setChoresEnabled,
    addBookingReference,
    updateBookingReference,
    deleteBookingReference,
    purgeWorkspace,
  } = useWorkspace(trip);

  const [subTab, setSubTab] = useState<WorkspaceSubTab>("itinerary");

  // Modals state
  const [showItineraryModal, setShowItineraryModal] = useState(false);
  const [editingItineraryItem, setEditingItineraryItem] = useState<ItineraryItem | null>(null);

  const [showBookingModal, setShowBookingModal] = useState(false);
  const [editingBooking, setEditingBooking] = useState<BookingReference | null>(null);

  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  const completedChecklistCount = workspace.checklists.filter((c) => c.isCompleted).length;
  const currentMember = trip.members.find(
    (member) => member.walletAddress?.trim().toUpperCase() === currentUserPublicKey?.trim().toUpperCase(),
  );
  const isOwner = Boolean(currentMember && memberRole(currentMember, trip) === "owner");
  const optedOut = Boolean(
    currentUserPublicKey &&
    workspace.choreOptOutWallets.includes(currentUserPublicKey.trim().toUpperCase()),
  );
  const optedOutMemberIds = trip.members
    .filter((member) =>
      member.walletAddress &&
      workspace.choreOptOutWallets.includes(member.walletAddress.trim().toUpperCase())
    )
    .map((member) => member.id);

  return (
    <div className="space-y-5">
      {/* Workspace Header Card */}
      <div className="p-4 bg-white rounded-2xl border border-[#EBEBEB] space-y-3 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center text-[#2DD4BF]">
              <Luggage size={18} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-[#0F0F14]">Shared Travel Workspace</h2>
              <p className="text-xs text-[#777]">
                Itinerary, packing checklist, and permission-controlled bookings (strictly off-chain).
              </p>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCalendarModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-[#DDD] bg-white text-xs font-semibold text-[#555] hover:text-[#0F0F14] hover:bg-[#F6F6F6] transition-colors"
            >
              <Download size={13} className="text-[#2DD4BF]" />
              Export Calendar (.ics)
            </button>

            <button
              type="button"
              onClick={() => setShowPrivacyModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 transition-colors"
            >
              <Shield size={13} className="text-emerald-600" />
              Privacy & Data Policy
            </button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-2 pt-1 border-t border-[#F0F0F0] text-center">
          <div className="p-2 rounded-xl bg-[#F9F9F9]">
            <span className="block text-xs font-bold text-[#0F0F14]">
              {workspace.itinerary.length}
            </span>
            <span className="text-[10px] text-[#777]">Itinerary Events</span>
          </div>
          <div className="p-2 rounded-xl bg-[#F9F9F9]">
            <span className="block text-xs font-bold text-[#0F0F14]">
              {completedChecklistCount}/{workspace.checklists.length}
            </span>
            <span className="text-[10px] text-[#777]">Tasks Done</span>
          </div>
          <div className="p-2 rounded-xl bg-[#F9F9F9]">
            <span className="block text-xs font-bold text-[#0F0F14]">
              {workspace.bookings.length}
            </span>
            <span className="text-[10px] text-[#777]">Bookings & Passes</span>
          </div>
          <div className="p-2 rounded-xl bg-[#F9F9F9]">
            <span className="block text-xs font-bold text-[#0F0F14]">
              {workspace.chores.length}
            </span>
            <span className="text-[10px] text-[#777]">Recurring Chores</span>
          </div>
        </div>
      </div>

      {/* Sub-tab switcher */}
      <div className="flex gap-1 p-1 bg-[#EBEBEB] rounded-xl">
        <button
          type="button"
          onClick={() => setSubTab("itinerary")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            subTab === "itinerary"
              ? "bg-white text-[#0F0F14] shadow-sm"
              : "text-[#777] hover:text-[#0F0F14]"
          }`}
        >
          <Calendar size={13} />
          Itinerary ({workspace.itinerary.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("checklist")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            subTab === "checklist"
              ? "bg-white text-[#0F0F14] shadow-sm"
              : "text-[#777] hover:text-[#0F0F14]"
          }`}
        >
          <CheckSquare size={13} />
          Packing & Tasks ({workspace.checklists.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("bookings")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            subTab === "bookings"
              ? "bg-white text-[#0F0F14] shadow-sm"
              : "text-[#777] hover:text-[#0F0F14]"
          }`}
        >
          <Ticket size={13} />
          Bookings & Files ({workspace.bookings.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("chores")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
            subTab === "chores"
              ? "bg-white text-[#0F0F14] shadow-sm"
              : "text-[#777] hover:text-[#0F0F14]"
          }`}
        >
          <CheckSquare size={13} />
          Chores ({workspace.chores.length})
        </button>
      </div>

      {/* Active Tab Content */}
      {subTab === "itinerary" && (
        <ItineraryList
          itinerary={workspace.itinerary}
          expenses={expenses}
          onOpenAddModal={() => {
            setEditingItineraryItem(null);
            setShowItineraryModal(true);
          }}
          onEditItem={(item) => {
            setEditingItineraryItem(item);
            setShowItineraryModal(true);
          }}
          onDeleteItem={deleteItineraryItem}
        />
      )}

      {subTab === "checklist" && (
        <ChecklistPanel
          checklists={workspace.checklists}
          members={trip.members}
          currentUserWallet={currentUserPublicKey}
          onAddItem={addChecklistItem}
          onToggleItem={toggleChecklistItem}
          onDeleteItem={deleteChecklistItem}
          onUpdateItem={updateChecklistItem}
        />
      )}

      {subTab === "bookings" && (
        <BookingReferencesPanel
          bookings={workspace.bookings}
          expenses={expenses}
          members={trip.members}
          currentUserWallet={currentUserPublicKey}
          tripCreatedByWallet={trip.createdByWallet}
          onOpenAddModal={() => {
            setEditingBooking(null);
            setShowBookingModal(true);
          }}
          onEditBooking={(booking) => {
            setEditingBooking(booking);
            setShowBookingModal(true);
          }}
          onDeleteBooking={deleteBookingReference}
        />
      )}

      {subTab === "chores" && (
        <ChorePanel
          chores={workspace.chores}
          enabled={workspace.choresEnabled}
          optedOut={optedOut}
          optedOutMemberIds={optedOutMemberIds}
          isOwner={isOwner}
          members={trip.members}
          expenses={expenses}
          currentUserWallet={currentMember ? currentUserPublicKey : null}
          onAdd={addChore}
          onComplete={completeChore}
          onToggleOptOut={toggleChoreOptOut}
          onSetEnabled={setChoresEnabled}
        />
      )}

      {/* Modals */}
      {showItineraryModal && (
        <ItineraryModal
          isOpen={showItineraryModal}
          onClose={() => setShowItineraryModal(false)}
          onSave={async (item) => {
            if (editingItineraryItem) {
              await updateItineraryItem(editingItineraryItem.id, item);
            } else {
              await addItineraryItem(item);
            }
          }}
          expenses={expenses}
          initialItem={editingItineraryItem}
        />
      )}

      {showBookingModal && (
        <BookingModal
          isOpen={showBookingModal}
          onClose={() => setShowBookingModal(false)}
          onSave={async (booking) => {
            if (editingBooking) {
              await updateBookingReference(editingBooking.id, booking);
            } else {
              await addBookingReference(booking);
            }
          }}
          members={trip.members}
          expenses={expenses}
          currentUserWallet={currentUserPublicKey}
          initialBooking={editingBooking}
        />
      )}

      {showCalendarModal && (
        <CalendarExportModal
          isOpen={showCalendarModal}
          onClose={() => setShowCalendarModal(false)}
          trip={trip}
          itinerary={workspace.itinerary}
        />
      )}

      {showPrivacyModal && (
        <WorkspacePrivacyModal
          isOpen={showPrivacyModal}
          onClose={() => setShowPrivacyModal(false)}
          trip={trip}
          workspace={workspace}
          currentUserWallet={currentUserPublicKey}
          onPurgeWorkspace={purgeWorkspace}
        />
      )}
    </div>
  );
}
