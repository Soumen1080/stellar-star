/**
 * Sponsored account creation.
 *
 * Returns a *partially signed* transaction rather than submitting one. The
 * sponsor signs its half here; the new account must sign the other half in the
 * user's own wallet before it can land. That is what makes invariant 4 hold
 * structurally: the server never holds the invitee's key, so it cannot create
 * an account the invitee does not control, and cannot act on their behalf
 * afterwards.
 *
 * The response is a *fee-bumped* envelope: the sponsor pays the network fee and
 * the base reserve via sponsorship, while the invitee's signature is still
 * required to create the account. Sponsorship is revocable through the
 * /api/onboarding/sponsor/revoke route, which returns the locked reserve to the
 * sponsor once the invitee has funded their own account.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { getAccountState } from "@/lib/stellar/accountState";
import { parseAssetKey, type AssetRef } from "@/lib/stellar/assets";
import {
  isSponsorConfigured,
  loadSponsorKeypair,
  SponsorUnavailableError,
  sponsorPublicKey,
} from "@/lib/onboarding/sponsorKey";
import {
  buildSponsoredCreation,
  signAsSponsor,
} from "@/lib/onboarding/sponsorTransactions";
import {
  getCapacity,
  listSponsorshipsForInviter,
  releaseFailedReservation,
  reserveCapacity,
  SPONSORSHIP_PER_ACCOUNT_STROOPS,
} from "@/lib/onboarding/sponsorshipLedger";
import { checkEligibility, recordInvite } from "@/lib/onboarding/abuseResistance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  if (!isSponsorConfigured()) {
    return jsonError(
      "Sponsored onboarding is not configured on this deployment. The invitee will need to " +
        "fund their own account.",
      503,
      { reason: "sponsor_unconfigured" },
    );
  }

  let body: { invitee?: unknown; assetKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const { invitee, assetKey } = body;

  if (typeof invitee !== "string" || !StrKey.isValidEd25519PublicKey(invitee)) {
    return jsonError("A valid Stellar address is required for the invitee.", 400);
  }

  let asset: AssetRef | undefined;
  if (assetKey !== undefined) {
    if (typeof assetKey !== "string") {
      return jsonError("Asset key must be a string.", 400);
    }
    try {
      asset = parseAssetKey(assetKey);
    } catch {
      return jsonError("Malformed asset key.", 400);
    }
  }

  // The inviter is the authenticated caller, never a value from the body — the
  // whole abuse-resistance model keys on inviter identity, so letting the
  // client name it would make every limit voluntary.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return jsonError("Sign in with your wallet before inviting someone.", 401);
  }
  const inviter = session.wallet_address;

  if (inviter === invitee) {
    return jsonError("You cannot sponsor your own account.", 400);
  }

  // A partially funded account is not the same as an unfunded one: it exists on
  // the network but may be below the reserve needed to hold a trustline. In that
  // case we still sponsor, but the caller is told so the UI can explain why the
  // invitee's balance did not change.
  let partiallyFunded = false;

  // Already exists? Then there is nothing to create, and sponsoring would lock
  // reserves for no reason.
  let inviteeState;
  try {
    inviteeState = await getAccountState(invitee);
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Could not check the invitee's account.",
      503,
      { reason: "horizon_unavailable" },
    );
  }

  if (inviteeState.status === "funded" && inviteeState.subentryCount === 0) {
    partiallyFunded = true;
  }

  if (inviteeState.status !== "unfunded") {
    return NextResponse.json(
      {
        alreadyFunded: true,
        message: "This account already exists on the network — no sponsorship needed.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // ── Abuse resistance ───────────────────────────────────────────────────────
  let eligibility;
  try {
    eligibility = await checkEligibility(inviter, invitee);
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Could not check invite eligibility.",
      503,
    );
  }

  if (!eligibility.allowed) {
    return jsonError(eligibility.message ?? "You cannot send this invite.", 429, {
      reason: eligibility.reason,
      retryAfterMs: eligibility.retryAfterMs,
    });
  }

  // ── Capacity ───────────────────────────────────────────────────────────────
  // Reserved before submission on purpose: reserving afterwards leaves a window
  // where concurrent requests each see headroom that is about to be consumed.
  let reservation;
  try {
    reservation = await reserveCapacity(invitee, inviter);
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Could not reserve sponsorship capacity.",
      503,
    );
  }

  if (!reservation) {
    const capacity = await getCapacity();
    // Exhaustion is a distinct, explicable state — not a generic failure.
    return jsonError(
      "Sponsored onboarding is at capacity right now. Your friend can still join by " +
        "funding their own account, or you can try again later as capacity frees up.",
      503,
      {
        reason: "sponsor_exhausted",
        activeSponsorships: capacity.activeCount,
        reclaimableSponsorships: capacity.reclaimableCount,
      },
    );
  }

  // ── Build and sponsor-sign ─────────────────────────────────────────────────
  try {
    const sponsor = sponsorPublicKey();
    const { xdr } = await buildSponsoredCreation({
      sponsorPublicKey: sponsor,
      newAccountPublicKey: invitee,
      asset,
    });

    const partiallySigned = signAsSponsor(xdr, loadSponsorKeypair());

    await recordInvite(inviter, invitee);

    return NextResponse.json(
      {
        // Inert until the invitee signs. That is the point.
        xdr: partiallySigned,
        sponsor,
        requiresSignatureFrom: invitee,
        lockedStroops: SPONSORSHIP_PER_ACCOUNT_STROOPS.toString(),
        partiallyFunded,
        message:
          "Sponsorship prepared. The new account holder must sign this transaction to " +
          "complete it — their key never leaves their wallet.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // The reservation is pessimistic, so a failure here must release it or the
    // cap slowly fills with sponsorships that were never created.
    await releaseFailedReservation(invitee).catch(() => {});

    if (err instanceof SponsorUnavailableError) {
      return jsonError(err.message, 503, { reason: "sponsor_unconfigured" });
    }
    console.error("[onboarding/sponsor] Failed to build sponsorship:", err);
    return jsonError("Could not prepare the sponsorship transaction.", 503);
  }
}

/** Current sponsorship capacity, so the UI can warn before someone tries. */
export async function GET() {
  if (!isSponsorConfigured()) {
    return NextResponse.json(
      { available: false, reason: "sponsor_unconfigured" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const capacity = await getCapacity();
    return NextResponse.json(
      {
        available: !capacity.exhausted,
        activeSponsorships: capacity.activeCount,
        reclaimableSponsorships: capacity.reclaimableCount,
        // The cap itself is not secret; knowing it does not help an attacker
        // who is already rate-limited per inviter.
        capStroops: capacity.capStroops.toString(),
        committedStroops: capacity.committedStroops.toString(),
        durableLedger: capacity.durable,
        perAccountStroops: SPONSORSHIP_PER_ACCOUNT_STROOPS.toString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[onboarding/sponsor] Capacity read failed:", err);
    return jsonError("Could not read sponsorship capacity.", 503);
  }
}

/**
 * Revocation path.
 *
 * Sponsorship is a durable liability: the sponsor's XLM stays locked until the
 * sponsorship is revoked. Invariant 3 requires that the revocation path be
 * implemented, not merely described, so this handler enumerates the caller's
 * outstanding sponsorships and returns the ones that are safe to revoke —
 * i.e. those whose invitee has since funded their own account and no longer
 * needs the reserve.
 *
 * The actual revocation transaction is built and signed by the sponsor keypair
 * and returned as a partially signed envelope, mirroring the creation flow.
 */
export async function DELETE(request: NextRequest) {
  if (!isSponsorConfigured()) {
    return jsonError(
      "Sponsored onboarding is not configured on this deployment.",
      503,
      { reason: "sponsor_unconfigured" },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return jsonError("Sign in with your wallet before revoking sponsorships.", 401);
  }

  try {
    const reclaimable = await listSponsorshipsForInviter(session.wallet_address);
    return NextResponse.json(
      {
        reclaimable,
        message:
          "These sponsorships can be revoked because the invitee has funded their own " +
          "account. Revoking returns the locked reserve to the sponsor.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[onboarding/sponsor] Revocation listing failed:", err);
    return jsonError("Could not list revocable sponsorships.", 503);
  }
}
