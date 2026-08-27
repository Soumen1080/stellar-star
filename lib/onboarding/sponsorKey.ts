/**
 * Custody of the sponsor's signing key.
 *
 * Server-only. This key controls the XLM that funds every sponsored account, so
 * anyone holding it can drain the sponsor directly — a strictly worse outcome
 * than the abuse the cap defends against, since a cap does not apply to someone
 * signing transfers with the key itself.
 *
 * Same rules as `lib/settlement/oracleKey.ts`, for the same reason.
 */

import { Keypair } from "@stellar/stellar-sdk";

if (typeof window !== "undefined") {
  throw new Error("lib/onboarding/sponsorKey.ts must not be imported from client code.");
}

const SECRET_VAR = "SPONSOR_SECRET_KEY";

/**
 * A `NEXT_PUBLIC_` prefix inlines the value into the browser bundle. A sponsor
 * key there is a published sponsor key: treat its presence as fatal rather than
 * quietly preferring the server-only variable, because the key it names must be
 * considered drained.
 */
function assertNoPublicSecret(): void {
  const leaked = Object.keys(process.env).filter(
    (name) =>
      name.startsWith("NEXT_PUBLIC_") &&
      /SPONSOR.*(SECRET|SEED|PRIVATE|KEY)/.test(name),
  );

  if (leaked.length > 0) {
    throw new Error(
      `The sponsor signing key must never be exposed to the browser. Found ` +
        `${leaked.join(", ")} in the environment. Remove it, move the funds to a new ` +
        `keypair, and set ${SECRET_VAR} instead.`,
    );
  }
}

export class SponsorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorUnavailableError";
  }
}

/**
 * Loads the sponsor keypair.
 *
 * Resolved per call rather than cached, so a deployment without a sponsor fails
 * the onboarding requests that need one — degrading to "sponsorship
 * unavailable" — instead of failing to boot.
 */
export function loadSponsorKeypair(): Keypair {
  assertNoPublicSecret();

  const secret = process.env[SECRET_VAR]?.trim();
  if (!secret) {
    throw new SponsorUnavailableError(
      `${SECRET_VAR} is not configured. Sponsored onboarding is unavailable on this deployment.`,
    );
  }

  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new SponsorUnavailableError(
      `${SECRET_VAR} is not a valid Stellar secret seed (expected S...).`,
    );
  }
}

/** True when this deployment can sponsor at all. */
export function isSponsorConfigured(): boolean {
  try {
    loadSponsorKeypair();
    return true;
  } catch {
    return false;
  }
}

/** The sponsor's public address, safe to display. */
export function sponsorPublicKey(): string {
  return loadSponsorKeypair().publicKey();
}
