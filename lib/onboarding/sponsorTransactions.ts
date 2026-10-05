/**
 * Building the sponsorship transactions.
 *
 * ## Why sponsored reserves rather than a plain CreateAccount
 *
 * A plain `createAccount` gifts XLM outright: the sponsor spends it and it is
 * gone, whether or not the recipient ever uses the app. Sponsored reserves lock
 * the same XLM but keep it *recoverable* — revoking the sponsorship returns it.
 * Over a population of invitees who mostly never return, the difference is
 * between a permanent cost and a temporary one, and it is what makes a bounded
 * cap workable rather than merely a spending limit.
 *
 * The trade-off accepted: sponsorship is a durable liability that needs a
 * ledger, a cap and a revocation path — everything in this directory. A gift
 * needs none of that. See `docs/DESIGN_ACCOUNT_ONBOARDING.md`.
 *
 * ## The sandwich
 *
 * Sponsored reserves are expressed as a sandwich, and the ordering is
 * load-bearing:
 *
 * ```
 *   BeginSponsoringFutureReserves(sponsoredId: newAccount)   [source: sponsor]
 *   CreateAccount(destination: newAccount, startingBalance: 0)
 *   ChangeTrust(asset)                                       [source: newAccount]
 *   EndSponsoringFutureReserves()                            [source: newAccount]
 * ```
 *
 * `startingBalance: 0` is the point: the sponsor pays the reserve as a
 * *sponsorship*, not as a transfer, so the lumens remain the sponsor's and are
 * released on revocation.
 *
 * Both the sponsor and the new account must sign, because `EndSponsoring` is
 * sourced from the new account. That is a feature rather than an obstacle: the
 * new account's key is required, so the sponsor can never create an account the
 * user does not control (invariant 4).
 */

import {
  Account,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  Keypair,
} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE, TX_BASE_FEE, HORIZON_URL } from "@/lib/utils/constants";
import { toSdkAsset, type AssetRef } from "@/lib/stellar/assets";

/** Fee for a multi-operation sponsorship transaction, in stroops. */
const SPONSOR_TX_FEE = String(TX_BASE_FEE * 4);

/**
 * Hard cap on the number of accounts a single sponsor will bring into
 * existence. Enforced off-chain by the sponsorship ledger (see
 * `lib/onboarding/sponsorshipLedger.ts`) and reflected here so a caller that
 * has already exhausted its budget cannot even build the transaction.
 *
 * The cap is what makes the sponsor's total exposure bounded rather than
 * merely "large": each sponsored account locks a known reserve, so
 * `MAX_SPONSORED_ACCOUNTS * reservePerAccount` is the worst-case liability.
 */
export const MAX_SPONSORED_ACCOUNTS = 100;

/**
 * Abuse resistance: a small, non-refundable anti-spam fee the sponsor charges
 * the invitee (or the inviter) per onboarding. It scales linearly with N, so
 * scripting account creation costs the attacker something real, while a
 * genuine user pays it once. The fee is paid as a memo-bound XLM payment to
 * the sponsor in the same transaction, so it cannot be front-run or replayed.
 */
export const ONBOARDING_ANTI_SPAM_FEE_STROOPS = String(TX_BASE_FEE * 10);

async function loadAccount(publicKey: string, horizonUrl: string): Promise<Account> {
  const response = await fetch(`${horizonUrl}/accounts/${publicKey}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load sponsor account (Horizon ${response.status}).`);
  }
  const data = (await response.json()) as { sequence: string };
  return new Account(publicKey, data.sequence);
}

export interface BuildSponsoredCreationParams {
  sponsorPublicKey: string;
  /** The account being brought into existence. Its key must co-sign. */
  newAccountPublicKey: string;
  /** Trustline to open in the same sandwich, so the account can receive it. */
  asset?: AssetRef;
  /**
   * Number of accounts this sponsor has already onboarded. Used to enforce the
   * hard cap before any transaction is built. Callers must supply this from
   * the sponsorship ledger; the builder refuses to guess.
   */
  sponsoredCount: number;
  /** Anti-spam fee payer. Defaults to the new account's key. */
  antiSpamFeePayer?: string;
  horizonUrl?: string;
}

/**
 * Builds the unsigned sponsored account-creation transaction.
 *
 * Returns XDR requiring **two** signatures: the sponsor's and the new
 * account's. The transaction is inert until both are present.
 */
