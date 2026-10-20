"use client";

import { useState } from "react";
import { ClipboardCheck, FileLock2 } from "lucide-react";
import { Money as MoneyDisplay } from "@/components/ui/Money";
import { useToast } from "@/components/ui/Toast";
import { useWallet } from "@/hooks/useWallet";
import { formatAddress } from "@/lib/utils";
import {
  MAX_REASON_LENGTH,
  type ProposalDecision,
  type ProposalEvaluation,
  type ProposalResponse,
} from "@/lib/settlement/proposal";
import type { useSettlementProposal } from "@/hooks/useSettlementProposal";

type ProposalState = ReturnType<typeof useSettlementProposal>;

const STATUS_LABEL: Record<ProposalEvaluation["status"], string> = {
  open: "Awaiting approval",
  approved: "Approved — payments can begin",
  rejected: "Rejected",
  edit_requested: "Edit requested",
  expired: "Expired",
  revoked: "Revoked",
  superseded: "Superseded",
  invalidated: "Invalidated — expenses changed",
  tampered: "Invalid snapshot",
};

const CHANGE_LABEL: Record<string, string> = {
  removed: "was removed",
  added: "was added",
  amount_changed: "amounts changed",
  members_changed: "members changed",
  payer_changed: "payer changed",
  asset_changed: "asset changed",
  payment_reverted: "a payment was reverted",
};

function decisionLabel(r: ProposalResponse): string {
  return r.decision === "approve" ? "Approved" : r.decision === "reject" ? "Rejected" : "Requested an edit";
}

