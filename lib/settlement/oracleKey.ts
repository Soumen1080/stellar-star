/**
 * Server-only coordination for threshold settlement signers.
 *
 * Server-only. The key here is the entire trust anchor for on-chain settlement
 * proof. Production uses independently hosted signer endpoints; local seed
 * lists are retained only for development. No secret enters a client bundle.
 *
 * ## Custody model
 *
 * The key is a Stellar ed25519 keypair, supplied as a secret seed (`S...`) in
 * the server-only `SETTLEMENT_ORACLE_SECRET` environment variable. Stellar keys
 * *are* ed25519 keys, so the same seed gives us `sign()` here and a raw 32-byte
 * public key for the contract's `init` — no separate key format, no extra
 * dependency, and the public half is a `G...` address that can be pasted into
 * config and read back off-chain by anyone auditing the deployment.
 *
 * Rotation is a two-step the admin controls: generate a new keypair, call
 * `set_oracle_key` on the contract, then swap the env var. Attestations signed
 * by the retired key stop verifying the moment the contract call lands.
 */

import { Keypair } from "@stellar/stellar-sdk";

if (typeof window !== "undefined") {
  throw new Error("lib/settlement/oracleKey.ts must not be imported from client code.");
}

const SECRET_VAR = "SETTLEMENT_ORACLE_SECRETS";

/**
 * A `NEXT_PUBLIC_` prefix tells Next.js to inline the value into the browser
 * bundle. A signing key there is a published signing key, so treat its mere
 * presence as a fatal misconfiguration rather than quietly preferring the
 * server-only variable — the key it names must be considered burned.
 */
function assertNoPublicSecret(): void {
  const leaked = Object.keys(process.env).filter(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") &&
      /ORACLE.*(SECRET|SEED|PRIVATE|SIGNING)|SETTLEMENT_ORACLE_SECRET/.test(name),
  );

  if (leaked.length > 0) {
    throw new Error(
      `The settlement oracle signing key must never be exposed to the browser. ` +
        `Found ${leaked.join(", ")} in the environment. Remove it, rotate the key ` +
        `(generate a new one, call set_oracle_key on the contract), and set ${SECRET_VAR} instead.`,
    );
  }
}

export class OracleKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleKeyUnavailableError";
  }
}

interface RemoteSigner { url: string; token: string; publicKey: string }
function remoteSigners(): RemoteSigner[] {
  try {
    const value = JSON.parse(process.env.SETTLEMENT_ORACLE_SIGNERS || "[]") as RemoteSigner[];
    if (!Array.isArray(value)) return [];
    const valid = value.filter((s) => typeof s.url === "string" && /^https:\/\//.test(s.url) && typeof s.token === "string" && s.token.length > 0 && typeof s.publicKey === "string");
    const seen = new Set<string>();
    return valid.filter((signer) => { if (seen.has(signer.publicKey)) return false; seen.add(signer.publicKey); return true; });
  } catch { return []; }
}
export function configuredOracleSignerCount(): number {
  const remotes = remoteSigners();
  return remotes.length > 0 ? new Set(remotes.map((s) => s.publicKey)).size : loadOracleKeypairs().length;
}

/**
 * Loads the oracle keypair.
 *
 * Resolved per call rather than cached at module load, so a deployment that is
 * missing the key fails the requests that need it — degrading settlement to
 * off-chain-recorded — instead of failing to boot, and so a rotated key takes
 * effect without a restart.
 */
export function loadOracleKeypairs(): Keypair[] {
  assertNoPublicSecret();

  const secrets = (process.env[SECRET_VAR] || process.env.SETTLEMENT_ORACLE_SECRET || "").split(",").map((secret) => secret.trim()).filter(Boolean);
  if (secrets.length === 0) {
    throw new OracleKeyUnavailableError(
      `${SECRET_VAR} is not configured. The settlement oracle cannot sign attestations, ` +
        `so on-chain settlement is unavailable until it is set.`,
    );
  }

  let keypairs: Keypair[];
  try {
    keypairs = secrets.map((secret) => Keypair.fromSecret(secret));
  } catch {
    throw new OracleKeyUnavailableError(
      `${SECRET_VAR} is not a valid Stellar secret seed (expected S...).`,
    );
  }
  if (new Set(keypairs.map((keypair) => keypair.publicKey())).size !== keypairs.length) {
    throw new OracleKeyUnavailableError("Oracle signer seeds must resolve to distinct public keys.");
  }
  return keypairs;
}

/** @deprecated Prefer loadOracleKeypairs for threshold signing. */
export function loadOracleKeypair(): Keypair { return loadOracleKeypairs()[0]; }

/** True when this deployment can sign attestations at all. */
export function isOracleConfigured(): boolean {
  try {
    const count = configuredOracleSignerCount();
    const threshold = Math.max(1, Number(process.env.SETTLEMENT_ORACLE_THRESHOLD) || 2);
    return count >= threshold;
  } catch {
    return false;
  }
}

/** Signs a canonical claim message. Returns a lowercase hex signature. */
export function signClaimMessage(message: Buffer): { signature: string; publicKey: string } {
  const keypair = loadOracleKeypair();
  return { signature: Buffer.from(keypair.sign(message)).toString("hex"), publicKey: keypair.publicKey() };
}

export async function signClaimMessages(message: Buffer): Promise<Array<{ signature: string; publicKey: string }>> {
  const remotes = remoteSigners();
  if (remotes.length > 0) {
    const results = await Promise.all(remotes.map(async (signer) => {
      try {
        const response = await fetch(signer.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signer.token}` }, body: JSON.stringify({ message: message.toString("base64") }), signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return null;
        const result = await response.json() as { signature?: string; publicKey?: string };
        if (result.publicKey !== signer.publicKey || typeof result.signature !== "string") return null;
        const bytes = Buffer.from(result.signature, "hex");
        if (bytes.length !== 64 || !Keypair.fromPublicKey(signer.publicKey).verify(message, bytes)) return null;
        return { signature: result.signature, publicKey: signer.publicKey };
      } catch { return null; }
    }));
    return results.filter((result): result is { signature: string; publicKey: string } => Boolean(result));
  }
  return loadOracleKeypairs().map((keypair) => ({ signature: Buffer.from(keypair.sign(message)).toString("hex"), publicKey: keypair.publicKey() }));
}

/**
 * The raw 32-byte ed25519 public key, hex encoded — the form the contract's
 * `init` and `set_oracle_key` take as `BytesN<32>`.
 */
export function oracleRawPublicKeyHex(): string {
  return Buffer.from(loadOracleKeypair().rawPublicKey()).toString("hex");
}
