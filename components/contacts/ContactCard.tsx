"use client";

import React, { useState } from "react";
import { BadgeCheck, CircleAlert, Link2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/Input";
import {
  WALLET_TRUST_LABELS,
  canApplyWalletChange,
  describeNoticeRemaining,
  walletTrust,
} from "@/lib/contacts/contacts";
import { isValidStellarAddress } from "@/lib/split/calculator";
import { cn, formatAddress } from "@/lib/utils";
import type { Contact, ContactWalletChange } from "@/types/contact";

interface ContactCardProps {
  contact: Contact;
  pendingChange?: ContactWalletChange;
  onEdit: () => void;
  onDelete: () => void;
  onClaimLink: () => void;
  onRequestChange: (newWallet: string) => Promise<void>;
  onApplyChange: (change: ContactWalletChange) => void;
  onCancelChange: (change: ContactWalletChange) => void;
}

const iconButton =
  "p-2 rounded-lg text-[#AAA] hover:text-[#0F0F14] hover:bg-[#F0F0F0] transition-colors";

export function ContactCard({
  contact,
  pendingChange,
  onEdit,
  onDelete,
  onClaimLink,
  onRequestChange,
  onApplyChange,
  onCancelChange,
}: ContactCardProps) {
  const trust = walletTrust(contact);
  const [changing, setChanging] = useState(false);
  const [newWallet, setNewWallet] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);

  const submitChange = async (event: React.FormEvent) => {
    event.preventDefault();
    const wallet = newWallet.trim().toUpperCase();
    if (!isValidStellarAddress(wallet)) {
      setChangeError("Invalid Stellar address (must start with G, 56 chars).");
      return;
    }
    try {
      await onRequestChange(wallet);
      setChanging(false);
      setNewWallet("");
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : "Could not request the change.");
    }
  };

  return (
    <li className="rounded-2xl border border-[#E5E5E5] bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 shrink-0 rounded-full bg-[#0F0F14] flex items-center justify-center text-xs font-bold text-[#2DD4BF]">
          {contact.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-[#0F0F14]">{contact.displayName}</p>
          {contact.walletAddress && (
            <p className="font-mono text-[11px] text-[#888]" title={contact.walletAddress}>
              {formatAddress(contact.walletAddress, 8)}
            </p>
          )}
          <span
            className={cn(
              "mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
              trust === "verified" && "bg-[#2DD4BF]/20 text-[#134E4A]",
              trust === "unverified" && "bg-amber-50 text-amber-700",
              trust === "none" && "bg-[#F0F0F0] text-[#888]",
            )}
          >
            {trust === "verified" ? <BadgeCheck size={10} /> : <CircleAlert size={10} />}
            {WALLET_TRUST_LABELS[trust]}
          </span>
          {contact.inviteDestination && (
            <p className="mt-1 text-[11px] text-[#AAA]">Invite via {contact.inviteDestination}</p>
          )}
        </div>
        <div className="flex shrink-0">
          {trust !== "verified" && (
            <button type="button" aria-label={`Create claim link for ${contact.displayName}`} onClick={onClaimLink} className={iconButton}>
              <Link2 size={13} />
            </button>
          )}
          {contact.walletAddress && !pendingChange && (
            <button type="button" aria-label={`Change wallet for ${contact.displayName}`} onClick={() => setChanging((v) => !v)} className={iconButton}>
              <RefreshCw size={13} />
            </button>
          )}
          <button type="button" aria-label={`Edit ${contact.displayName}`} onClick={onEdit} className={iconButton}>
            <Pencil size={13} />
          </button>
          <button type="button" aria-label={`Delete ${contact.displayName}`} onClick={onDelete} className={cn(iconButton, "hover:text-red-500 hover:bg-red-50")}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {changing && (
        <form onSubmit={submitChange} className="mt-3 space-y-2 border-t border-[#F5F5F5] pt-3">
          <Input
            aria-label="New wallet address"
            placeholder="New G... address"
            value={newWallet}
            onChange={(e) => {
              setNewWallet(e.target.value);
              setChangeError(null);
            }}
            error={changeError ?? undefined}
          />
          <p className="text-[11px] text-[#888]">
            Past payments keep the old address. Members of your active trips with this contact are
            notified for 24 hours before the new address can be used.
          </p>
          <button type="submit" className="rounded-lg bg-[#0F0F14] px-3 py-1.5 text-xs font-bold text-[#2DD4BF]">
            Request change
          </button>
        </form>
      )}

      {pendingChange && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-semibold">
            Wallet change pending → {formatAddress(pendingChange.newWallet, 6)}
            {pendingChange.verified ? " (proven by its owner)" : " (unverified)"}
          </p>
          <p className="mt-0.5">
            {pendingChange.affectedTripIds.length === 0
              ? "No active trips use the old address."
              : `${pendingChange.affectedTripIds.length} active trip(s) notified. Can be applied ${describeNoticeRemaining(pendingChange.noticeUntil)}.`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={!canApplyWalletChange(pendingChange)}
              onClick={() => onApplyChange(pendingChange)}
              className="rounded-lg bg-[#0F0F14] px-3 py-1.5 font-bold text-[#2DD4BF] disabled:opacity-40"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => onCancelChange(pendingChange)}
              className="rounded-lg border border-amber-300 px-3 py-1.5 font-semibold"
            >
              Cancel change
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
