"use client";

import { ExternalLink, UserPlus, Link2 } from "lucide-react";
import type { Member } from "@/types/expense";

interface TripMembersListProps {
  members: Member[];
  onOpenInvite?: () => void;
}

export function TripMembersList({ members, onOpenInvite }: TripMembersListProps) {
  return (
    <div className="mt-4 pt-4 border-t border-[#F5F5F5]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-[#AAA]">
          Members ({members.length})
        </p>
        {onOpenInvite && (
          <button
            onClick={onOpenInvite}
            className="flex items-center gap-1 text-[11px] font-semibold text-[#0F766E] hover:text-[#0D5F58] hover:underline transition-all"
          >
            <UserPlus size={12} />
            Invite Friend
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {members.map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-[#F6F6F6] rounded-lg border border-[#EBEBEB]"
          >
            <div className="w-5 h-5 rounded-full bg-[#0F0F14] flex items-center justify-center text-[9px] font-bold text-[#2DD4BF]">
              {member.name.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-medium text-[#555]">{member.name}</span>
            {member.walletAddress ? (
              <a
                href={`https://stellar.expert/explorer/testnet/account/${member.walletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#CCC] hover:text-[#888]"
                title={`Wallet: ${member.walletAddress}`}
              >
                <ExternalLink size={9} />
              </a>
            ) : onOpenInvite ? (
              <button
                onClick={onOpenInvite}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#92400E] hover:bg-[#FDE68A] transition-colors"
                title="Click to generate invite link for this member"
              >
                Invite
              </button>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#92400E]">
                Pending
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

