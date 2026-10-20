"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import {
  buildProposalSnapshot,
  evaluateProposal,
  validateResponse,
  type ProposalDecision,
  type ProposalEvaluation,
  type ProposalResponse,
  type SettlementProposal,
} from "@/lib/settlement/proposal";
import {
  createProposal,
  fetchLatestProposal,
  respondToProposal,
  setProposalStatus,
} from "@/lib/settlement/proposalQueries";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

/** The trip's latest settlement proposal, evaluated against live expenses (#328). */
export function useSettlementProposal(trip: Trip, expenses: Expense[]) {
  const { publicKey } = useWallet();
  const [proposal, setProposal] = useState<SettlementProposal | null>(null);
  const [responses, setResponses] = useState<ProposalResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const latest = await fetchLatestProposal(trip.id);
      setProposal(latest?.proposal ?? null);
      setResponses(latest?.responses ?? []);
    } catch {
      // Not signed in, or migration 0014 not applied: no proposal flow.
      setProposal(null);
      setResponses([]);
    } finally {
      setLoaded(true);
    }
  }, [trip.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const evaluation: ProposalEvaluation | null = useMemo(
    () => (proposal ? evaluateProposal(proposal, responses, { trip, expenses }) : null),
    [proposal, responses, trip, expenses],
  );

  // Record a detected material change so every member sees it as invalidated.
  useEffect(() => {
    if (proposal?.status === "open" && evaluation?.status === "invalidated") {
      setProposalStatus(proposal.id, "invalidated", "Expenses changed after the proposal was made.").catch(() => {});
    }
  }, [proposal, evaluation?.status]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await work();
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const propose = useCallback(
    (ttlMs?: number) =>
      run(async () => {
        if (!publicKey) throw new Error("Connect your wallet to propose a settlement.");
        await createProposal(buildProposalSnapshot({ trip, expenses, creatorWallet: publicKey, ttlMs }));
      }),
    [run, publicKey, trip, expenses],
  );

  const respond = useCallback(
    (decision: ProposalDecision, reason?: string) =>
      run(async () => {
        if (!proposal || !evaluation || !publicKey) throw new Error("There is no proposal to answer.");
        const valid = validateResponse(proposal, evaluation, publicKey, decision, reason);
        if (!valid.ok) throw new Error(valid.message);
        await respondToProposal({
          proposalId: proposal.id,
          memberId: valid.memberId,
          wallet: publicKey,
          decision,
          reason: valid.reason,
          contentHash: proposal.contentHash,
        });
      }),
    [run, proposal, evaluation, publicKey],
  );

  const revoke = useCallback(
    (reason?: string) =>
      run(async () => {
        if (!proposal) return;
        if (proposal.creatorWallet !== publicKey) throw new Error("Only the member who proposed it can revoke it.");
        await setProposalStatus(proposal.id, "revoked", reason?.trim() || null);
      }),
    [run, proposal, publicKey],
  );

  return { proposal, responses, evaluation, loaded, busy, propose, respond, revoke, reload };
}
