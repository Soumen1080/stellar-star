import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import {
  generateChallengeSignature,
  signWalletSession,
  SESSION_TTL_SECONDS,
} from "@/lib/supabase/serverAuth";
import {
  createServerClientForToken,
  createServiceRoleClient,
  isServerSupabaseConfigured,
  type ServerClient,
} from "@/lib/supabase/server";
import { consumeChallenge } from "@/lib/auth/challengeStore";
import type { UserUpdate } from "@/types/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USER_COLUMNS = "id, wallet_address, display_name, created_at, updated_at, last_login_at";
const CHALLENGE_DATA_NAME = "StellarStar Auth";
const MAX_DISPLAY_NAME = 60;

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function jsonError(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

/**
 * Creates or refreshes the wallet's profile row.
 *
 * Runs with the session token this request just minted, so it is subject to the
 * same RLS policies the browser would be — the server cannot write anything the
 * user could not write themselves. The service-role client is used only when
 * one is configured, purely to skip a redundant policy evaluation.
 *
 * Doing this here rather than in the browser is what fixes sign-up: the profile
 * is created in the same round trip that proves wallet ownership, so there is
 * no window in which the client holds a token but has no row, and no second
 * request that can fail on its own and leave the account half-created.
 */
async function provisionProfile(
  client: ServerClient,
  walletAddress: string,
  displayName: string | null
) {
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await client
    .from("users")
    .select(USER_COLUMNS)
    .eq("wallet_address", walletAddress)
    .maybeSingle();

  if (readError) return { user: null, error: readError };

  if (existing) {
    // Sign-in, or a sign-up against a wallet that already has a profile.
    // A blank display name never overwrites the stored one.
    const patch: UserUpdate = { last_login_at: now };
    if (displayName && displayName !== existing.display_name) {
      patch.display_name = displayName;
    }

    const { data, error } = await client
      .from("users")
      .update(patch)
      .eq("wallet_address", walletAddress)
      .select(USER_COLUMNS)
      .single();

    return { user: data ?? existing, error: error ?? null };
  }

  if (!displayName) {
    // Sign-in against a wallet that has never signed up.
    return { user: null, error: null };
  }

  const { data, error } = await client
    .from("users")
    .upsert(
      {
        wallet_address: walletAddress,
        display_name: displayName,
        last_login_at: now,
      },
      { onConflict: "wallet_address" }
    )
    .select(USER_COLUMNS)
    .single();

  return { user: data, error };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, signedXdr, nonce, expiration, signature, displayName } = body ?? {};

    if (
      typeof address !== "string" ||
      typeof signedXdr !== "string" ||
      typeof nonce !== "string" ||
      !Number.isSafeInteger(expiration) ||
      typeof signature !== "string" ||
      !address ||
      !signedXdr ||
      !nonce ||
      !signature
    ) {
      return jsonError("Missing required parameters", 400);
    }

    if (displayName !== undefined && displayName !== null && typeof displayName !== "string") {
      return jsonError("Invalid display name", 400);
    }

    const trimmedName =
      typeof displayName === "string" ? displayName.trim().slice(0, MAX_DISPLAY_NAME) : "";

    // 1. The challenge must be one this deployment minted (HMAC over its fields).
    const expectedSignature = generateChallengeSignature(address, nonce, expiration);
    if (!timingSafeStringEqual(signature, expectedSignature)) {
      return jsonError("Challenge verification failed (signature mismatch)", 400);
    }

    // 2. ...and must still be within its validity window.
    if (Date.now() > expiration) {
      return jsonError("Challenge has expired. Please try again.", 400);
    }

    // 3. Decode the signed transaction.
    let tx;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    } catch {
      return jsonError("Failed to parse transaction XDR", 400);
    }

    // Auth challenges are plain transactions; a fee-bump wrapper exposes no source.
    if (!("source" in tx)) {
      return jsonError("Invalid transaction type", 400);
    }

    if (tx.source !== address) {
      return jsonError("Transaction source account mismatch", 400);
    }

    const op = tx.operations[0];
    if (
      tx.operations.length !== 1 ||
      !op ||
      op.type !== "manageData" ||
      op.name !== CHALLENGE_DATA_NAME ||
      !op.value ||
      op.value.toString() !== nonce
    ) {
      return jsonError("Invalid challenge operation parameters", 400);
    }

    // 4. The wallet's signature over the challenge must verify against its key.
    const keypair = Keypair.fromPublicKey(address);
    const txHash = tx.hash();
    const hasValidSignature = tx.signatures.some((sig) => {
      try {
        return keypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!hasValidSignature) {
      return jsonError("Signature verification failed", 401);
    }

    // 5. Burn the challenge. Done after signature validation so a failed attempt
    //    does not consume a challenge the legitimate owner could still use.
    if (!consumeChallenge(address, nonce, expiration)) {
      return jsonError("Challenge is invalid or has already been used", 400);
    }

    // ── Wallet ownership is proven from here on. ──────────────────────────────

    // 6. Mint a short-lived session keyed to the wallet. `sub` is replaced with
    //    the profile's UUID below once we know it, so downstream consumers get
    //    a stable primary key rather than an address.
    let token = signWalletSession(address);

    if (!isServerSupabaseConfigured()) {
      return NextResponse.json(
        {
          token,
          user: null,
          expiresIn: SESSION_TTL_SECONDS,
          warning: "Supabase is not configured; the session is not backed by a stored profile.",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // 7. Create or refresh the profile in the same round trip.
    const client = createServiceRoleClient() ?? createServerClientForToken(token);
    const { user, error } = await provisionProfile(client, address, trimmedName || null);

    if (error) {
      const missingTable =
        error.code === "PGRST205" ||
        /schema cache/i.test(error.message) ||
        /relation .* does not exist/i.test(error.message);

      if (missingTable) {
        return jsonError(
          "The database is not set up yet. Run supabase-setup.sql in your Supabase SQL Editor, then try again.",
          503,
          "DB_NOT_SET_UP"
        );
      }
      console.error("[auth/verify] Failed to provision profile:", error);
      return jsonError(error.message || "Could not load your account.", 500, error.code);
    }

    if (!user) {
      // Sign-in for a wallet with no profile. Deliberately not an error the
      // client has to string-match: it gets a flag it can branch on.
      return NextResponse.json(
        { token: null, user: null, needsSignUp: true },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Re-mint with the profile UUID as the subject now that it is known.
    token = signWalletSession(address, user.id);

    return NextResponse.json(
      {
        token,
        expiresIn: SESSION_TTL_SECONDS,
        user: {
          id: user.id,
          walletAddress: user.wallet_address,
          displayName: user.display_name,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
          lastLoginAt: user.last_login_at,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error: any) {
    console.error("[auth/verify] Verification error:", error);
    return jsonError(error?.message || "Failed to verify challenge", 500);
  }
}
