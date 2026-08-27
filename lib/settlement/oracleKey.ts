/**
 * Custody of the attestation oracle's signing key.
 *
 * Server-only. The key here is the entire trust anchor for on-chain settlement
 * proof: anyone holding it can mint an attestation for a payment that never
 * happened, which is exactly the hole the oracle exists to close. So this
 * module's job is less "load a key" than "refuse to run in any configuration
 * where the key could have leaked".
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

const SECRET_VAR = "SETTLEMENT_ORACLE_SECRET";

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

/**
 * Loads the oracle keypair.
 *
 * Resolved per call rather than cached at module load, so a deployment that is
 * missing the key fails the requests that need it — degrading settlement to
 * off-chain-recorded — instead of failing to boot, and so a rotated key takes
 * effect without a restart.
 */
export function loadOracleKeypair(): Keypair {
  assertNoPublicSecret();

  const secret = process.env[SECRET_VAR]?.trim();
  if (!secret) {
    throw new OracleKeyUnavailableError(
      `${SECRET_VAR} is not configured. The settlement oracle cannot sign attestations, ` +
        `so on-chain settlement is unavailable until it is set.`,
    );
  }

  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new OracleKeyUnavailableError(
      `${SECRET_VAR} is not a valid Stellar secret seed (expected S...).`,
    );
  }
}

/** True when this deployment can sign attestations at all. */
export function isOracleConfigured(): boolean {
  try {
    loadOracleKeypair();
    return true;
  } catch {
    return false;
  }
}

/** Signs a canonical claim message. Returns a lowercase hex signature. */
export function signClaimMessage(message: Buffer): { signature: string; publicKey: string } {
  const keypair = loadOracleKeypair();
  return {
    signature: keypair.sign(message).toString("hex"),
    publicKey: keypair.publicKey(),
  };
}

/**
 * The raw 32-byte ed25519 public key, hex encoded — the form the contract's
 * `init` and `set_oracle_key` take as `BytesN<32>`.
 */
export function oracleRawPublicKeyHex(): string {
  return loadOracleKeypair().rawPublicKey().toString("hex");
}
