"use client";

import React, { useState } from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
import type { Member } from "@/types/expense";
import type { Contact } from "@/types/contact";
import type { TripFormData, TripPermissions, RecurringExpenseRule } from "@/types/trip";
import { normalizePermissions, normalizeRecurringRules, validateTripDraft } from "@/lib/trip/templates";
import { Input } from "@/components/ui/Input";
import { TripPermissionsFields } from "@/components/trips/TripPermissionsFields";
import { TripRecurringRulesEditor } from "@/components/trips/TripRecurringRulesEditor";
import { findDuplicateWalletErrors, isValidStellarAddress } from "@/lib/split/calculator";
import { canonicalWallet, contactToMember, walletTrust } from "@/lib/contacts/contacts";
import { cn } from "@/lib/utils";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

interface TripFormProps {
  submitLabel?: string;
  submitting?: boolean;
  onSubmit: (data: TripFormData) => void;
  onCancel: () => void;
  initialData?: Partial<TripFormData>;
  /** Prefill the first member's wallet address from connected wallet */
  currentUserPublicKey?: string | null;
  /** Prefill the first member's name from authenticated user */
  currentUserName?: string | null;
  /** The user's saved contacts, offered as one-click members. */
  contacts?: Contact[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMember(name = ""): Member {
  return { id: crypto.randomUUID(), name, walletAddress: "" };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TripForm({
  onSubmit,
  onCancel,
  initialData,
  currentUserPublicKey,
  currentUserName,
  contacts = [],
  submitLabel = "Create Trip",
  submitting = false,
}: TripFormProps) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [startsOn, setStartsOn] = useState(initialData?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(initialData?.endsOn ?? "");
  const [recurringRules, setRecurringRules] = useState<RecurringExpenseRule[]>(
    initialData?.recurringRules ?? []
  );
  const [permissions, setPermissions] = useState<TripPermissions>(() =>
    normalizePermissions(initialData?.permissions)
  );
  const [members, setMembers] = useState<Member[]>(() => {
    if (initialData?.members && initialData.members.length >= 2) {
      return initialData.members;
    }
    // Pre-fill first member with current user info if available
    return [
      {
        id: crypto.randomUUID(),
        name: currentUserName ?? "",
        walletAddress: currentUserPublicKey ? currentUserPublicKey.trim().toUpperCase() : "",
      },
      createMember(),
    ];
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── Member mutations ───────────────────────────────────────────────────────

  const updateMember = (id: string, field: keyof Member, value: string) => {
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, [field]: value } : m))
    );
  };

  const addMember = () => setMembers((prev) => [...prev, createMember()]);

  /** Fills the first empty row (or appends one) from a saved contact. */
  const addFromContact = (contactId: string) => {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) return;
    setMembers((prev) => {
      const wallet = canonicalWallet(contact.walletAddress);
      // Same wallet already present: duplicates are identified by address.
      if (wallet && prev.some((m) => canonicalWallet(m.walletAddress) === wallet)) return prev;
      const member = contactToMember(contact);
      const emptyIndex = prev.findIndex((m) => !m.name.trim() && !m.walletAddress?.trim());
      if (emptyIndex === -1) return [...prev, member];
      return prev.map((m, i) => (i === emptyIndex ? { ...member, id: m.id } : m));
    });
  };

  const removeMember = (id: string) => {
    if (members.length <= 2) return;
    setMembers((prev) => prev.filter((m) => m.id !== id));
  };

  // ── Validation ────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Trip name is required";

    const namedMembers = members.filter((m) => m.name.trim());
    if (namedMembers.length < 2) errs.members = "Add at least 2 members";

    members.forEach((m, i) => {
      if (!m.name.trim()) return;

      const raw = m.walletAddress?.trim() ?? "";
      if (raw && !isValidStellarAddress(raw)) {
        errs[`member_addr_${i}`] = "Invalid Stellar address (must start with G, 56 chars).";
      }
    });

    const duplicateErrors = findDuplicateWalletErrors(
      members.map((m) => (m.name.trim() ? m.walletAddress : undefined))
    );
    Object.entries(duplicateErrors).forEach(([i, message]) => {
      errs[`member_addr_${i}`] = message;
    });

    // Dates and recurring rules share their rules with the copy RPC, so take
    // those checks from the same validator rather than restating them here.
    const draftErrors = validateTripDraft({
      name,
      description,
      members,
      startsOn,
      endsOn,
      recurringRules,
      permissions,
    });
    Object.entries(draftErrors).forEach(([key, message]) => {
      if (key.startsWith("rule_") || key === "startsOn" || key === "endsOn") errs[key] = message;
    });

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const cleanMembers = members
      .filter((m) => m.name.trim())
      .map((m) => ({
        ...m,
        name: m.name.trim(),
        walletAddress: m.walletAddress?.trim() ? m.walletAddress.trim().toUpperCase() : undefined,
      }));

