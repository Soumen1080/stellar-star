"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, ArrowLeft, Map, Inbox } from "lucide-react";
import { useTrip } from "@/hooks/useTrip";
import { useExpense } from "@/hooks/useExpense";
import { useWallet } from "@/hooks/useWallet";
import { useAuth } from "@/context/AuthContext";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Modal } from "@/components/ui/Modal";
import { TripCard } from "@/components/trips/TripCard";
import { TripForm } from "@/components/trips/TripForm";
import { useToast } from "@/components/ui/Toast";
import type { TripFormData, Trip } from "@/types/trip";

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-16 px-4 text-center"
    >
      <div className="w-16 h-16 rounded-2xl bg-[#F0F0F0] flex items-center justify-center mb-5">
        <Inbox size={24} className="text-[#CCC]" />
      </div>
      <h3 className="text-base font-bold text-[#0F0F14] mb-1">No trips yet</h3>
      <p className="text-sm text-[#AAA] mb-6 max-w-xs">
        Create a trip to group expenses, track who owes what, and settle up with
        one click.
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
      >
        <Plus size={15} />
        New Trip
      </button>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripsPage() {
  const { trips, addTrip, deleteTrip } = useTrip();
  const { expenses } = useExpense();
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleCreate = async (data: TripFormData) => {
    const trip: Trip = {
      id: crypto.randomUUID(),
      name: data.name,
      description: data.description || undefined,
      members: data.members,
      expenseIds: [],
      createdAt: new Date().toISOString(),
      settled: false,
    };
    setCreating(true);
    try {
      await addTrip(trip);
      toastSuccess("Trip created!", `"${trip.name}" is ready.`);
      setShowForm(false);
    } catch (err: any) {
      const msg: string = err?.message || "";
      if (msg.includes("fetch") || msg.includes("network") || msg.includes("Network")) {
        toastError("No connection", "Cannot reach server. Check your connection (WARP on?).");
      } else if (msg.includes("policy") || msg.includes("permission")) {
        toastError("Save failed", "Database permission error. Please try again.");
      } else {
        toastError("Save failed", msg || "Could not save trip. Please try again.");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        {/* Nav */}
        <nav className="sticky top-0 z-40 flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-white/90 backdrop-blur-xl">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 text-sm text-[#888] hover:text-[#0F0F14] transition-colors shrink-0"
            >
              <ArrowLeft size={14} />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <span className="text-[#E5E5E5] hidden sm:inline">/</span>
            <span className="text-sm font-bold text-[#0F0F14] truncate">Trips</span>
          </div>
          <ConnectWalletButton className="shrink-0" />
        </nav>

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 mb-6">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Map size={16} className="text-[#2DD4BF]" />
                <h1 className="text-xl font-black text-[#0F0F14]">Trips</h1>
              </div>
              <p className="text-sm text-[#888]">
                {trips.length === 0
                  ? "Group your expenses by trip"
                  : `${trips.length} trip${trips.length !== 1 ? "s" : ""}`}
              </p>
            </div>

            {trips.length > 0 && (
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all shrink-0"
              >
                <Plus size={14} />
                New
              </button>
            )}
          </div>

          {/* List or empty */}
          {trips.length === 0 ? (
            <EmptyState onNew={() => setShowForm(true)} />
          ) : (
            <div className="space-y-3">
              <AnimatePresence mode="popLayout">
                {trips.map((trip, i) => {
                  const tripExpenses = expenses.filter((e) =>
                    trip.expenseIds.includes(e.id)
                  );
                  const totalXLM = tripExpenses.reduce(
                    (sum, e) => sum + parseFloat(e.totalAmount),
                    0
                  );
                  return (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      expenseCount={tripExpenses.length}
                      totalXLM={totalXLM}
                      onDelete={deleteTrip}
                      index={i}
                    />
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </main>
      </div>

      {/* New Trip modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="New Trip"
        description="Group expenses and settle up as a team."
        size="lg"
      >
        <TripForm
          currentUserPublicKey={publicKey}
          currentUserName={user?.displayName}
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
        />
      </Modal>
    </AuthGuard>
  );
}
