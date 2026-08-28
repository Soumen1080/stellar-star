import { NextRequest, NextResponse } from "next/server";
import { Account, TransactionBuilder, Memo, Operation, Keypair } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, TX_BASE_FEE } from "@/lib/utils/constants";
import { generateChallengeSignature, CHALLENGE_TTL_MS } from "@/lib/supabase/serverAuth";
import { issueChallenge, AuthStoreError } from "@/lib/auth/challengeStore";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get("address");

    if (!address) {
      return NextResponse.json({ error: "Wallet address is required" }, { status: 400 });
    }

    // Verify it is a valid Stellar public key
    try {
      Keypair.fromPublicKey(address);
    } catch {
      return NextResponse.json({ error: "Invalid Stellar public key" }, { status: 400 });
    }

    // Rate limiting: per-IP (30/min) and per-address (10/min)
    const clientIp = getClientIp(request);
    const ipLimit = await checkRateLimit(`challenge:ip:${clientIp}`, 30, 60_000);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "Too many challenge requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(ipLimit.resetMs / 1000)),
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const addrLimit = await checkRateLimit(`challenge:addr:${address}`, 10, 60_000);
    if (!addrLimit.allowed) {
      return NextResponse.json(
        { error: "Too many challenge requests for this wallet. Please wait a minute." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(addrLimit.resetMs / 1000)),
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const nonce = crypto.randomUUID();
    const expiration = Date.now() + CHALLENGE_TTL_MS;
    const signature = generateChallengeSignature(address, nonce, expiration);

    await issueChallenge(address, nonce, expiration);
    // Build challenge transaction
    // Sequence number -1 so it gets incremented to 0 when building.
    const account = new Account(address, "-1");
    const tx = new TransactionBuilder(account, {
      fee: String(TX_BASE_FEE),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addMemo(Memo.text(`Auth ${nonce.slice(0, 8)}`))
      .setTimeout(Math.floor(CHALLENGE_TTL_MS / 1000))
      .addOperation(
        Operation.manageData({
          name: "StellarStar Auth",
          value: Buffer.from(nonce),
          source: address,
        })
      )
      .build();

    const xdr = tx.toXDR();

    return NextResponse.json(
      { xdr, nonce, expiration, signature },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (error: any) {
    console.error("Challenge generation error:", error);
    return NextResponse.json({ error: error.message || "Failed to generate challenge" }, { status: 500 });
  }
}
