"use client";

import React, { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Users, CheckCircle2, AlertCircle, ArrowRight, ShieldCheck, Loader2, Sparkles } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useAccessToken } from "@/lib/supabase/useSession";
import { useToast } from "@/components/ui/Toast";
import type { TripInviteSummary } from "@/types/trip";

export default function JoinTripPage() {
  const params = useParams();
  const router = useRouter();
  const token = typeof params?.token === "string" ? params.token : "";

  const { isConnected, publicKey, connect } = useWallet();
  const sessionToken = useAccessToken();
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<TripInviteSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string>("");
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Invitation link is missing token.");
      setLoading(false);
      return;
    }

    async function fetchSummary() {
      try {
        setLoading(true);
        const res = await fetch(`/api/invitations/verify?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Failed to verify invitation.");
        }
        setSummary(data);
        if (data.memberId) {
          setSelectedMemberId(data.memberId);
        } else if (data.unclaimedMembers?.length > 0) {
          setSelectedMemberId(data.unclaimedMembers[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid invitation.");
      } finally {
        setLoading(false);
      }
    }

    fetchSummary();
  }, [token]);

  const handleClaim = async () => {
    if (!isConnected || !publicKey) {
      connect();
      return;
    }

    setClaiming(true);
    try {
      const res = await fetch("/api/invitations/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({
          token,
          selectedMemberId: selectedMemberId || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to claim invitation slot.");
      }

      toastSuccess(
        "Joined successfully!",
        `You have claimed the slot "${data.memberName}" for ${data.tripName}.`,
      );
      router.push(`/trips/${data.tripId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to join trip.";
      toastError("Join failed", message);
      setError(message);
    } finally {
      setClaiming(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-4">
        <Loader2 className="w-8 h-8 text-[#2DD4BF] animate-spin mb-3" />
        <p className="text-sm text-[#888]">Verifying invitation link...</p>
      </div>
    );
  }

  if (error || !summary) {
    return (
      <div className="max-w-md mx-auto my-12 p-6 bg-white rounded-2xl border border-[#EEEEEE] shadow-sm text-center">
        <div className="w-12 h-12 rounded-full bg-red-50 text-red-500 flex items-center justify-center mx-auto mb-4">
          <AlertCircle size={24} />
        </div>
        <h2 className="text-lg font-bold text-[#0F0F14] mb-2">Invitation Unavailable</h2>
        <p className="text-sm text-[#666] mb-6">
          {error || "This invitation link is invalid, expired, or has already been revoked."}
        </p>
        <button
          onClick={() => router.push("/trips")}
          className="w-full py-2.5 px-4 rounded-xl bg-[#0F0F14] text-white text-sm font-semibold hover:bg-[#222] transition-colors"
        >
          Go to Trips
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto my-8 p-6 bg-white rounded-2xl border border-[#EEEEEE] shadow-sm">
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-2xl bg-[#2DD4BF]/10 text-[#0F766E] flex items-center justify-center mx-auto mb-3">
          <Sparkles size={24} />
        </div>
        <h1 className="text-xl font-extrabold text-[#0F0F14]">Join Trip</h1>
        <p className="text-xs text-[#888] mt-1">You were invited to participate in a group expense trip</p>
      </div>

      <div className="p-4 bg-[#F8F9FA] rounded-xl border border-[#E9ECEF] mb-5">
        <h2 className="text-base font-bold text-[#0F0F14]">{summary.tripName}</h2>
        {summary.tripDescription && (
          <p className="text-xs text-[#666] mt-1">{summary.tripDescription}</p>
        )}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#E9ECEF] text-xs text-[#888]">
          <ShieldCheck size={14} className="text-[#2DD4BF]" />
          <span>Invited by <span className="font-mono text-[#333]">{summary.inviterWallet.slice(0, 6)}...{summary.inviterWallet.slice(-4)}</span></span>
        </div>
      </div>

      {summary.memberId ? (
        <div className="mb-6 p-3 bg-[#F0FDFA] border border-[#CCFBF1] rounded-xl text-xs text-[#0F766E]">
          <p className="font-semibold">Claiming slot: {summary.memberName}</p>
          <p className="text-[11px] text-[#115E59] mt-0.5">
            Connecting your wallet will link all existing shares and expenses assigned to {summary.memberName} to your Stellar address.
          </p>
        </div>
      ) : summary.unclaimedMembers.length > 0 ? (
        <div className="mb-6 space-y-2">
          <label className="block text-xs font-semibold text-[#444] uppercase tracking-wide">
            Select who you are in this trip:
          </label>
          <div className="space-y-1.5">
            {summary.unclaimedMembers.map((m) => (
              <label
                key={m.id}
                className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                  selectedMemberId === m.id
                    ? "border-[#2DD4BF] bg-[#F0FDFA] text-[#0F766E]"
                    : "border-[#E5E5E5] bg-white text-[#333] hover:bg-[#F9F9F9]"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="member_slot"
                    value={m.id}
                    checked={selectedMemberId === m.id}
                    onChange={() => setSelectedMemberId(m.id)}
                    className="accent-[#2DD4BF]"
                  />
                  <span className="text-sm font-semibold">{m.name}</span>
                </div>
                <span className="text-[11px] text-[#888]">Unclaimed slot</span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-6 p-3 bg-[#F8F9FA] rounded-xl border border-[#E9ECEF] text-xs text-[#666]">
          All placeholder slots have been claimed. You will join this trip as a new member.
        </div>
      )}

      <div className="space-y-3">
        {!isConnected ? (
          <button
            onClick={connect}
            className="w-full py-3 px-4 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold flex items-center justify-center gap-2 hover:bg-[#1A1A22] transition-colors"
          >
            Connect Wallet to Claim
            <ArrowRight size={16} />
          </button>
        ) : (
          <button
            onClick={handleClaim}
            disabled={claiming}
            className="w-full py-3 px-4 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold flex items-center justify-center gap-2 hover:bg-[#1A1A22] disabled:opacity-50 transition-colors"
          >
            {claiming ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Claiming Slot & Joining...
              </>
            ) : (
              <>
                <CheckCircle2 size={16} />
                Confirm & Join Trip
              </>
            )}
          </button>
        )}

        {isConnected && publicKey && (
          <p className="text-[11px] text-[#888] text-center font-mono">
            Connected: {publicKey.slice(0, 6)}...{publicKey.slice(-4)}
          </p>
        )}
      </div>
    </div>
  );
}
