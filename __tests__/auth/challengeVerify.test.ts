/** @jest-environment node */

import crypto from "crypto";
import { Keypair, TransactionBuilder, Account, Memo, Operation } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, TX_BASE_FEE } from "@/lib/utils/constants";
import { generateChallengeSignature, signSupabaseJwt } from "@/lib/supabase/serverAuth";
import { GET as challengeGET } from "@/app/api/auth/challenge/route";
import { POST as verifyPOST } from "@/app/api/auth/verify/route";

// The verify route provisions the user profile through the server-side client.
// Stub it so these tests exercise the signature-verification path without a
// live database: `maybeSingle` resolving to no row is a wallet that has not
// signed up yet.
jest.mock("@/lib/supabase/server", () => {
  const builder: any = {
    from: jest.fn(() => builder),
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    update: jest.fn(() => builder),
    upsert: jest.fn(() => builder),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    single: jest.fn().mockResolvedValue({
      data: {
        id: "00000000-0000-4000-8000-000000000000",
        wallet_address: "GTEST",
        display_name: "Test User",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        last_login_at: "2024-01-01T00:00:00.000Z",
      },
      error: null,
    }),
  };
  return {
    isServerSupabaseConfigured: () => true,
    createServerClientForToken: () => builder,
    createServerAnonClient: () => builder,
    createServiceRoleClient: () => null,
  };
});

