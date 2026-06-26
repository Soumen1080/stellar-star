import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Keypair } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { generateChallengeSignature, signSupabaseJwt } from "@/lib/supabase/serverAuth";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address, signedXdr, nonce, expiration, signature } = body;

    if (!address || !signedXdr || !nonce || !expiration || !signature) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
    }

    // 1. Re-calculate and verify challenge signature (HMAC) to ensure it wasn't forged
    const expectedSignature = generateChallengeSignature(address, nonce, expiration);
    if (signature !== expectedSignature) {
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
    const hasValidSignature = tx.signatures.some(sig => {
      try {
        return keypair.verify(tx.signatureBase(), sig.signature());
      } catch {
        return false;
      }
    });

    if (!hasValidSignature) {
      return NextResponse.json({ error: "Signature verification failed" }, { status: 401 });
    }

    // 4. Query user database to fetch user's UUID for sub claim (if they exist)
    let userId = address; // fallback sub
    if (supabase) {
      const { data } = await supabase
        .from("users")
        .select("id")
        .eq("wallet_address", address)
        .single();
      if (data) {
        userId = data.id;
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
