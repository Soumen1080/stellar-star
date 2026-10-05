"use client";

import React from "react";
import { ExternalLink } from "lucide-react";
import type { Member } from "@/types/expense";
import { normalizeWalletAddress } from "@/lib/trip/members";

export interface MemberListProps {
  members: Member[];
  className?: string;
}

export function MemberList({ members, className = "" }: MemberListProps) {
  return (
    <div className={`mt-4 pt-4 border-t border-[#F5F5F5] ${className}`}>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-[#AAA] mb-2">
        Members
      </p>
      <div className="flex flex-wrap gap-2">
        {members.map((member) => {
          const canonicalWallet = member.walletAddress
            ? normalizeWalletAddress(member.walletAddress)
            : "";

          return (
            <div
              key={member.id}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-[#F6F6F6] rounded-lg border border-[#EBEBEB]"
            >
              <div className="w-5 h-5 rounded-full bg-[#0F0F14] flex items-center justify-center text-[9px] font-bold text-[#2DD4BF]">
                {member.name ? member.name.charAt(0).toUpperCase() : "?"}
              </div>
              <span className="text-xs font-medium text-[#555]">{member.name}</span>
              {canonicalWallet && (
                <a
                  href={`https://stellar.expert/explorer/testnet/account/${canonicalWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View explorer account for ${canonicalWallet}`}
                  className="text-[#CCC] hover:text-[#888]"
                >
                  <ExternalLink size={9} />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default MemberList;