    trackAnalyticsEvent("trip_created", {
      member_count: cleanMembers.length,
      has_dates: Boolean(startsOn || endsOn),
      has_recurring_rules: recurringRules.length > 0,
    });

    onSubmit({
      name: name.trim(),
      description: description.trim(),
      members: cleanMembers,
      startsOn: startsOn || undefined,
      endsOn: endsOn || undefined,
      recurringRules: normalizeRecurringRules(recurringRules),
      permissions,
    });
  };

  const hasAdvancedValues =
    Boolean(initialData?.startsOn || initialData?.endsOn) ||
    (initialData?.recurringRules?.length ?? 0) > 0 ||
    initialData?.permissions !== undefined;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Trip name */}
      <Input
        label="Trip name"
        placeholder="e.g. Bali 2025, Euro Trip"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
        required
      />

      {/* Description */}
      <Input
        label="Description"
        placeholder="Add a short note about this trip"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      {/* Members */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-[#0F0F14]">
            Members <span className="text-[#AAA] font-normal">({members.length})</span>
          </div>
          <button
            type="button"
            onClick={addMember}
            className="flex min-h-11 items-center gap-1 text-xs font-semibold text-[#666] hover:text-[#0F0F14] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E]"
          >
            <UserPlus size={12} />
            Add member
          </button>
        </div>

        {errors.members && (
          <p role="alert" className="text-xs text-red-700 mb-2">{errors.members}</p>
        )}

        {contacts.length > 0 && (
          <select
            aria-label="Add from contacts"
            value=""
            onChange={(e) => addFromContact(e.target.value)}
            className="mb-2 w-full rounded-xl border border-[#E5E5E5] bg-white px-3 py-2.5 text-sm text-[#555]"
          >
            <option value="">Add from contacts…</option>
            {contacts.map((contact) => {
              const trust = walletTrust(contact);
              return (
                <option key={contact.id} value={contact.id}>
                  {contact.displayName}
                  {trust === "verified" ? " ✓ verified wallet" : trust === "unverified" ? " (unverified wallet)" : " (no wallet)"}
                </option>
              );
            })}
          </select>
        )}

        <div className="space-y-2">
          {members.map((member, i) => (
            <div key={member.id} className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  label={`Member ${i + 1} name`}
                  placeholder={`Member ${i + 1} name`}
                  value={member.name}
                  onChange={(e) => updateMember(member.id, "name", e.target.value)}
                  required={i < 2}
                />
                <div className="flex flex-col gap-0.5">
                  <Input
                    label={`Member ${i + 1} Stellar address (optional)`}
                    placeholder="G... Stellar address (optional)"
                    value={member.walletAddress ?? ""}
                    onChange={(e) =>
                      updateMember(member.id, "walletAddress", e.target.value)
                    }
                    error={errors[`member_addr_${i}`]}
                  />
                  {!errors[`member_addr_${i}`] && (
                    <p className="text-[10px] text-[#AAA] px-1">
                      {member.walletAddress
                        ? "Used to send XLM payment"
                        : "Optional - can invite friend by link to connect wallet later"}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeMember(member.id)}
                aria-label={`Remove member ${i + 1}`}
                disabled={members.length <= 2}
                className={cn(
                  "mt-1 min-w-11 min-h-11 p-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E]",
                  members.length <= 2
                    ? "text-[#E0E0E0] cursor-not-allowed"
                    : "text-[#CCC] hover:text-red-500 hover:bg-red-50"
                )}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addMember}
          className="mt-2 w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-[#D0D0D0] text-sm text-[#AAA] hover:border-[#2DD4BF] hover:text-[#555] transition-all"
        >
          <Plus size={13} />
          Add another member
        </button>
      </div>

      {/* Dates, recurring expenses & permissions. A <details> rather than a
          toggle button keeps the member-row button order stable. */}
      <details
        open={hasAdvancedValues}
        className="rounded-xl border border-[#EFEFEF] bg-[#FAFAFA] px-4 py-3 [&_summary]:cursor-pointer"
      >
        <summary className="text-sm font-semibold text-[#0F0F14]">
          Dates, recurring expenses &amp; permissions
        </summary>
        <div className="mt-4 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Starts on"
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
              error={errors.startsOn}
            />
            <Input
              label="Ends on"
              type="date"
              value={endsOn}
              min={startsOn || undefined}
              onChange={(e) => setEndsOn(e.target.value)}
              error={errors.endsOn}
            />
          </div>
          <TripRecurringRulesEditor
            rules={recurringRules}
            members={members}
            errors={errors}
            onChange={setRecurringRules}
          />
          <TripPermissionsFields value={permissions} onChange={setPermissions} />
        </div>
      </details>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl border border-[#E5E5E5] text-sm font-semibold text-[#555] hover:bg-[#F0F0F0] transition-all"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="flex-1 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all disabled:opacity-60"
        >
          {submitting ? "Creating…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
