import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { generateChallengeSignature, signSupabaseJwt } from "@/lib/supabase/serverAuth";
import { supabase } from "@/lib/supabase/client";
import { consumeChallenge } from "@/lib/auth/challengeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, signedXdr, nonce, expiration, signature } = body;

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
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
    }

    // 1. Re-calculate and verify challenge signature (HMAC) to ensure it wasn't forged
    const expectedSignature = generateChallengeSignature(address, nonce, expiration);
    if (typeof signature !== "string" || !timingSafeStringEqual(signature, expectedSignature)) {
      return NextResponse.json({ error: "Challenge verification failed (signature mismatch)" }, { status: 400 });
    }

    // 2. Check expiration
    if (Date.now() > expiration) {
      return NextResponse.json({ error: "Challenge has expired" }, { status: 400 });
    }

    // 3. Decode transaction XDR and verify signature
    let tx;
    try {
      tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    } catch (err: any) {
      return NextResponse.json({ error: "Failed to parse transaction XDR" }, { status: 400 });
    }

    // Auth challenges must be standard transactions; fee-bump wrappers do not expose source.
    if (!("source" in tx)) {
      return NextResponse.json({ error: "Invalid transaction type" }, { status: 400 });
    }

    // Ensure the source account matches the address
    if (tx.source !== address) {
      return NextResponse.json({ error: "Transaction source account mismatch" }, { status: 400 });
    }

    // Ensure the operation matches the nonce
    const op = tx.operations[0];
    if (
      tx.operations.length !== 1 ||
      !op ||
      op.type !== "manageData" ||
      op.name !== "StellarStar Auth" ||
      !op.value ||
      op.value.toString() !== nonce
    ) {
      return NextResponse.json({ error: "Invalid challenge operation parameters" }, { status: 400 });
    }

    // Verify client signature
    const keypair = Keypair.fromPublicKey(address);
    const txHash = tx.hash();
    const hasValidSignature = tx.signatures.some(sig => {
      try {
        return keypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!hasValidSignature) {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    // HMAC validation proves the challenge was minted by this deployment;
    // consuming it after wallet-signature validation prevents reusing the
    // same signed XDR to mint another session on this server instance.
    if (!consumeChallenge(address, nonce, expiration)) {
      return NextResponse.json(
        { error: "Challenge is invalid or has already been used" },
        { status: 400 }
      );
    }

    // 4. Query user database to fetch user's UUID for sub claim (if they exist).
    // Non-fatal: a transient/unreachable database should not block issuing a
    // session for a wallet signature we already verified cryptographically -
    // it just falls back to using the wallet address as the subject claim.
    let userId = address; // fallback sub
    if (supabase) {
      try {
        const { data } = await supabase
          .from("users")
          .select("id")
          .eq("wallet_address", address)
          .single();
        if (data) {
          userId = data.id;
        }
      } catch {
        // proceed with fallback sub
      }
    }

    // 5. Generate Supabase compatible JWT token
    const token = signSupabaseJwt({
      aud: "authenticated",
      role: "authenticated",
      sub: userId,
      wallet_address: address,
    }, 24 * 60 * 60); // 24 hours session token

    return NextResponse.json({ token });
  } catch (error: any) {
    console.error("Verification error:", error);
    return NextResponse.json({ error: error.message || "Failed to verify challenge" }, { status: 500 });
  }
}
