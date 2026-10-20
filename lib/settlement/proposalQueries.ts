/**
 * Storage for settlement proposals (#328). RLS scopes every read and write to
 * trip members; the rules live in ./proposal.
 */

import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { toDatabaseError } from "@/lib/supabase/queries";
import type { Json, SettlementProposalResponseRow, SettlementProposalRow } from "@/types/supabase";
import {
  proposalContentHash,
  type ProposalDecision,
  type ProposalResponse,
  type ProposalSnapshot,
  type SettlementProposal,
} from "./proposal";

const PROPOSAL_COLUMNS =
  "id, trip_id, creator_wallet, content_hash, snapshot, status, expires_at, revoked_reason, created_at, updated_at";
const RESPONSE_COLUMNS = "id, proposal_id, member_id, wallet, decision, reason, content_hash, created_at";

export function rowToProposal(row: SettlementProposalRow): SettlementProposal {
  return {
    id: row.id,
    tripId: row.trip_id,
    creatorWallet: row.creator_wallet,
    contentHash: row.content_hash,
    snapshot: row.snapshot as unknown as ProposalSnapshot,
    status: row.status,
    expiresAt: row.expires_at,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
  };
}

export function rowToResponse(row: SettlementProposalResponseRow): ProposalResponse {
  return {
    memberId: row.member_id,
    wallet: row.wallet,
    decision: row.decision,
    reason: row.reason,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

/** The trip's most recent proposal and every response to it, or null. */
export async function fetchLatestProposal(
  tripId: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<{ proposal: SettlementProposal; responses: ProposalResponse[] } | null> {
  const { data, error } = await client
    .from("settlement_proposals")
    .select(PROPOSAL_COLUMNS)
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toDatabaseError(error, "load the settlement proposal");
  if (!data) return null;

  const proposal = rowToProposal(data as SettlementProposalRow);
  const { data: responses, error: responseError } = await client
    .from("settlement_proposal_responses")
    .select(RESPONSE_COLUMNS)
    .eq("proposal_id", proposal.id)
    .order("created_at", { ascending: true });
  if (responseError) throw toDatabaseError(responseError, "load proposal responses");

  return { proposal, responses: (responses ?? []).map((r) => rowToResponse(r as SettlementProposalResponseRow)) };
}

/** Freezes a new proposal, superseding any open one for the trip. */
export async function createProposal(
  snapshot: ProposalSnapshot,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<SettlementProposal> {
  const { error: supersedeError } = await client
    .from("settlement_proposals")
    .update({ status: "superseded" })
    .eq("trip_id", snapshot.tripId)
    .eq("status", "open");
  if (supersedeError) throw toDatabaseError(supersedeError, "supersede the previous proposal");

  const { data, error } = await client
    .from("settlement_proposals")
    .insert({
      trip_id: snapshot.tripId,
      creator_wallet: snapshot.creatorWallet,
      content_hash: proposalContentHash(snapshot),
      snapshot: snapshot as unknown as Json,
      expires_at: snapshot.expiresAt,
    })
    .select(PROPOSAL_COLUMNS)
    .single();
  if (error || !data) throw toDatabaseError(error!, "create the settlement proposal");
  return rowToProposal(data as SettlementProposalRow);
}

export async function respondToProposal(
  input: {
    proposalId: string;
    memberId: string;
    wallet: string;
    decision: ProposalDecision;
    reason: string | null;
    contentHash: string;
  },
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<ProposalResponse> {
  const { data, error } = await client
    .from("settlement_proposal_responses")
    .insert({
      proposal_id: input.proposalId,
      member_id: input.memberId,
      wallet: input.wallet,
      decision: input.decision,
      reason: input.reason,
      content_hash: input.contentHash,
    })
    .select(RESPONSE_COLUMNS)
    .single();
  if (error || !data) throw toDatabaseError(error!, "record your response");
  return rowToResponse(data as SettlementProposalResponseRow);
}

export async function setProposalStatus(
  proposalId: string,
  status: "revoked" | "invalidated",
  reason: string | null,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<void> {
  const { error } = await client
    .from("settlement_proposals")
    .update({ status, revoked_reason: reason })
    .eq("id", proposalId)
    .eq("status", "open");
  if (error) throw toDatabaseError(error, "update the settlement proposal");
}