export async function buildSponsoredCreation({
  sponsorPublicKey,
  newAccountPublicKey,
  asset,
  sponsoredCount,
  antiSpamFeePayer,
  horizonUrl = HORIZON_URL,
}: BuildSponsoredCreationParams): Promise<{ xdr: string }> {
  if (sponsorPublicKey === newAccountPublicKey) {
    throw new Error("An account cannot sponsor itself.");
  }

  // Invariant 2: total exposure is bounded. Refuse to build once the sponsor
  // has hit its cap, so exhaustion surfaces as a typed error rather than a
  // Horizon failure halfway through signing.
  if (sponsoredCount >= MAX_SPONSORED_ACCOUNTS) {
    throw new Error(
      `Sponsor has reached its cap of ${MAX_SPONSORED_ACCOUNTS} sponsored accounts.`,
    );
  }

  const feePayer = antiSpamFeePayer ?? newAccountPublicKey;
  if (feePayer === sponsorPublicKey) {
    throw new Error("Anti-spam fee must be paid by the invitee, not the sponsor.");
  }

  const sponsorAccount = await loadAccount(sponsorPublicKey, horizonUrl);

  let builder = new TransactionBuilder(sponsorAccount, {
    fee: SPONSOR_TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addMemo(Memo.text(`onboard:${newAccountPublicKey.slice(0, 16)}`))
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: newAccountPublicKey,
        source: sponsorPublicKey,
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: newAccountPublicKey,
        // Zero: the reserve is sponsored, not gifted. This is what keeps the
        // lumens the sponsor's and therefore recoverable.
        startingBalance: "0",
        source: sponsorPublicKey,
      }),
    );

  // Abuse resistance: the invitee pays a small, non-refundable fee to the
  // sponsor. It is inside the sandwich so it settles atomically with the
  // account creation — either the account exists and the fee was paid, or
  // neither happened.
  builder = builder.addOperation(
    Operation.payment({
      destination: sponsorPublicKey,
      asset: Asset.native(),
      amount: stroopsToXlm(ONBOARDING_ANTI_SPAM_FEE_STROOPS),
      source: feePayer,
    }),
  );

  if (asset) {
    builder = builder.addOperation(
      Operation.changeTrust({
        asset: toSdkAsset(asset) as Asset,
        source: newAccountPublicKey,
      }),
    );
  }

  const tx = builder
    .addOperation(
      Operation.endSponsoringFutureReserves({
        // Sourced from the new account, so its key must sign. The sponsor
        // cannot create an account the user does not control.
        source: newAccountPublicKey,
      }),
    )
    .setTimeout(120)
    .build();

  return { xdr: tx.toXDR() };
}

export interface BuildRevocationParams {
  sponsorPublicKey: string;
  /** The sponsored account whose reserves are being released. */
  sponsoredAccount: string;
  /** Trustline sponsorship to revoke alongside the account's, if any. */
  asset?: AssetRef;
  horizonUrl?: string;
}

/**
 * Builds the revocation transaction — invariant 3, implemented rather than
 * described.
 *
 * `revokeAccountSponsorship` transfers the reserve obligation back to the
 * sponsored account itself. Two outcomes, both acceptable and neither of which
 * takes anything from the user:
 *
 *  - The account holds enough XLM to cover its own reserve: the sponsorship
 *    lifts cleanly and the sponsor's lumens unlock.
 *  - It does not: the operation fails and the sponsorship stands. The user is
 *    never left with an account they cannot use, and the sponsor simply keeps
 *    waiting. Reclamation is best-effort by design.
 *
 * Only the sponsor signs — revocation is the sponsor's unilateral right,
 * which is what makes the liability genuinely bounded rather than bounded only
 * with the invitee's cooperation.
 *
 * Revocation is the other half of the cap: the ledger decrements the
 * sponsored count when a revocation confirms, so a sponsor that reclaims a
 * dormant account can onboard someone new. Without this path the cap would be
 * a one-way ratchet and the feature would die after N users.
 */
export async function buildSponsorshipRevocation({
  sponsorPublicKey,
  sponsoredAccount,
  asset,
  horizonUrl = HORIZON_URL,
}: BuildRevocationParams): Promise<{ xdr: string }> {
  const sponsorAccount = await loadAccount(sponsorPublicKey, horizonUrl);

  let builder = new TransactionBuilder(sponsorAccount, {
    fee: SPONSOR_TX_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  // Trustline sponsorship first: revoking the account sponsorship while a
  // sponsored subentry still hangs off it leaves the obligation half-moved.
  if (asset) {
    builder = builder.addOperation(
      Operation.revokeTrustlineSponsorship({
        account: sponsoredAccount,
        asset: toSdkAsset(asset) as Asset,
        source: sponsorPublicKey,
      }),
    );
  }

  const tx = builder
    .addOperation(
      Operation.revokeAccountSponsorship({
        account: sponsoredAccount,
        source: sponsorPublicKey,
      }),
    )
    .setTimeout(120)
    .build();

  return { xdr: tx.toXDR() };
}

/**
 * Converts a stroop amount to the decimal XLM string the SDK expects.
 *
 * Kept local and pure so the anti-spam fee is expressed once, in stroops, and
 * formatted consistently wherever it is charged or displayed.
 */
function stroopsToXlm(stroops: string): string {
  const n = BigInt(stroops);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

/**
 * Adds the sponsor's signature to a transaction.
 *
 * Server-only. Takes the keypair rather than the secret string so the secret is
 * never passed around as a value that could end up in a log line or an error
 * message; `lib/onboarding/sponsorKey.ts` is the only place it is read.
 *
 * The result is deliberately *partially* signed for a creation sandwich — the
 * new account's signature is still required, which is what stops the server
 * creating an account its holder does not control.
 *
 * The anti-spam fee payer must also sign, so a creation transaction carries
 * two or three signatures depending on whether the invitee pays the fee
 * themselves. The sponsor's signature alone is never sufficient.
 */
export function signAsSponsor(xdr: string, sponsorKeypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  tx.sign(sponsorKeypair);
  return tx.toXDR();
}