/** The frozen "proposed settlement" for a trip, and members' answers to it (#328). */
export function SettlementProposalPanel({
  state,
  hasOutstanding,
}: {
  state: ProposalState;
  hasOutstanding: boolean;
}) {
  const { publicKey } = useWallet();
  const { success, error } = useToast();
  const [reason, setReason] = useState("");
  const [answering, setAnswering] = useState<Exclude<ProposalDecision, "approve"> | null>(null);
  const { proposal, evaluation, responses, busy } = state;

  const attempt = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      success(done);
      setReason("");
      setAnswering(null);
    } catch (err) {
      error("Could not update the proposal", err instanceof Error ? err.message : "Please try again.");
    }
  };

  if (!state.loaded) return null;

  const terminal = !evaluation || ["expired", "revoked", "superseded", "invalidated", "tampered", "rejected"].includes(evaluation.status);
  const canPropose = hasOutstanding && !!publicKey && terminal;

  if (!proposal || !evaluation) {
    if (!canPropose) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-[#D0D0D0] p-3 text-xs text-[#555]">
        <span>Larger group? Freeze the balances as a proposal so everyone agrees before anyone pays.</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => attempt(() => state.propose(), "Settlement proposed")}
          className="rounded-lg bg-[#0F0F14] px-3 py-1.5 font-bold text-[#2DD4BF] disabled:opacity-40"
        >
          Propose settlement
        </button>
      </div>
    );
  }

  const snapshot = proposal.snapshot;
  const me = snapshot.participants.find((p) => p.wallet === publicKey);
  const canAnswer = !!me && ["open", "approved", "rejected", "edit_requested"].includes(evaluation.status);
  const latestByWallet = new Map(
    responses.filter((r) => r.contentHash === proposal.contentHash).map((r) => [r.wallet, r] as const),
  );

  return (
    <section
      aria-labelledby={`proposal-${proposal.id}`}
      className="space-y-3 rounded-xl border border-[#E5E5E5] bg-white p-3.5 text-xs text-[#555]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`proposal-${proposal.id}`} className="flex items-center gap-1.5 text-sm font-bold text-[#0F0F14]">
          <FileLock2 size={14} className="text-[#2DD4BF]" />
          Proposed settlement
          <code className="rounded bg-[#F0F0F0] px-1.5 py-0.5 text-[11px]" title={proposal.contentHash}>
            {evaluation.reference}
          </code>
        </h4>
        <span
          className={
            evaluation.status === "approved"
              ? "rounded-full bg-[#2DD4BF]/30 px-2 py-0.5 font-bold text-[#134E4A]"
              : "rounded-full bg-[#F5F5F5] px-2 py-0.5 font-bold text-[#555]"
          }
        >
          {STATUS_LABEL[evaluation.status]}
        </span>
      </div>

      <p>
        By {formatAddress(proposal.creatorWallet, 4)} · {snapshot.expenses.length} expense(s) frozen ·{" "}
        {snapshot.assets.length} asset(s) · expires {new Date(proposal.expiresAt).toLocaleString()}
      </p>

      {evaluation.changes.length > 0 && (
        <ul role="alert" className="space-y-0.5 rounded-lg bg-orange-50 p-2 text-orange-700">
          {evaluation.changes.map((c) => (
            <li key={`${c.expenseId}-${c.kind}`}>
              Expense {c.expenseId.slice(0, 8)} {CHANGE_LABEL[c.kind] ?? c.kind}; approvals no longer count.
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className="mb-1 font-semibold text-[#0F0F14]">Transfers in this proposal</p>
        <ul className="space-y-0.5">
          {snapshot.transfers.map((t) => (
            <li key={`${t.fromId}-${t.toId}-${t.asset}`} className="flex flex-wrap gap-1">
              <span className="font-medium">{t.from}</span> → <span className="font-medium">{t.to}</span>
              <MoneyDisplay amount={t.amount} asset={t.asset} />
            </li>
          ))}
        </ul>
      </div>

      <details>
        <summary className="cursor-pointer font-semibold text-[#0F0F14]">Balances and included expense versions</summary>
        <ul className="mt-1 space-y-0.5">
          {snapshot.balances.map((b) => (
            <li key={`${b.asset}-${b.memberId}`}>
              {b.name}: <MoneyDisplay amount={b.net} asset={b.asset} />
            </li>
          ))}
        </ul>
        <ul className="mt-1 space-y-0.5 text-[#888]">
          {snapshot.expenses.map((e) => (
            <li key={e.id}>
              {e.id.slice(0, 8)} · v{e.version} · <MoneyDisplay amount={e.totalAmount} asset={e.asset} />
            </li>
          ))}
        </ul>
      </details>

      <div>
        <p className="mb-1 font-semibold text-[#0F0F14]">Members</p>
        <ul className="space-y-0.5">
          {snapshot.participants.map((p) => {
            const r = latestByWallet.get(p.wallet);
            return (
              <li key={p.wallet}>
                <span className="font-medium">{p.name}</span>: {r ? decisionLabel(r) : "No answer yet"}
                {r?.reason && <span className="text-[#888]"> — “{r.reason}”</span>}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3 font-semibold">
        {canAnswer && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => attempt(() => state.respond("approve"), "You approved the proposal")}
              className="inline-flex items-center gap-1 rounded-lg bg-[#0F0F14] px-2.5 py-1 text-[#2DD4BF] disabled:opacity-40"
            >
              <ClipboardCheck size={12} /> Approve
            </button>
            <button type="button" disabled={busy} onClick={() => setAnswering("reject")} className="text-[#555] hover:text-[#0F0F14]">
              Reject
            </button>
            <button type="button" disabled={busy} onClick={() => setAnswering("request_edit")} className="text-[#555] hover:text-[#0F0F14]">
              Request edit
            </button>
          </>
        )}
        {proposal.creatorWallet === publicKey && proposal.status === "open" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => attempt(() => state.revoke(), "Proposal revoked")}
            className="text-[#555] hover:text-[#0F0F14]"
          >
            Revoke
          </button>
        )}
        {canPropose && (
          <button
            type="button"
            disabled={busy}
            onClick={() => attempt(() => state.propose(), "Settlement proposed")}
            className="text-[#134E4A] hover:underline"
          >
            Propose again from current balances
          </button>
        )}
      </div>

      {answering && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(
              () => state.respond(answering, reason),
              answering === "reject" ? "You rejected the proposal" : "Edit requested",
            );
          }}
        >
          <label className="sr-only" htmlFor={`proposal-reason-${proposal.id}`}>
            Reason
          </label>
          <input
            id={`proposal-reason-${proposal.id}`}
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
            placeholder={answering === "reject" ? "Why are you rejecting it?" : "What should change?"}
            className="min-w-0 flex-1 rounded-lg border border-[#E5E5E5] px-2 py-1"
          />
          <button
            type="submit"
            disabled={busy || !reason.trim()}
            className="rounded-lg bg-[#0F0F14] px-2.5 py-1 font-semibold text-white disabled:opacity-40"
          >
            Send
          </button>
          <button type="button" onClick={() => setAnswering(null)} className="text-[#888]">
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}
