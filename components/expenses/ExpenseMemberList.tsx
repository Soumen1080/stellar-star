"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Plus, Trash2, Users } from "lucide-react";
import { isValidStellarAddress } from "@/lib/split/calculator";
import type { Member, SplitMode } from "@/types/expense";

interface ExpenseMemberListProps {
  members: Member[];
  splitMode: SplitMode;
  errors: Record<string, string>;
  onAddMember: () => void;
  onRemoveMember: (id: string) => void;
  onUpdateMember: (id: string, patch: Partial<Member>) => void;
}

export function ExpenseMemberList({
  members,
  splitMode,
  errors,
  onAddMember,
  onRemoveMember,
  onUpdateMember,
}: ExpenseMemberListProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-[#444] uppercase tracking-wide flex items-center gap-1.5">
          <Users size={12} />
          Members
          <span className="text-[#CCC] font-normal normal-case tracking-normal">({members.length})</span>
        </label>
        <button
          type="button"
          onClick={onAddMember}
          className="flex items-center gap-1 text-xs font-semibold text-[#555] hover:text-[#0F0F14] transition-colors"
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {errors.members && <p className="text-xs text-red-500 mb-2">{errors.members}</p>}

      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {members.map((member, index) => (
            <ExpenseMemberRow
              key={member.id}
              member={member}
              index={index}
              members={members}
              splitMode={splitMode}
              errors={errors}
              onRemoveMember={onRemoveMember}
              onUpdateMember={onUpdateMember}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface ExpenseMemberRowProps {
  member: Member;
  index: number;
  members: Member[];
  splitMode: SplitMode;
  errors: Record<string, string>;
  onRemoveMember: (id: string) => void;
  onUpdateMember: (id: string, patch: Partial<Member>) => void;
}

function ExpenseMemberRow({
  member,
  index,
  members,
  splitMode,
  errors,
  onRemoveMember,
  onUpdateMember,
}: ExpenseMemberRowProps) {
  const duplicateWalletOwner = getDuplicateWalletOwner(members, index);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginBottom: 0 }}
      animate={{ opacity: 1, height: "auto", marginBottom: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="flex items-start gap-2 p-3 bg-[#F8F8F8] rounded-xl border border-[#EEEEEE]">
        <div className="w-7 h-7 rounded-full bg-[#E5E5E5] flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold text-[#888]">
          {member.name ? member.name.charAt(0).toUpperCase() : "?"}
        </div>

        <div className="flex-1 grid grid-cols-1 gap-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              placeholder="Name *"
              value={member.name}
              onChange={(event) => onUpdateMember(member.id, { name: event.target.value })}
              className={`w-full rounded-lg border px-3 py-2 text-sm bg-white outline-none transition-all ${
                errors[`member_name_${index}`]
                  ? "border-red-300 focus:border-red-400"
                  : "border-[#E5E5E5] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20"
              }`}
            />

            {splitMode === "custom" && (
              <input
                type="number"
                min={1}
                placeholder="Weight"
                value={member.weight ?? 1}
                onChange={(event) =>
                  onUpdateMember(member.id, { weight: Math.max(1, parseInt(event.target.value) || 1) })
                }
                className="w-full rounded-lg border border-[#E5E5E5] px-3 py-2 text-sm bg-white outline-none focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20 transition-all"
              />
            )}
          </div>

          <input
            placeholder="Stellar address G... (optional - can connect later)"
            value={member.walletAddress ?? ""}
            onChange={(event) => onUpdateMember(member.id, { walletAddress: event.target.value })}
            className={`w-full rounded-lg border px-3 py-2 text-sm bg-white outline-none transition-all font-mono ${
              errors[`member_addr_${index}`]
                ? "border-red-300 focus:border-red-400"
                : "border-[#E5E5E5] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20"
            }`}
          />
          {duplicateWalletOwner && (
            <p className="text-xs text-red-500">
              Same wallet as {duplicateWalletOwner} - each member needs a unique address.
            </p>
          )}
          {errors[`member_addr_${index}`] ? (
            <p className="text-xs text-red-500">{errors[`member_addr_${index}`]}</p>
          ) : (
            <p className="text-[10px] text-[#AAA]">
              {member.walletAddress
                ? "Stellar wallet address - needed to send XLM payment"
                : "Optional - friend can join via invite link to attach wallet later"}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onRemoveMember(member.id)}
          disabled={members.length <= 2}
          className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-[#CCC] hover:text-red-400 hover:bg-red-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed mt-0.5"
          title="Remove member"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </motion.div>
  );
}

function getDuplicateWalletOwner(members: Member[], index: number) {
  const address = members[index].walletAddress?.trim();
  if (!address || !isValidStellarAddress(address)) return null;

  const duplicateIndex = members.findIndex(
    (member, memberIndex) => memberIndex !== index && member.walletAddress?.trim() === address,
  );

  if (duplicateIndex === -1) return null;
  return members[duplicateIndex].name.trim() || `Person ${duplicateIndex + 1}`;
}
