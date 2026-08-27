/**
 * Server-side Horizon verification for the attestation oracle.
 *
 * The distinction from `lib/stellar/verifyTransaction.ts` is the whole point of
 * the issue: that module runs in the browser of the person who benefits from
 * the answer, so its verdict is worth nothing to anyone else. This one runs on
 * the server, and its output is what gets signed.
 *
 * The rule it follows, from invariant 4: the transaction hash is a *lookup
 * key*, and nothing else the caller says about the transaction is trusted. The
 * source, destination, asset, and amount are read out of Horizon's response and
 * returned as facts. Callers may compare those facts to what they expected —
 * and should refuse to sign if they differ — but the facts themselves never
 * come from the request.
 */

import { HORIZON_URL } from "@/lib/utils/constants";

/** Classic Stellar assets are int64 stroops with exactly 7 decimals, protocol-wide. */
const STROOPS_PER_UNIT = 10_000_000n;

/** How old a payment may be and still earn an attestation. */
export const MAX_PAYMENT_AGE_MS = 24 * 60 * 60 * 1000;

export interface VerifiedPayment {
  /** Account that sent the payment, per Horizon. */
  source: string;
  /** Account that received it, per Horizon. */
  destination: string;
  /** Total native amount sent from source to destination, in stroops. */
  amountStroops: bigint;
  /** Ledger sequence the transaction closed in. */
  ledger: number;
  /** Ledger close time, ISO 8601. */
  closedAt: string;
  memo: string | null;
}

export class HorizonVerificationError extends Error {
  /** True when Horizon itself failed, as opposed to the payment being invalid. */
  readonly transient: boolean;

  constructor(message: string, transient = false) {
    super(message);
    this.name = "HorizonVerificationError";
    this.transient = transient;
  }
}

/** Parses a decimal Stellar amount ("1.2345678") into stroops, without float. */
export function amountToStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new HorizonVerificationError(`Horizon returned an unparseable amount: ${amount}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > 7) {
    throw new HorizonVerificationError(`Amount has more than 7 decimals: ${amount}`);
  }
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
}

interface HorizonOperation {
  type: string;
  source_account?: string;
  from?: string;
  to?: string;
  asset_type?: string;
  amount?: string;
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new HorizonVerificationError(`Could not reach Horizon: ${message}`, true);
  }

  if (response.status === 404) {
    throw new HorizonVerificationError("Transaction not found on the network.");
  }
  if (!response.ok) {
    // Anything other than a definitive 404 is Horizon having a bad day, not
    // proof the payment is fake — so it degrades settlement rather than
    // condemning the claim.
    throw new HorizonVerificationError(`Horizon returned HTTP ${response.status}.`, true);
  }

  return response.json();
}

/**
 * Reads a transaction from Horizon and returns what it actually did.
 *
 * Only `txHash` is taken from the caller. Everything in the result is derived
 * from Horizon's response.
 */
export async function verifyPaymentByHash(txHash: string): Promise<VerifiedPayment> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    throw new HorizonVerificationError("Transaction hash must be 64 hex characters.");
  }

  const normalisedHash = txHash.toLowerCase();
  const tx = (await fetchJson(`${HORIZON_URL}/transactions/${normalisedHash}`)) as {
    successful?: boolean;
    ledger?: number;
    created_at?: string;
    source_account?: string;
    memo?: string;
    memo_type?: string;
  };

  if (!tx.successful) {
    throw new HorizonVerificationError("Transaction failed on the ledger.");
  }
  if (typeof tx.ledger !== "number" || tx.ledger <= 0) {
    throw new HorizonVerificationError("Transaction is not yet included in a closed ledger.");
  }

  const closedAt = tx.created_at ?? "";
  const closedAtMs = Date.parse(closedAt);
  if (Number.isNaN(closedAtMs)) {
    throw new HorizonVerificationError("Transaction has no usable close time.");
  }
  if (Date.now() - closedAtMs > MAX_PAYMENT_AGE_MS) {
    // Bounds how far back a caller can reach for an unclaimed payment to
    // attach to a new debt.
    throw new HorizonVerificationError(
      "Transaction is too old to attest. Settle with a recent payment.",
    );
  }

  const opsBody = (await fetchJson(
    `${HORIZON_URL}/transactions/${normalisedHash}/operations?limit=200`,
  )) as { _embedded?: { records?: HorizonOperation[] } };

  const operations = opsBody._embedded?.records ?? [];
  const payments = operations.filter(
    (op) => op.type === "payment" && op.asset_type === "native",
  );

  if (payments.length === 0) {
    throw new HorizonVerificationError("Transaction contains no native payment operation.");
  }

  // A transaction may carry several payment operations. Attesting a specific
  // source/destination pair means summing only that pair's operations, so an
  // unrelated third-party payment riding in the same transaction cannot pad
  // the attested amount.
  const source = payments[0].from ?? payments[0].source_account ?? tx.source_account ?? "";
  const destination = payments[0].to ?? "";
  if (!source || !destination) {
    throw new HorizonVerificationError("Payment operation is missing source or destination.");
  }

  let amountStroops = 0n;
  for (const op of payments) {
    const opSource = op.from ?? op.source_account ?? tx.source_account;
    if (opSource !== source || op.to !== destination) continue;
    amountStroops += amountToStroops(op.amount ?? "0");
  }

  if (amountStroops <= 0n) {
    throw new HorizonVerificationError("Payment amount is zero.");
  }

  return {
    source,
    destination,
    amountStroops,
    ledger: tx.ledger,
    closedAt,
    memo: tx.memo_type === "text" ? (tx.memo ?? null) : null,
  };
}
