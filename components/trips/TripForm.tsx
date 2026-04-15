"use client";

import React, { useState } from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
import type { Member } from "@/types/expense";
import type { TripFormData } from "@/types/trip";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";

interface TripFormProps {
  onSubmit: (data: TripFormData) => void;
  onCancel: () => void;
  initialData?: Partial<TripFormData>;
  /** Prefill the first member's wallet address from connected wallet */
  currentUserPublicKey?: string | null;
  /** Prefill the first member's name from authenticated user */
  currentUserName?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMember(name = ""): Member {
  return { id: crypto.randomUUID(), name, walletAddress: "" };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TripForm({ onSubmit, onCancel, initialData, currentUserPublicKey, currentUserName }: TripFormProps) {
  const [name, setName] = useState(initialData?.name ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [members, setMembers] = useState<Member[]>(() => {
    if (initialData?.members && initialData.members.length >= 2) {
      return initialData.members;
    }
    // Pre-fill first member with current user info if available
    return [
      {
        id: crypto.randomUUID(),
        name: currentUserName ?? "",
        walletAddress: currentUserPublicKey ?? "",
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
      if (!m.walletAddress?.trim())
        errs[`member_addr_${i}`] = "Stellar address is required.";
      else if (!/^G[A-Z2-7]{55}$/.test(m.walletAddress.trim()))
        errs[`member_addr_${i}`] = "Invalid Stellar address (must start with G, 56 chars).";
    });
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    onSubmit({
      name: name.trim(),
      description: description.trim(),
      members: members
        .filter((m) => m.name.trim())
        .map((m) => ({
          ...m,
          name: m.name.trim(),
          walletAddress: m.walletAddress?.trim(),
        })),
    });
  };

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
          <label className="text-sm font-semibold text-[#0F0F14]">
            Members <span className="text-[#AAA] font-normal">({members.length})</span>
          </label>
          <button
            type="button"
            onClick={addMember}
            className="flex items-center gap-1 text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
          >
            <UserPlus size={12} />
            Add member
          </button>
        </div>

        {errors.members && (
          <p className="text-xs text-red-500 mb-2">{errors.members}</p>
        )}

        <div className="space-y-2">
          {members.map((member, i) => (
            <div key={member.id} className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  placeholder={`Member ${i + 1} name`}
                  value={member.name}
                  onChange={(e) => updateMember(member.id, "name", e.target.value)}
                  required={i < 2}
                />
                <div className="flex flex-col gap-0.5">
                  <Input
                    placeholder="G… Stellar address *"
                    value={member.walletAddress ?? ""}
                    onChange={(e) =>
                      updateMember(member.id, "walletAddress", e.target.value)
                    }
                    error={errors[`member_addr_${i}`]}
                  />
                  {!errors[`member_addr_${i}`] && (
                    <p className="text-[10px] text-[#AAA] px-1">Required — used to send XLM payment</p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeMember(member.id)}
                disabled={members.length <= 2}
                className={cn(
                  "mt-1 p-2 rounded-lg transition-colors",
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
          className="flex-1 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
        >
          Create Trip
        </button>
      </div>
    </form>
  );
}
