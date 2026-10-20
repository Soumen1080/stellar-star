/**
 * Database access for contacts (#322). Kept beside the domain logic, like
 * lib/invitations/claim.ts, and translated through the shared error mapping.
 */

import type { PostgrestError } from "@supabase/supabase-js";
import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { DatabaseError, toDatabaseError } from "@/lib/supabase/queries";
import { generateInviteToken, hashTokenWebCrypto } from "@/lib/invitations/tokens";
import { normalizeContactInput } from "@/lib/contacts/contacts";
import type { Contact, ContactInput, ContactWalletChange } from "@/types/contact";
import type { ContactRow, ContactWalletChangeRow } from "@/types/supabase";

const CONTACT_COLUMNS =
  "id, owner_wallet, display_name, wallet_address, wallet_verified, claimed_by_wallet, verified_at, invite_destination, invite_channel, claim_expires_at, created_at, updated_at";
const CHANGE_COLUMNS =
  "id, contact_id, owner_wallet, contact_name, old_wallet, new_wallet, status, affected_trip_ids, notice_until, verified, created_at, applied_at";

/** Claim links stay valid for a week, then the owner must issue a new one. */
export const CLAIM_LINK_TTL_DAYS = 7;

export function rowToContact(row: Omit<ContactRow, "claim_token_hash"> & { claim_token_hash?: string | null }): Contact {
  return {
    id: row.id,
    ownerWallet: row.owner_wallet,
    displayName: row.display_name,
    walletAddress: row.wallet_address ?? undefined,
    walletVerified: row.wallet_verified,
    claimedByWallet: row.claimed_by_wallet ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    inviteDestination: row.invite_destination ?? undefined,
    inviteChannel: row.invite_channel ?? undefined,
    hasPendingClaim: Boolean(row.claim_expires_at && Date.parse(row.claim_expires_at) > Date.now()),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToWalletChange(row: ContactWalletChangeRow): ContactWalletChange {
  return {
    id: row.id,
    contactId: row.contact_id,
    ownerWallet: row.owner_wallet,
    contactName: row.contact_name,
    oldWallet: row.old_wallet ?? undefined,
    newWallet: row.new_wallet,
    status: row.status,
    affectedTripIds: row.affected_trip_ids ?? [],
    noticeUntil: row.notice_until,
    verified: row.verified,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

/** Maps a raise from the contact functions onto a message worth showing. */
export function contactErrorMessage(raw: string): string {
  const messages: Array<[string, string]> = [
    ["CONTACT_DUPLICATE_WALLET", "You already have a contact with this wallet address."],
    ["CONTACT_WALLET_CHANGE_REQUIRES_NOTICE", "Change a saved wallet with “Change wallet” so affected trips are notified first."],
    ["CONTACT_NOTICE_PERIOD_ACTIVE", "Affected trips are still being notified. Try again after the notice period."],
    ["CONTACT_WALLET_UNCHANGED", "That is already this contact's wallet."],
    ["CONTACT_INVALID_WALLET", "Invalid Stellar address (must start with G, 56 chars)."],
    ["CONTACT_CLAIM_EXPIRED", "This claim link has expired. Ask for a new one."],
    ["CONTACT_CLAIM_INVALID", "This claim link is not valid or was already used."],
    ["CONTACT_CLAIM_SELF", "You created this contact — send the link to the person it describes."],
    ["CONTACT_CHANGE_NOT_PENDING", "That wallet change is no longer pending."],
    ["CONTACT_NOT_FOUND", "That contact no longer exists."],
  ];
  for (const [code, message] of messages) if (raw.includes(code)) return message;
  // A Postgres unique violation on the owner/wallet index.
  if (raw.includes("contacts_owner_wallet_unique_idx")) return messages[0][1];
  return raw;
}

function contactError(error: PostgrestError, action: string): DatabaseError {
  const raw = error.message ?? "";
  const friendly = contactErrorMessage(raw);
  return friendly !== raw ? new DatabaseError(friendly, error.code, error) : toDatabaseError(error, action);
}

export async function fetchContacts(
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<Contact[]> {
  const { data, error } = await client
    .from("contacts")
    .select(CONTACT_COLUMNS)
    .order("display_name", { ascending: true });
  if (error) throw contactError(error, "load your contacts");
  return (data ?? []).map((row) => rowToContact(row as ContactRow));
}

export async function insertContact(
  ownerWallet: string,
  input: ContactInput,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<Contact> {
  const clean = normalizeContactInput(input);
  const { data, error } = await client
    .from("contacts")
    .insert({
      owner_wallet: ownerWallet,
      display_name: clean.displayName,
      wallet_address: clean.walletAddress ?? null,
      invite_destination: clean.inviteDestination ?? null,
      invite_channel: clean.inviteChannel ?? null,
    })
    .select(CONTACT_COLUMNS)
    .single();
  if (error) throw contactError(error, "save this contact");
  return rowToContact(data as ContactRow);
}

/**
 * Edits name and invite details. A wallet can be *added* here when the
 * contact has none; replacing one goes through requestWalletChange.
 */
export async function updateContact(
  contact: Contact,
  input: ContactInput,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<Contact> {
  const clean = normalizeContactInput(input);
  const { data, error } = await client
    .from("contacts")
    .update({
      display_name: clean.displayName,
      invite_destination: clean.inviteDestination ?? null,
      invite_channel: clean.inviteChannel ?? null,
      ...(contact.walletAddress ? {} : { wallet_address: clean.walletAddress ?? null }),
    })
    .eq("id", contact.id)
    .select(CONTACT_COLUMNS)
    .single();
  if (error) throw contactError(error, "update this contact");
  return rowToContact(data as ContactRow);
}

export async function deleteContact(
  id: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<void> {
  const { error } = await client.from("contacts").delete().eq("id", id);
  if (error) throw contactError(error, "delete this contact");
}

/**
 * Issues a one-time claim link. Only the token's SHA-256 is stored; the
 * plaintext lives only in the returned URL.
 */
export async function createContactClaimLink(
  contactId: string,
  origin: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<{ url: string; expiresAt: string }> {
  const token = generateInviteToken();
  const tokenHash = await hashTokenWebCrypto(token);
  const expiresAt = new Date(Date.now() + CLAIM_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await client
    .from("contacts")
    .update({ claim_token_hash: tokenHash, claim_expires_at: expiresAt })
    .eq("id", contactId);
  if (error) throw contactError(error, "create a claim link");
  return { url: `${origin}/claim/${token}`, expiresAt };
}

export interface ClaimResult {
  status: "verified" | "pending_notice";
  contactName: string;
  ownerWallet: string;
  noticeUntil?: string;
}

/** Claims a contact entry as the signed-in wallet's owner. */
export async function claimContactProfile(
  token: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<ClaimResult> {
  const { data, error } = await client.rpc("claim_contact_profile", {
    p_token_hash: await hashTokenWebCrypto(token),
  });
  if (error) throw contactError(error, "claim this profile");
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    status: result.status === "verified" ? "verified" : "pending_notice",
    contactName: String(result.contact_name ?? ""),
    ownerWallet: String(result.owner_wallet ?? ""),
    noticeUntil: typeof result.notice_until === "string" ? result.notice_until : undefined,
  };
}

/** Wallet changes the session can see: its own, and those affecting its trips. */
export async function fetchWalletChanges(
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<ContactWalletChange[]> {
  const { data, error } = await client
    .from("contact_wallet_changes")
    .select(CHANGE_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw contactError(error, "load wallet changes");
  return (data ?? []).map((row) => rowToWalletChange(row as ContactWalletChangeRow));
}

export async function requestWalletChange(
  contactId: string,
  newWallet: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<ContactWalletChange> {
  const { data, error } = await client.rpc("request_contact_wallet_change", {
    p_contact_id: contactId,
    p_new_wallet: newWallet,
  });
  if (error) throw contactError(error, "request this wallet change");
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new DatabaseError("The wallet change could not be recorded.");
  return rowToWalletChange(row as ContactWalletChangeRow);
}

export async function applyWalletChange(
  changeId: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<Contact> {
  const { data, error } = await client.rpc("apply_contact_wallet_change", { p_change_id: changeId });
  if (error) throw contactError(error, "apply this wallet change");
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new DatabaseError("The wallet change could not be applied.");
  return rowToContact(row as ContactRow);
}

export async function cancelWalletChange(
  changeId: string,
  client: StellarStarClient = requireAuthenticatedClient(),
): Promise<void> {
  const { error } = await client.rpc("cancel_contact_wallet_change", { p_change_id: changeId });
  if (error) throw contactError(error, "cancel this wallet change");
}