function decodeJwt(token: string) {
  const [headerB64, payloadB64] = token.split(".");
  const pad = (s: string) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s: string) => Buffer.from(pad(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return {
    header: JSON.parse(b64(headerB64)),
    payload: JSON.parse(b64(payloadB64)),
  };
}

function mockRequest(url: string) {
  return { url } as any;
}

function mockBody(body: unknown) {
  return { json: async () => body } as any;
}

async function getChallenge(address: string) {
  const res = await challengeGET(mockRequest(`http://localhost/api/auth/challenge?address=${address}`));
  const data = await res.json();
  return { status: res.status, ...data };
}

function buildChallengeTx(address: string, nonce: string) {
  const account = new Account(address, "-1");
  return new TransactionBuilder(account, {
    fee: String(TX_BASE_FEE),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addMemo(Memo.text(`Auth ${nonce.slice(0, 8)}`))
    .setTimeout(300)
    .addOperation(
      Operation.manageData({
        name: "StellarStar Auth",
        value: Buffer.from(nonce),
        source: address,
      })
    )
    .build();
}

describe("wallet challenge issuance (GET /api/auth/challenge)", () => {
  it("rejects a malformed address before minting a challenge", async () => {
    const res = await challengeGET(mockRequest("http://localhost/api/auth/challenge?address=not-a-real-key"));
    expect(res.status).toBe(400);
  });

  it("returns a fresh nonce, a 5 minute expiration, and an HMAC signature over them", async () => {
    const keypair = Keypair.random();
    const challenge = await getChallenge(keypair.publicKey());

    expect(challenge.status).toBe(200);
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.expiration).toBeGreaterThan(Date.now());
    expect(challenge.expiration).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
    expect(challenge.signature).toBe(
      generateChallengeSignature(keypair.publicKey(), challenge.nonce, challenge.expiration)
    );
  });
});

describe("wallet challenge verification (POST /api/auth/verify)", () => {
  it("issues a session JWT tied to the wallet address for a correctly signed challenge", async () => {
    const keypair = Keypair.random();
    const challenge = await getChallenge(keypair.publicKey());

    const tx = TransactionBuilder.fromXDR(challenge.xdr, NETWORK_PASSPHRASE);
    tx.sign(keypair);

    const res = await verifyPOST(
      mockBody({
        address: keypair.publicKey(),
        signedXdr: tx.toXDR(),
        nonce: challenge.nonce,
        expiration: challenge.expiration,
        signature: challenge.signature,
        displayName: "Test User",
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    const { header, payload } = decodeJwt(data.token);
    expect(header.alg).toBe("HS256");
    expect(payload.wallet_address).toBe(keypair.publicKey());
    expect(payload.aud).toBe("authenticated");
    expect(payload.role).toBe("authenticated");
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  });

  it("rejects a challenge whose HMAC signature was tampered with", async () => {
    const keypair = Keypair.random();
    const challenge = await getChallenge(keypair.publicKey());
    const tx = TransactionBuilder.fromXDR(challenge.xdr, NETWORK_PASSPHRASE);
    tx.sign(keypair);

    const res = await verifyPOST(
      mockBody({
        address: keypair.publicKey(),
        signedXdr: tx.toXDR(),
        nonce: challenge.nonce,
        expiration: challenge.expiration,
        signature: "0".repeat(challenge.signature.length),
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/signature mismatch/i);
  });

  it("rejects an expired challenge even with a valid HMAC and a valid wallet signature", async () => {
    const keypair = Keypair.random();
    const nonce = "expired-nonce-1234";
    const expiration = Date.now() - 1000; // already expired
    const signature = generateChallengeSignature(keypair.publicKey(), nonce, expiration);

    const tx = buildChallengeTx(keypair.publicKey(), nonce);
    tx.sign(keypair);

    const res = await verifyPOST(
      mockBody({
        address: keypair.publicKey(),
        signedXdr: tx.toXDR(),
        nonce,
        expiration,
        signature,
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
  });

  it("rejects a transaction signed by a different keypair than the claimed address", async () => {
    const ownerKeypair = Keypair.random();
    const attackerKeypair = Keypair.random();
    const challenge = await getChallenge(ownerKeypair.publicKey());

    // Attacker signs the owner's challenge with their own key, but still claims to be the owner.
    const tx = TransactionBuilder.fromXDR(challenge.xdr, NETWORK_PASSPHRASE);
    tx.sign(attackerKeypair);

    const res = await verifyPOST(
      mockBody({
        address: ownerKeypair.publicKey(),
        signedXdr: tx.toXDR(),
        nonce: challenge.nonce,
        expiration: challenge.expiration,
        signature: challenge.signature,
      })
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/signature verification failed/i);
  });

  it("rejects a transaction whose operation nonce does not match the issued challenge", async () => {
    const keypair = Keypair.random();
    const challenge = await getChallenge(keypair.publicKey());

    // Build a differently-noticed transaction but present the original challenge's
    // nonce/expiration/signature alongside it.
    const swappedTx = buildChallengeTx(keypair.publicKey(), "a-different-nonce-value");
    swappedTx.sign(keypair);

    const res = await verifyPOST(
      mockBody({
        address: keypair.publicKey(),
        signedXdr: swappedTx.toXDR(),
        nonce: challenge.nonce,
        expiration: challenge.expiration,
        signature: challenge.signature,
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid challenge operation/i);
  });

  it("rejects a transaction whose source account does not match the claimed address", async () => {
    const claimedKeypair = Keypair.random();
    const actualSigner = Keypair.random();
    const challenge = await getChallenge(claimedKeypair.publicKey());

    const tx = buildChallengeTx(actualSigner.publicKey(), challenge.nonce);
    tx.sign(actualSigner);

    const res = await verifyPOST(
      mockBody({
        address: claimedKeypair.publicKey(),
        signedXdr: tx.toXDR(),
        nonce: challenge.nonce,
        expiration: challenge.expiration,
        signature: challenge.signature,
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source account mismatch/i);
  });

  it("rejects requests missing required fields", async () => {
    const res = await verifyPOST(mockBody({ address: "GABC" }));
    expect(res.status).toBe(400);
  });
});

describe("serverAuth secret handling", () => {
  const originalSupabaseSecret = process.env.SUPABASE_JWT_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.SUPABASE_JWT_SECRET = originalSupabaseSecret;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  it("throws instead of silently signing with a hardcoded fallback secret when unset", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.JWT_SECRET;

    expect(() => generateChallengeSignature("GADDRESS", "nonce", Date.now())).toThrow(/SUPABASE_JWT_SECRET/);
    expect(() => signSupabaseJwt({ wallet_address: "GADDRESS" })).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("produces a JWT whose HMAC signature is invalidated by tampering with the payload", () => {
    const secret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "";
    const base64url = (buf: Buffer) =>
      buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const verify = (encodedHeader: string, encodedPayload: string, encodedSignature: string) => {
      const expected = base64url(
        crypto.createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest()
      );
      return expected === encodedSignature;
    };

    const token = signSupabaseJwt({ wallet_address: "GADDRESS" }, 3600);
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");

    expect(verify(encodedHeader, encodedPayload, encodedSignature)).toBe(true);

    const { payload: decoded } = decodeJwt(token);
    const tamperedPayload = base64url(
      Buffer.from(JSON.stringify({ ...decoded, wallet_address: "GATTACKER" }))
    );

    // Same signature, attacker-modified payload: must no longer verify.
    expect(verify(encodedHeader, tamperedPayload, encodedSignature)).toBe(false);
  });
});
