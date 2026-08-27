/**
 * Releasing a sponsorship.
 *
 * Invariant 3 wants revocation implemented rather than described, so this
 * endpoint builds, signs, and *submits* the revocation — it is the operational
 * path by which the sponsor's locked XLM actually comes back.
 *
 * Two callers are allowed, for different reasons:
 *
 *  - **The sponsored user themselves.** Once they can cover their own reserve
 *    they may want independence from the sponsor, and nothing should stand in
 *    the way of that. Invariant 4 is about control, and refusing to let someone
 *    off a sponsorship is a form of holding them.
 *  - **The operator**, via a shared secret, to reclaim capacity from accounts
 *    that have been idle past the reclaim window.
 *
 * Revocation never takes anything from the user. If the account cannot cover
 * its own reserve the network rejects the operation and the sponsorship simply
 * stands.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, HORIZON_URL } from "@/lib/utils/constants";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { parseAssetKey, type AssetRef } from "@/lib/stellar/assets";
import {
  isSponsorConfigured,
  loadSponsorKeypair,
  sponsorPublicKey,
} from "@/lib/onboarding/sponsorKey";
import {
  buildSponsorshipRevocation,
  signAsSponsor,
} from "@/lib/onboarding/sponsorTransactions";
import {
  getSponsorship,
  listReclaimable,
  markRevoked,
  SPONSORSHIP_IDLE_RECLAIM_MS,
} from "@/lib/onboarding/sponsorshipLedger";
import { releaseInvite } from "@/lib/onboarding/abuseResistance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Submits a signed transaction to Horizon. */
async function submit(signedXdr: string): Promise<{ hash: string }> {
  const response = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: signedXdr }).toString(),
  });

  const result = (await response.json()) as {
    hash?: string;
    extras?: { result_codes?: { operations?: string[]; transaction?: string } };
  };

  if (!response.ok || !result.hash) {
    const codes = result.extras?.result_codes;
    throw new Error(
      `Revocation rejected by the network: ${
        codes?.operations?.join(", ") ?? codes?.transaction ?? "unknown reason"
      }`,
    );
  }

  return { hash: result.hash };
}

export async function POST(request: NextRequest) {
  if (!isSponsorConfigured()) {
    return jsonError("Sponsorship is not configured on this deployment.", 503);
  }

  let body: { account?: unknown; assetKey?: unknown; operatorSecret?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const { account, assetKey, operatorSecret } = body;

  if (typeof account !== "string" || !StrKey.isValidEd25519PublicKey(account)) {
    return jsonError("A valid Stellar address is required.", 400);
  }

  let asset: AssetRef | undefined;
  if (typeof assetKey === "string") {
    try {
      asset = parseAssetKey(assetKey);
    } catch {
      return jsonError("Malformed asset key.", 400);
    }
  }

  const record = await getSponsorship(account);
  if (!record || record.status !== "active") {
    return jsonError("No active sponsorship for that account.", 404);
  }

  // ── Authorisation: the sponsored user, or the operator ─────────────────────
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  const isSponsoredUser = session?.wallet_address === account;

  const configuredOperatorSecret = process.env.SPONSOR_OPERATOR_SECRET?.trim();
  const isOperator =
    typeof operatorSecret === "string" &&
    Boolean(configuredOperatorSecret) &&
    timingSafeEqual(operatorSecret, configuredOperatorSecret as string);

  if (!isSponsoredUser && !isOperator) {
    return jsonError(
      "Only the sponsored account holder or the operator can release a sponsorship.",
      403,
    );
  }

  // The operator may only reclaim genuinely idle sponsorships. Without this an
  // operator key could cut off active users, which is a worse failure than a
  // slowly filling cap.
  if (isOperator && !isSponsoredUser) {
    const reclaimable = await listReclaimable();
    if (!reclaimable.some((r) => r.account === account)) {
      const idleDays = Math.round(SPONSORSHIP_IDLE_RECLAIM_MS / (24 * 60 * 60 * 1000));
      return jsonError(
        `That sponsorship is still active. Operators may only reclaim accounts idle for ` +
          `more than ${idleDays} days.`,
        409,
      );
    }
  }

  // ── Build, sign, submit ────────────────────────────────────────────────────
  try {
    const { xdr } = await buildSponsorshipRevocation({
      sponsorPublicKey: sponsorPublicKey(),
      sponsoredAccount: account,
      asset,
    });

    const signed = signAsSponsor(xdr, loadSponsorKeypair());
    // Parsed back to fail loudly here rather than at Horizon on a malformed build.
    TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE);

    const { hash } = await submit(signed);

    // Ledger updated only after the network accepted it — marking it revoked
    // first would free cap headroom for reserves that are still locked.
    await markRevoked(account);
    await releaseInvite(record.sponsoredBy, account).catch(() => {});

    return NextResponse.json(
      {
        revoked: true,
        hash,
        releasedStroops: record.lockedStroops,
        message: "Sponsorship released. The account is now self-supporting.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Revocation failed.";
    // The most common cause: the account cannot yet cover its own reserve. That
    // is not an error state for the user — the sponsorship simply continues.
    return jsonError(message, 409, { sponsorshipRetained: true });
  }
}

/** Sponsorships eligible for reclamation, for an operator dashboard or cron. */
export async function GET(request: NextRequest) {
  const configuredOperatorSecret = process.env.SPONSOR_OPERATOR_SECRET?.trim();
  const provided = request.headers.get("x-operator-secret") ?? "";

  if (!configuredOperatorSecret || !timingSafeEqual(provided, configuredOperatorSecret)) {
    return jsonError("Operator authorisation required.", 403);
  }

  const reclaimable = await listReclaimable();

  return NextResponse.json(
    {
      reclaimable: reclaimable.map((r) => ({
        account: r.account,
        lockedStroops: r.lockedStroops,
        lastActiveAt: r.lastActiveAt,
        sponsoredBy: r.sponsoredBy,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
