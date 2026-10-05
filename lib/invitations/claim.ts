import { generateInviteToken, hashToken, buildInviteUrl } from "./tokens";
import { requireSupabaseClient, requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { isValidStellarAddress } from "@/lib/split/calculator";
import { normalizeWalletAddress } from "@/lib/trip/members";
import type { TripInvite, TripInviteSummary, Trip } from "@/types/trip";
import type { Member } from "@/types/expense";

/**
 * Resolves the client a helper should use.
 *
 * Every function here is callable from both the browser and a route handler.
 * In the browser, omitting `client` is the normal case and the shared
 * browser client is correct. On the server there is no `window`, so the
 * browser client's localStorage-backed session is unreachable and
 * `requireAuthenticatedClient()` would throw "your session has expired" — a
 * message that sends the user to re-authenticate over what is really a
 * server-side wiring mistake. Fail with something diagnosable instead.
 *
 * Server callers should pass a client from `lib/supabase/server`:
 * `createServerClientForToken(token)` to act as the verified wallet, or
 * `createServerAnonClient()` for a deliberately public read.
 */
function resolveClient(
  client: StellarStarClient | undefined,
  context: string,
  anonymous = false,
): StellarStarClient {
  if (client) return client;

  if (typeof window === "undefined") {
    throw new Error(
      `${context} was called on the server without a Supabase client. ` +
        "Pass one from lib/supabase/server (createServerClientForToken for an " +
        "authenticated wallet, createServerAnonClient for a public read).",
    );
  }

  return anonymous ? requireSupabaseClient() : requireAuthenticatedClient();
}

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
  const db = resolveClient(client, "createTripInvite");
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
 * True when the failure is "this function does not exist" rather than a raise
 * from inside it. PGRST202 is PostgREST's code for an unresolvable RPC; the
 * message patterns cover a schema cache that has not reloaded yet. Distinguishing
 * the two matters: a missing function means the migration has not been applied
 * and the caller should fall back, whereas a raise is a real verdict on the
 * invite and must be reported as-is.
 */
function isMissingRpc(error: { code?: string; message: string }): boolean {
  return (
    error.code === "PGRST202" ||
    /(could not find|unknown|undefined) function/i.test(error.message) ||
    /function .*verify_trip_invite.* does not exist/i.test(error.message) ||
    /schema cache/i.test(error.message)
  );
}

/** Maps a raise from verify_trip_invite onto the message the user should see. */
function inviteErrorMessage(raw: string): string {
  if (raw.includes("INVITE_REVOKED")) return "This invitation has been revoked.";
  if (raw.includes("INVITE_EXPIRED")) return "This invitation has expired.";
  if (raw.includes("INVITE_EXHAUSTED")) {
    return "This invitation has already reached its maximum uses.";
  }
  if (raw.includes("TRIP_NOT_FOUND")) {
    return "The trip associated with this invite no longer exists.";
  }
  if (raw.includes("INVITE_NOT_FOUND")) return "Invalid or unrecognized invitation link.";
  return raw || "Invalid or unrecognized invitation link.";
}

/**
 * Verifies an invite token and returns public trip metadata along with available placeholder slots.
 *
 * Goes through the `verify_trip_invite` RPC rather than reading the tables
 * directly. The person opening an invite link is not a member of the trip yet —
 * often not even signed in — so `trip_invites_select_members` and
 * `trips_select_members`, which both require `member_wallets` to contain
 * `current_wallet()`, match nothing for them. Selecting from those tables here
 * returned zero rows and every invite link 404'd. The RPC is SECURITY DEFINER
 * and returns only the fields below, so the token stays the whole capability.
 */
export async function verifyTripInvite(
  token: string,
  client?: StellarStarClient,
  expectedTripId?: string,
): Promise<TripInviteSummary> {
  const cleanToken = (token ?? "").trim();
  if (!cleanToken) {
    throw new Error("Invitation token is required.");
  }

  const tokenHash = hashToken(cleanToken);
  const db = resolveClient(client, "verifyTripInvite", true);

  const { data: rpcData, error: rpcError } = await db.rpc("verify_trip_invite", {
    p_token_hash: tokenHash,
  });

  if (!rpcError && rpcData) {
    const row = rpcData as {
      invite_id: string;
      trip_id: string;
      trip_name: string;
      trip_description: string | null;
      member_id: string | null;
      member_name: string | null;
      inviter_wallet: string;
      expires_at: string;
      unclaimed_members: Array<{ id: string; name: string }> | null;
    };

    if (expectedTripId && row.trip_id !== expectedTripId.trim()) {
      throw new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip.");
    }

    return {
      inviteId: row.invite_id,
      tripId: row.trip_id,
      tripName: row.trip_name,
      tripDescription: row.trip_description || undefined,
      memberId: row.member_id,
      memberName: row.member_name,
      inviterWallet: row.inviter_wallet,
      expiresAt: row.expires_at,
      unclaimedMembers: row.unclaimed_members ?? [],
      // The RPC raises on every invalid case, so reaching here means valid.
      isExpired: false,
      isRevoked: false,
      isExhausted: false,
    };
  }

  // A raise inside the function is the normal way an invalid invite is reported.
  if (rpcError && !isMissingRpc(rpcError)) {
    throw new Error(inviteErrorMessage(rpcError.message));
  }

  // The RPC is absent (migration 0005 not yet applied). Fall back to reading the
  // tables. That read is what issue #221 describes as RLS-blocked, so it only
  // succeeds for a caller who can already see the trip — a member previewing
  // their own invite, or a service-role client. Anyone else still gets the 404,
  // which is the pre-migration behaviour rather than a new failure.
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

  if (expectedTripId && inviteData.trip_id !== expectedTripId.trim()) {
    throw new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip.");
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
  expectedTripId?: string,
): Promise<ClaimInviteResult> {
  const cleanWallet = normalizeWalletAddress(claimingWallet ?? "");
  if (!cleanWallet || !isValidStellarAddress(cleanWallet)) {
    throw new Error("Invalid Stellar wallet address provided for claim.");
  }

  const cleanToken = (token ?? "").trim();
  if (!cleanToken) {
    throw new Error("Invitation token is required.");
  }

  const tokenHash = hashToken(cleanToken);
  const db = resolveClient(client, "claimTripInvite");

  // Invoke atomic stored procedure in PostgreSQL
  const { data, error } = await db.rpc("claim_trip_invite", {
    p_token_hash: tokenHash,
    p_claiming_wallet: cleanWallet,
    p_selected_member_id: selectedMemberId || undefined,
    p_expected_trip_id: expectedTripId || undefined,
  });

  if (!error && data) {
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

  if (error && !isMissingRpc(error)) {
    const msg = error.message || "Failed to claim invitation.";
    if (msg.includes("TRIP_MISMATCH")) {
      throw new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip.");
    }
    if (msg.includes("INVITE_MEMBER_MISMATCH")) {
      throw new Error("INVITE_MEMBER_MISMATCH: Invitation token is dedicated to a different member slot.");
    }
    if (msg.includes("WALLET_ALREADY_MEMBER")) {
      throw new Error("WALLET_ALREADY_MEMBER: This wallet is already a member of this trip.");
    }
    if (msg.includes("SLOT_ALREADY_CLAIMED")) {
      throw new Error("SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet.");
    }
    if (msg.includes("MEMBER_NOT_FOUND")) {
      throw new Error("MEMBER_NOT_FOUND: The selected member slot was not found in this trip.");
    }
    if (msg.includes("INVITE_REVOKED")) {
      throw new Error("INVITE_REVOKED: This invitation has been revoked.");
    }
    if (msg.includes("INVITE_EXPIRED")) {
      throw new Error("INVITE_EXPIRED: This invitation has expired.");
    }
    if (msg.includes("INVITE_EXHAUSTED")) {
      throw new Error("INVITE_EXHAUSTED: This invitation has already reached its maximum uses.");
    }
    if (msg.includes("TRIP_NOT_FOUND")) {
      throw new Error("TRIP_NOT_FOUND: Associated trip no longer exists.");
    }
    if (msg.includes("INVITE_NOT_FOUND")) {
      throw new Error("INVITE_NOT_FOUND: Invalid or unrecognized invitation token.");
    }
    throw new Error(msg);
  }

  // Fallback: If RPC is missing, execute claim via direct queries/mutations
  const { data: inviteData, error: inviteErr } = await db
    .from("trip_invites")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (inviteErr || !inviteData) {
    throw new Error("INVITE_NOT_FOUND: Invalid or unrecognized invitation token.");
  }
  if (inviteData.revoked) {
    throw new Error("INVITE_REVOKED: This invitation has been revoked.");
  }
  if (new Date(inviteData.expires_at).getTime() <= Date.now()) {
    throw new Error("INVITE_EXPIRED: This invitation has expired.");
  }
  if (inviteData.uses >= inviteData.max_uses) {
    throw new Error("INVITE_EXHAUSTED: This invitation has already reached its maximum uses.");
  }

  if (expectedTripId && inviteData.trip_id !== expectedTripId.trim()) {
    throw new Error("TRIP_MISMATCH: Invitation token does not belong to the specified trip.");
  }

  const { data: tripData, error: tripErr } = await db
    .from("trips")
    .select("*")
    .eq("id", inviteData.trip_id)
    .single();

  if (tripErr || !tripData) {
    throw new Error("TRIP_NOT_FOUND: Associated trip no longer exists.");
  }

  const members: Member[] = Array.isArray(tripData.members) ? [...tripData.members] : [];
  const targetMemberId = inviteData.member_id || selectedMemberId;

  // Single-membership check: ensure claiming wallet does not already hold another member slot in this trip
  for (const m of members) {
    const existingWallet = normalizeWalletAddress(m.walletAddress ?? "");
    if (existingWallet && existingWallet === cleanWallet) {
      if (targetMemberId && m.id === targetMemberId) {
        // Idempotent retry on the same slot
        return {
          success: true,
          tripId: tripData.id,
          tripName: tripData.name,
          memberId: m.id,
          memberName: m.name,
        };
      }
      throw new Error("WALLET_ALREADY_MEMBER: This wallet is already a member of this trip.");
    }
  }

  let targetMember: Member | undefined;
  if (targetMemberId) {
    targetMember = members.find((m) => m.id === targetMemberId);
    if (!targetMember) {
      throw new Error(`MEMBER_NOT_FOUND: Member slot ${targetMemberId} not found in trip.`);
    }
    if (targetMember.walletAddress && targetMember.walletAddress.trim() !== "") {
      const existingWallet = normalizeWalletAddress(targetMember.walletAddress);
      if (existingWallet === cleanWallet) {
        return {
          success: true,
          tripId: tripData.id,
          tripName: tripData.name,
          memberId: targetMember.id,
          memberName: targetMember.name,
        };
      }
      throw new Error("SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet.");
    }
    targetMember.walletAddress = cleanWallet;
  } else {
    targetMember = members.find((m) => !m.walletAddress || m.walletAddress.trim() === "");
    if (targetMember) {
      targetMember.walletAddress = cleanWallet;
    } else {
      targetMember = {
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
        name: `Member ${members.length + 1}`,
        walletAddress: cleanWallet,
      };
      members.push(targetMember);
    }
  }

  // Update trip members
  await db
    .from("trips")
    .update({ members })
    .eq("id", tripData.id);

  // Increment invite uses
  await db
    .from("trip_invites")
    .update({ uses: (inviteData.uses ?? 0) + 1 })
    .eq("id", inviteData.id);

  return {
    success: true,
    tripId: tripData.id,
    tripName: tripData.name,
    memberId: targetMember.id,
    memberName: targetMember.name,
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
  const db = resolveClient(client, "revokeTripInvite");

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
  const db = resolveClient(client, "fetchTripInvites");

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
