"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import type { Metadata } from "next";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SettlementSummary } from "@/components/trips/SettlementSummary"; import { TripDetailHeader } from "@/components/trips/TripDetailHeader";
import { TripDetailNav } from "@/components/trips/TripDetailNav"; import { TripExpensesPanel } from "@/components/trips/TripExpensesPanel";
import { TripNotFound } from "@/components/trips/TripNotFound"; import { TripPaymentProgressBanner } from "@/components/trips/TripPaymentProgressBanner";
import { TripRecurringRules } from "@/components/trips/TripRecurringRules"; import { TripWalletChangeBanner } from "@/components/trips/TripWalletChangeBanner";
import { TripTabs, type TripTab } from "@/components/trips/TripTabs"; import { RecurringPanel } from "@/components/recurring/RecurringPanel";
import { TravelWorkspacePanel } from "@/components/trips/workspace/TravelWorkspacePanel"; import { InviteMemberModal } from "@/components/trips/InviteMemberModal";
import { SaveTripTemplateForm } from "@/components/trips/SaveTripTemplateForm"; import { DuplicateTripFlow } from "@/components/trips/TripCopyFlow";
import { TripExportMenu } from "@/components/export/TripExportMenu"; import { ReminderSchedulePanel } from "@/components/reminders/ReminderSchedulePanel";
import { HouseholdCoordinationPanel } from "@/components/household/HouseholdCoordinationPanel"; import { useAuth } from "@/context/AuthContext";
import { useContractEvents } from "@/hooks/useContractEvents"; import { useExpense } from "@/hooks/useExpense";
import { useTrip } from "@/hooks/useTrip"; import { useTripAutoSettlement } from "@/hooks/useTripAutoSettlement";
import { useWallet } from "@/hooks/useWallet";
import { Spinner } from "@/components/ui/Spinner";
import { sanitizeMetadata, sanitizeText, sanitizeWalletLabel } from "@/lib/utils";
import { memberHasPermission, memberRole } from "@/lib/trip/roles";
import type { RecurringExpenseRule } from "@/types/trip";

/**
 * Builds safe page metadata and enforces a content security policy for trip details,
 * ensuring trip names, wallet labels, and IDs are sanitized to prevent stored or reflected XSS.
 */
