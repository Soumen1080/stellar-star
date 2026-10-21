"use client";

import { useState } from "react";
import { ExternalLink, UserPlus } from "lucide-react";
import type { Member } from "@/types/expense";
import { normalizeWalletAddress } from "@/lib/trip/members";
import type { Trip, TripPermission, TripRole } from "@/types/trip";
import { canManageTripRoles, memberRole, TRIP_PERMISSIONS } from "@/lib/trip/roles";
import { useSession } from "@/lib/supabase/useSession";
export { MemberList } from "./MemberList";

interface TripMembersListProps {
  trip: Trip;
  members: Member[];
  currentWallet?: string | null;
  onRoleChanged?: () => Promise<void>;
  onOpenInvite?: () => void;
}

const ROLES: Exclude<TripRole, "owner">[] = ["organizer", "contributor", "viewer", "custom"];

export function TripMembersList({
  trip,
  members,
  currentWallet,
  onRoleChanged,
  onOpenInvite,
}: TripMembersListProps) {
  const { sessionToken } = useSession();
  const [pendingRole, setPendingRole] = useState<Record<string, TripRole>>({});
  const [customPermissions, setCustomPermissions] = useState<Record<string, TripPermission[]>>({});
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleHistory, setRoleHistory] = useState<Array<{
    id: string;
    member_id: string;
    previous_role: TripRole;
    next_role: TripRole;
    previous_custom_permissions: string[];
    next_custom_permissions: string[];
    changed_by_wallet: string;
    created_at: string;
  }> | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const canManageRoles = canManageTripRoles(trip, currentWallet ?? "");

  const saveRole = async (member: Member) => {
    if (!sessionToken) return;
    const role = pendingRole[member.id] ?? memberRole(member, trip);
    setBusyMemberId(member.id);
    setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/members/${encodeURIComponent(member.id)}/role`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role,
          customPermissions: role === "custom"
            ? customPermissions[member.id] ?? member.customPermissions ?? []
            : [],
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to change this member's role.");
      setPendingRole((value) => ({ ...value, [member.id]: role }));
      await onRoleChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to change this member's role.");
    } finally {
      setBusyMemberId(null);
    }
  };

  const transferOwnership = async (member: Member) => {
    if (!sessionToken || !window.confirm(`Transfer trip ownership to ${member.name}?`)) return;
    setBusyMemberId(member.id);
    setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/transfer-ownership`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ memberId: member.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to transfer trip ownership.");
      await onRoleChanged?.();
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : "Unable to transfer trip ownership.");
    } finally {
      setBusyMemberId(null);
    }
  };

  const loadRoleHistory = async () => {
    if (!sessionToken) return;
    setHistoryLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/roles/history`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Unable to load role history.");
      setRoleHistory(result.data ?? []);
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : "Unable to load role history.");
    } finally {
      setHistoryLoading(false);
    }
  };

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
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[#777]">
                {memberRole(member, trip)}
              </span>
              {canonicalWallet && (
                <a
                  href={`https://stellar.expert/explorer/testnet/account/${canonicalWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#CCC] hover:text-[#888]"
                >
                  <ExternalLink size={9} />
                </a>
              )}
              {canManageRoles && memberRole(member, trip) !== "owner" && (
                <>
                  <select
                    aria-label={`Role for ${member.name}`}
                    className="rounded border border-[#DDD] bg-white px-1 py-0.5 text-[10px]"
                    value={pendingRole[member.id] ?? memberRole(member, trip)}
                    onChange={(event) => setPendingRole((value) => ({
                      ...value,
                      [member.id]: event.target.value as TripRole,
                    }))}
                    disabled={busyMemberId === member.id}
                  >
                    {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  {(pendingRole[member.id] ?? memberRole(member, trip)) === "custom" && (
                    <div className="basis-full pl-7 text-[10px] text-[#666]">
                      {TRIP_PERMISSIONS.map((permission) => {
                        const selected = customPermissions[member.id] ?? member.customPermissions ?? [];
                        return (
                          <label key={permission} className="mr-2 inline-flex items-center gap-1">
                            <input
                              type="checkbox"
                              checked={selected.includes(permission)}
                              onChange={(event) => setCustomPermissions((current) => {
                                const currentPermissions = current[member.id] ?? member.customPermissions ?? [];
                                return {
                                  ...current,
                                  [member.id]: event.target.checked
                                    ? [...new Set([...currentPermissions, permission])]
                                    : currentPermissions.filter((item) => item !== permission),
                                };
                              })}
                            />
                            {permission}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-[#0F766E] disabled:opacity-50"
                    disabled={busyMemberId === member.id}
                    onClick={() => void saveRole(member)}
                  >
                    Save
                  </button>
                  {canonicalWallet && (
                    <button
                      type="button"
                      className="text-[10px] font-semibold text-[#8A3B3B] disabled:opacity-50"
                      disabled={busyMemberId === member.id}
                      onClick={() => void transferOwnership(member)}
                    >
                      Transfer ownership
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="mt-2 text-[10px] font-semibold text-[#666] hover:text-[#0F766E]"
        onClick={() => roleHistory === null ? void loadRoleHistory() : setRoleHistory(null)}
        disabled={historyLoading}
      >
        {historyLoading ? "Loading role history…" : roleHistory === null ? "View role history" : "Hide role history"}
      </button>
      {roleHistory && (
        <ol className="mt-2 space-y-1 border-l border-[#DDD] pl-3 text-[10px] text-[#666]">
          {roleHistory.length === 0 && <li>No role changes recorded.</li>}
          {roleHistory.map((change) => {
            const changedMember = members.find((member) => member.id === change.member_id);
            return (
              <li key={change.id}>
                {changedMember?.name ?? "Former member"}: {change.previous_role} → {change.next_role}
                {(change.previous_role === "custom" || change.next_role === "custom") && (
                  <span>
                    {" · permissions: "}
                    {change.previous_custom_permissions.join(", ") || "none"}
                    {" → "}
                    {change.next_custom_permissions.join(", ") || "none"}
                  </span>
                )}
                {" · by "}
                {change.changed_by_wallet.length > 14
                  ? `${change.changed_by_wallet.slice(0, 8)}…${change.changed_by_wallet.slice(-4)}`
                  : change.changed_by_wallet}
                {" · "}{new Date(change.created_at).toLocaleString()}
              </li>
            );
          })}
        </ol>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
