import { NextRequest, NextResponse } from "next/server";
import { Account, TransactionBuilder, Memo, Operation, Keypair } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, TX_BASE_FEE } from "@/lib/utils/constants";
import { generateChallengeSignature } from "@/lib/supabase/serverAuth";
import crypto from "crypto";

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

    const nonce = crypto.randomUUID();
    const expiration = Date.now() + 5 * 60 * 1000; // 5 minutes validity
    const signature = generateChallengeSignature(address, nonce, expiration);

    // Build challenge transaction
    // Sequence number -1 so it gets incremented to 0 when building.
    const account = new Account(address, "-1");
    const tx = new TransactionBuilder(account, {
      fee: String(TX_BASE_FEE),
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addMemo(Memo.text(`Auth ${nonce.slice(0, 8)}`))
      .setTimeout(300) // 5 minutes
      .addOperation(
        Operation.manageData({
          name: "StellarStar Auth",
          value: Buffer.from(nonce),
          source: address,
        })
      )
      .build();

    const xdr = tx.toXDR();

    return NextResponse.json({
      xdr,
      nonce,
      expiration,
      signature,
    });
  } catch (error: any) {
    console.error("Challenge generation error:", error);
    return NextResponse.json({ error: error.message || "Failed to generate challenge" }, { status: 500 });
  }
}