export function generateTripMetadata({ tripName, walletAddress, tripId }: { tripName?: string; walletAddress?: string; tripId?: string }): Metadata {
  const safeId = sanitizeMetadata(tripId ?? "", 50);
  const safeName = tripName ? sanitizeMetadata(tripName, 100) : "";
  const safeWallet = walletAddress ? sanitizeWalletLabel(walletAddress, 60) : "";
  let title = "Trip Details | Stellar Star";
  if (safeName && safeWallet) title = `${safeName} (by ${safeWallet}) | Stellar Star`;
  else if (safeName) title = `${safeName} | Stellar Star`;
  else if (safeId) title = `Trip ${safeId} | Stellar Star`;
  const description = safeName ? `View and settle expenses for ${safeName} on Stellar Star.` : safeId ? `View details and expenses for trip ${safeId} on Stellar Star.` : "Group expense splitting on the Stellar blockchain.";
  return { title, description, openGraph: { title, description } };
}

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const safeId = sanitizeText(params?.id ?? "");
  const { trips, getTrip, settleTrip, addExpenseToTrip, updateTrip, isLoading, refresh } = useTrip();
  const { expenses } = useExpense();
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TripTab>("expenses");
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [showDuplicate, setShowDuplicate] = useState(false);
  // The recurring rule the expense form is pre-filled from, if any.
  const [ruleForExpense, setRuleForExpense] = useState<RecurringExpenseRule | null>(null);
  const { error: toastError } = useToast();

  const trip = getTrip(safeId);

  // Safely update document title in client runtime using sanitized metadata
  useEffect(() => {
    if (trip?.name) {
      document.title = `${sanitizeMetadata(trip.name)} | Stellar Star`;
    } else if (safeId) {
      document.title = `Trip ${sanitizeMetadata(safeId)} | Stellar Star`;
    }
  }, [trip?.name, safeId]);

  // The expense itself saved successfully; only the link to this trip failed.
  // Say so plainly rather than letting the promise reject unhandled.
  const linkExpenseToTrip = (tripId: string, expenseId: string) => {
    void addExpenseToTrip(tripId, expenseId).catch((err: any) => {
      toastError(
        "Expense saved, but not added to this trip",
        sanitizeText(err?.message || "Reload the page and add it to the trip again.")
      );
    });
  };
  const tripExpenses = trip ? expenses.filter((expense) => trip.expenseIds.includes(expense.id)) : [];
  const myShares = tripExpenses.flatMap((expense) =>
    expense.shares.filter((share) => share.walletAddress === publicKey)
  );
  const isTripSettled = trip?.settled ?? false;
  const { events: onChainEvents } = useContractEvents(trip?.id, tripExpenses, {
    isActive: trip ? !isTripSettled : false,
    isSettled: isTripSettled,
  });

  useTripAutoSettlement(trip, expenses, settleTrip);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
        <Spinner size={32} className="text-[#2DD4BF]" />
      </div>
    );
  }

  if (!trip) {
    return <TripNotFound />;
  }

  const callerMember = trip.members.find(
    (member) => member.walletAddress?.trim().toUpperCase() === publicKey?.trim().toUpperCase(),
  );
  const callerRole = callerMember ? memberRole(callerMember, trip) : null;
  const isOwner = callerRole === "owner";
  const canAddExpenses = isOwner || Boolean(
    callerMember &&
    memberHasPermission(callerMember, "expenses.manage", trip) &&
    trip.permissions?.membersCanAddExpenses !== false,
  );
  const canInvite = Boolean(
    callerMember &&
    memberHasPermission(callerMember, "members.manage", trip) &&
    (callerRole === "owner" || callerRole === "organizer" || trip.permissions?.membersCanInvite !== false),
  );
  const canExport = isOwner || Boolean(
    callerMember && memberHasPermission(callerMember, "exports.view", trip),
  );
  const canManageReminders = isOwner || Boolean(
    callerMember && memberHasPermission(callerMember, "reminders.manage", trip),
  );
  const openExpenseForm = (rule: RecurringExpenseRule | null) => {
    setRuleForExpense(rule);
    setShowExpenseForm(true);
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        <TripDetailNav tripName={sanitizeText(trip.name)} />

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          <TripDetailHeader
            trip={trip}
            expenses={tripExpenses}
            currentWallet={publicKey}
            onRoleChanged={refresh}
            onOpenInvite={canInvite ? () => setShowInviteModal(true) : undefined}
            onSaveTemplate={() => setShowSaveTemplate(true)}
            onDuplicate={() => setShowDuplicate(true)}
          />
          <TripRecurringRules
            rules={trip.recurringRules ?? []}
            members={trip.members}
            onAddFromRule={canAddExpenses ? openExpenseForm : undefined}
          />
          {!trip.settled && <TripWalletChangeBanner tripId={trip.id} />}
          {publicKey && <TripPaymentProgressBanner shares={myShares} />}
          {canExport && <TripExportMenu trip={trip} expenses={tripExpenses} />}
          {publicKey && canManageReminders && <ReminderSchedulePanel tripId={trip.id} />}
          <TripTabs activeTab={activeTab} onChange={setActiveTab} />

          <AnimatePresence mode="wait">
            {activeTab === "expenses" ? (
              <TripExpensesPanel
                expenses={tripExpenses}
                tripId={trip.id}
                members={trip.members}
                currentUserPublicKey={publicKey}
                onAddExpense={canAddExpenses ? () => openExpenseForm(null) : undefined}
              />
            ) : activeTab === "workspace" ? (
              <motion.div key="workspace" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                <TravelWorkspacePanel trip={trip} expenses={tripExpenses} currentUserPublicKey={publicKey} />
              </motion.div>
            ) : activeTab === "recurring" ? (
              <motion.div key="recurring" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}>
                <RecurringPanel
                  tripId={trip.id}
                  members={trip.members}
                  currentUserPublicKey={publicKey}
                  currentUserName={user?.displayName}
                  onExpenseCreated={(expenseId) => linkExpenseToTrip(trip.id, expenseId)}
                />
              </motion.div>
            ) : activeTab === "chores" ? (
              <motion.div
                key="chores"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <HouseholdCoordinationPanel
                  trip={trip}
                  expenses={tripExpenses}
                  currentWallet={publicKey}
                  isOwner={isOwner}
                  onToggleModule={async (enabled) => {
                    await updateTrip(trip.id, { householdCoordinationEnabled: enabled });
                  }}
                />
              </motion.div>
            ) : (
              <motion.div
                key="settle"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <SettlementSummary trip={trip} expenses={tripExpenses} onChainEvents={onChainEvents} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      <Modal
        open={showExpenseForm}
        onClose={() => setShowExpenseForm(false)}
        title="Add Expense"
        description={`Add an expense to "${sanitizeText(trip.name)}"`}
        size="lg"
      >
        <ExpenseForm
          key={ruleForExpense?.id ?? "blank"}
          currentUserPublicKey={publicKey}
          currentUserName={user?.displayName}
          defaultMembers={trip.members}
          initialValues={
            ruleForExpense
              ? {
                  title: ruleForExpense.title,
                  totalAmount: ruleForExpense.amount,
                  splitMode: ruleForExpense.splitMode,
                  paidByMemberId: ruleForExpense.paidByMemberId,
                }
              : undefined
          }
          onSuccess={(newExpenseId?: string) => {
            if (newExpenseId) linkExpenseToTrip(trip.id, newExpenseId);
            setShowExpenseForm(false);
          }}
          onCancel={() => setShowExpenseForm(false)}
        />
      </Modal>

      <InviteMemberModal
        trip={trip}
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
      />

      <Modal
        open={showSaveTemplate}
        onClose={() => setShowSaveTemplate(false)}
        title="Save as template"
        description="Reuse this group's members, recurring expenses and permissions."
        size="lg"
      >
        <SaveTripTemplateForm
          trip={trip}
          onSaved={() => setShowSaveTemplate(false)}
          onCancel={() => setShowSaveTemplate(false)}
        />
      </Modal>

      <Modal
        open={showDuplicate}
        onClose={() => setShowDuplicate(false)}
        title="Duplicate trip"
        description="Review and edit everything before the new trip is created."
        size="lg"
      >
        <DuplicateTripFlow
          trips={trips}
          initialTripId={trip.id}
          currentUserPublicKey={publicKey}
          currentUserName={user?.displayName}
          onDone={() => setShowDuplicate(false)}
          onCancel={() => setShowDuplicate(false)}
        />
      </Modal>
    </AuthGuard>
  );
}
