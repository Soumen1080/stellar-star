import { generateInviteToken, hashToken, buildInviteUrl } from "./tokens";
import { requireSupabaseClient, requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { isValidStellarAddress } from "@/lib/split/calculator";
import type { TripInvite, TripInviteSummary, Trip } from "@/types/trip";
import type { Member } from "@/types/expense";

export interface CreateInviteParams {
  tripId: string;
  createdByWallet: string;
  memberId?: string | null;
  maxUses?: number;
  expiresInDays?: number;
  baseUrl?: string;
}

export interface CreateInviteResult {
  invite: TripInvite;
  token: string;
  inviteUrl: string;
}

export interface ClaimInviteResult {
  success: boolean;
  tripId: string;
  tripName: string;
  memberId: string;
  memberName: string;
  error?: string;
}

/**
 * Creates a new capability-based invitation token for a trip or specific placeholder member.
 */
export async function createTripInvite(
  params: CreateInviteParams,
  client?: StellarStarClient,
): Promise<CreateInviteResult> {
  const db = client ?? requireAuthenticatedClient();
  const token = generateInviteToken();
  const tokenHash = hashToken(token);

  const expiresInDays = params.expiresInDays && params.expiresInDays > 0 ? params.expiresInDays : 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const maxUses = params.maxUses && params.maxUses > 0 ? params.maxUses : 1;

  const { data, error } = await db
    .from("trip_invites")
    .insert({
      trip_id: params.tripId,
      token_hash: tokenHash,
      member_id: params.memberId || null,
      created_by_wallet: params.createdByWallet,
      expires_at: expiresAt,
      max_uses: maxUses,
      uses: 0,
      revoked: false,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create invite: ${error?.message || "unknown database error"}`);
  }

  const invite: TripInvite = {
    id: data.id,
    tripId: data.trip_id,
    tokenHash: data.token_hash,
    memberId: data.member_id,
    createdByWallet: data.created_by_wallet,
    expiresAt: data.expires_at,
    maxUses: data.max_uses,
    uses: data.uses,
    revoked: data.revoked,
    revokedAt: data.revoked_at,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };

  const inviteUrl = buildInviteUrl(token, params.baseUrl);

  return { invite, token, inviteUrl };
}

/**
 * Verifies an invite token and returns public trip metadata along with available placeholder slots.
 */
export async function verifyTripInvite(
  token: string,
  client?: StellarStarClient,
): Promise<TripInviteSummary> {
  const cleanToken = (token ?? "").trim();
  if (!cleanToken) {
    throw new Error("Invitation token is required.");
  }

  const tokenHash = hashToken(cleanToken);
  const db = client ?? requireSupabaseClient();

  // Query invite record by token hash
  const { data: inviteData, error: inviteError } = await db
    .from("trip_invites")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (inviteError || !inviteData) {
    throw new Error("Invalid or unrecognized invitation link.");
  }

  const isRevoked = Boolean(inviteData.revoked);
  const isExpired = new Date(inviteData.expires_at).getTime() <= Date.now();
  const isExhausted = inviteData.uses >= inviteData.max_uses;

  if (isRevoked) {
    throw new Error("This invitation has been revoked.");
  }
  if (isExpired) {
    throw new Error("This invitation has expired.");
  }
  if (isExhausted) {
    throw new Error("This invitation has already reached its maximum uses.");
  }

  // Fetch public trip details
  const { data: tripData, error: tripError } = await db
    .from("trips")
    .select("id, name, description, members")
    .eq("id", inviteData.trip_id)
    .single();

  if (tripError || !tripData) {
    throw new Error("The trip associated with this invite no longer exists.");
  }

  const members = (Array.isArray(tripData.members) ? tripData.members : []) as unknown as Member[];
  const unclaimedMembers = members
    .filter((m) => !m.walletAddress || m.walletAddress.trim() === "")
    .map((m) => ({ id: m.id, name: m.name }));

  let memberName: string | null = null;
  if (inviteData.member_id) {
    const target = members.find((m) => m.id === inviteData.member_id);
    if (target) memberName = target.name;
  }

  return {
    inviteId: inviteData.id,
    tripId: tripData.id,
    tripName: tripData.name,
    tripDescription: tripData.description || undefined,
    memberId: inviteData.member_id,
    memberName,
    inviterWallet: inviteData.created_by_wallet,
    expiresAt: inviteData.expires_at,
    unclaimedMembers,
    isExpired,
    isRevoked,
    isExhausted,
  };
}

/**
 * Claims a member slot on a trip using an invite token.
 * Validates wallet address, prevents race conditions, and updates trip & expenses.
 */
export async function claimTripInvite(
  token: string,
  claimingWallet: string,
  selectedMemberId?: string,
  client?: StellarStarClient,
): Promise<ClaimInviteResult> {
  const cleanWallet = (claimingWallet ?? "").trim();
  if (!cleanWallet || !isValidStellarAddress(cleanWallet)) {
    throw new Error("Invalid Stellar wallet address provided for claim.");
  }

  const cleanToken = (token ?? "").trim();
  if (!cleanToken) {
    throw new Error("Invitation token is required.");
  }

  const tokenHash = hashToken(cleanToken);
  const db = client ?? requireAuthenticatedClient();

  // Invoke atomic stored procedure in PostgreSQL
  const { data, error } = await db.rpc("claim_trip_invite", {
    p_token_hash: tokenHash,
    p_claiming_wallet: cleanWallet,
    p_selected_member_id: selectedMemberId || undefined,
  });

  if (error) {
    const msg = error.message || "Failed to claim invitation.";
    if (msg.includes("SLOT_ALREADY_CLAIMED")) {
      throw new Error("This member slot has already been claimed by another wallet.");
    }
    if (msg.includes("INVITE_REVOKED")) {
      throw new Error("This invitation has been revoked.");
    }
    if (msg.includes("INVITE_EXPIRED")) {
      throw new Error("This invitation has expired.");
    }
    if (msg.includes("INVITE_EXHAUSTED")) {
      throw new Error("This invitation has already reached its maximum uses.");
    }
    throw new Error(msg);
  }

  const res = data as {
    success: boolean;
    trip_id: string;
    trip_name: string;
    member_id: string;
    member_name: string;
  };

  return {
    success: true,
    tripId: res.trip_id,
    tripName: res.trip_name,
    memberId: res.member_id,
    memberName: res.member_name,
  };
}

/**
 * Revokes an existing invitation immediately.
 */
export async function revokeTripInvite(
  inviteId: string,
  callerWallet: string,
  client?: StellarStarClient,
): Promise<boolean> {
  const db = client ?? requireAuthenticatedClient();

  const { error } = await db
    .from("trip_invites")
    .update({
      revoked: true,
      revoked_at: new Date().toISOString(),
    })
    .eq("id", inviteId)
    .eq("created_by_wallet", callerWallet);

  if (error) {
    throw new Error(`Failed to revoke invitation: ${error.message}`);
  }

  return true;
}

/**
 * Fetches all active and past invitations for a trip.
 */
export async function fetchTripInvites(
  tripId: string,
  callerWallet: string,
  client?: StellarStarClient,
): Promise<TripInvite[]> {
  const db = client ?? requireAuthenticatedClient();

  const { data, error } = await db
    .from("trip_invites")
    .select("*")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });

  if (error) {
    console.warn("[fetchTripInvites] error:", error.message);
    return [];
  }

  return (data || []).map((row) => ({
    id: row.id,
    tripId: row.trip_id,
    tokenHash: row.token_hash,
    memberId: row.member_id,
    createdByWallet: row.created_by_wallet,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    uses: row.uses,
    revoked: row.revoked,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
