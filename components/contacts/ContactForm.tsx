"use client";

import React, { useState } from "react";
import { Input } from "@/components/ui/Input";
import { validateContactInput } from "@/lib/contacts/contacts";
import type { Contact, ContactInput, ContactInviteChannel } from "@/types/contact";

interface ContactFormProps {
  /** Present when editing. */
  contact?: Contact;
  existing: Contact[];
  submitting?: boolean;
  onSubmit: (input: ContactInput) => void;
  onCancel: () => void;
}

export function ContactForm({ contact, existing, submitting, onSubmit, onCancel }: ContactFormProps) {
  const [displayName, setDisplayName] = useState(contact?.displayName ?? "");
  const [walletAddress, setWalletAddress] = useState(contact?.walletAddress ?? "");
  const [inviteDestination, setInviteDestination] = useState(contact?.inviteDestination ?? "");
  const [inviteChannel, setInviteChannel] = useState<ContactInviteChannel>(contact?.inviteChannel ?? "email");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A saved wallet is replaced through the notice flow, never edited in place.
  const walletLocked = Boolean(contact?.walletAddress);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const input: ContactInput = {
      displayName,
      walletAddress: walletLocked ? contact?.walletAddress : walletAddress,
      inviteDestination,
      inviteChannel,
    };
    const next = validateContactInput(input, existing, contact?.id);
    setErrors(next);
    if (Object.keys(next).length === 0) onSubmit(input);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Display name"
        placeholder="e.g. Sam (flatmate)"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        error={errors.displayName}
        required
      />
      <Input
        label="Wallet address"
        placeholder="G... Stellar address (optional)"
        value={walletAddress}
        onChange={(e) => setWalletAddress(e.target.value)}
        error={errors.walletAddress}
        disabled={walletLocked}
        hint={
          walletLocked
            ? "Use “Change wallet” to replace it, so active trips are notified first."
            : "Optional. Stays marked unverified until its owner claims this contact."
        }
      />
      <div className="grid grid-cols-[110px_1fr] gap-2 items-start">
        <select
          aria-label="Invite channel"
          value={inviteChannel}
          onChange={(e) => setInviteChannel(e.target.value as ContactInviteChannel)}
          className="mt-[22px] rounded-xl border border-[#E5E5E5] bg-white px-3 py-2.5 text-sm"
        >
          <option value="email">Email</option>
          <option value="phone">Phone</option>
          <option value="other">Other</option>
        </select>
        <Input
          label="Invite destination"
          placeholder="Where to send an invite (optional)"
          value={inviteDestination}
          onChange={(e) => setInviteDestination(e.target.value)}
          error={errors.inviteDestination}
        />
      </div>
      <div className="flex gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl border border-[#E5E5E5] text-sm font-semibold text-[#555] hover:bg-[#F0F0F0]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] disabled:opacity-60"
        >
          {contact ? "Save changes" : "Add contact"}
        </button>
      </div>
    </form>
  );
}
