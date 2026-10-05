"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Copy, Check, X, Link, Shield, Trash2, Loader2, UserPlus, QrCode } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { useSession } from "@/lib/supabase/useSession";
import { QRCodeSVG } from "qrcode.react";
import type { Trip } from "@/types/trip";

interface InviteMemberModalProps {
  trip: Trip;
  isOpen: boolean;
  onClose: () => void;
}

export function InviteMemberModal({ trip, isOpen, onClose }: InviteMemberModalProps) {
  const { sessionToken } = useSession();
  const { success: toastSuccess, error: toastError } = useToast();

  const [selectedMemberId, setSelectedMemberId] = useState<string>("");
  const [generatedUrl, setGeneratedUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const unclaimedMembers = useMemo<Member[]>(
    () =>
      (trip.members || []).filter(
        (m: Member) => !m.walletAddress || m.walletAddress.trim() === "",
      ),
    [trip.members],
  );

  // Reset transient link state and default the selection each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setGeneratedUrl("");
      setCopied(false);
      setShowQR(false);
      setSelectedMemberId(unclaimedMembers.length > 0 ? unclaimedMembers[0].id : "");
    }
  }, [isOpen, unclaimedMembers]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

    setSelectedMemberId((current) => {
      // "" is the General Group Invite option, always valid.
      if (current === "") return current;
      if (unclaimedMembers.some((m) => m.id === current)) return current;
      return unclaimedMembers.length > 0 ? unclaimedMembers[0].id : "";
    });
  }, [isOpen, unclaimedKey, unclaimedMembers]);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/invitations/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({
          tripId: trip.id,
          memberId: selectedMemberId || null,
          maxUses: 1,
          expiresInDays: 7,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to create invitation link.");
      }

      setGeneratedUrl(data.inviteUrl);
      toastSuccess("Invite link generated!", "Share this link with your friend to let them claim their slot.");
    } catch (err) {
      toastError("Generation failed", err instanceof Error ? err.message : "Error creating invite.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!generatedUrl) return;
    await navigator.clipboard.writeText(generatedUrl);
    setCopied(true);
    toastSuccess("Copied to clipboard!", "Send the link to your friend.");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
    >
      <div className="bg-white rounded-2xl border border-[#EEEEEE] shadow-xl w-full max-w-md overflow-hidden animate-scale-in">
        <div className="flex items-center justify-between p-4 border-b border-[#F0F0F0]">
          <div className="flex items-center gap-2">
            <UserPlus size={18} className="text-[#2DD4BF]" />
            <h3 id="invite-modal-title" className="text-base font-bold text-[#0F0F14]">Invite to Trip</h3>
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1 rounded-lg text-[#888] hover:text-[#0F0F14] hover:bg-[#F5F5F5] transition-colors"
          >
            Select Member Slot to Invite
          </label>
          {unclaimedMembers.length > 0 ? (
            <select
              id="invite-member-slot"
              value={selectedMemberId}
              onChange={(e) => setSelectedMemberId(e.target.value)}
              className="w-full rounded-xl border border-[#E5E5E5] px-3 py-2.5 text-sm bg-white text-[#0F0F14] outline-none focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20 transition-all"
            >
              {unclaimedMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} (unclaimed slot)
                </option>
              ))}
              <option value="">General Group Invite (any new member)</option>
            </select>
          ) : (
            <p className="text-xs text-[#666] p-3 bg-[#F8F9FA] rounded-xl border border-[#E9ECEF]">
              All current members have attached wallets. You can generate a general invite link to add a new member.
            </p>
          )}
        </div>

        {!generatedUrl ? (
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold flex items-center justify-center gap-2 hover:bg-[#1A1A22] disabled:opacity-50 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Generating Secure Link...
                </>
              ) : (
                <>
                  <Link size={16} />
                  Generate Invitation Link
                </>
              )}
            </button>
          ) : (
            <div className="space-y-3 pt-2">
              <div className="flex items-center gap-2 p-2.5 bg-[#F0FDFA] rounded-xl border border-[#CCFBF1]">
                <input
                  type="text"
                  readOnly
                  value={generatedUrl}
                  className="flex-1 bg-transparent text-xs font-mono text-[#0F766E] outline-none select-all"
                />
                <button
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg bg-[#2DD4BF] text-[#0F766E] hover:bg-[#20BEAB] transition-colors shrink-0"
                  title="Copy link"
                  aria-label="Copy invitation link"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleCopy}
                  className="flex-1 py-2 px-3 rounded-xl bg-[#0F0F14] text-white text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-[#222] transition-colors"
                >
                  {copied ? <Check size={14} className="text-[#2DD4BF]" /> : <Copy size={14} />}
                  {copied ? "Copied!" : "Copy Link"}
                </button>
                <button
                  onClick={() => setShowQR((prev) => !prev)}
                  className="py-2 px-3 rounded-xl border border-[#E5E5E5] text-[#555] text-xs font-semibold flex items-center gap-1.5 hover:bg-[#F5F5F5] transition-colors"
                >
                  <QrCode size={14} />
                  {showQR ? "Hide QR" : "Show QR"}
                </button>
              </div>

              {showQR && (
                <div className="p-4 bg-white rounded-xl border border-[#E5E5E5] flex flex-col items-center">
                  <QRCodeSVG
                    value={generatedUrl}
                    size={160}
                    bgColor="#ffffff"
                    fgColor="#0F0F14"
                    level="M"
                  />
                  <p className="text-[11px] text-[#888] mt-2">Scan with phone to join</p>
                </div>
              )}

              <p className="text-[11px] text-[#888] text-center">
                This link is valid for 7 days and can be claimed once.
              </p>
            </div>
        )}
      </div>
    </Modal>
  );
}
