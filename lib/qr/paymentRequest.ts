/**
 * lib/qr/paymentRequest.ts — QR and link payment requests for an outstanding
 * share or a net settlement (#327). Builds on the SEP-0007 generator.
 *
 * A request pins down everything a payment needs and nothing private:
 *
 *   destination   the creditor's account
 *   asset         canonical key ("native" | "CODE:ISSUER")
 *   amount        exact, at ledger precision; never rounded
 *   memo          "SSR:<reference>" — an intent reference, never a trip or
 *                 expense name, so a scanned QR leaks nothing
 *   expiresAt     unix seconds
 *   network       app network + passphrase
 *
 * It is encoded three ways:
 *
 *   1. SEP-0007 `tx` URI (the QR, when the payer's account is known): a ready
 *      transaction whose time-bounds end at `expiresAt` and whose signature is
 *      bound to one network passphrase, and which uses the payer's current
 *      sequence number. The ledger itself therefore refuses it once expired,
 *      on the wrong network, or after the payer has transacted since (which
 *      includes having paid already).
 *   2. SEP-0007 `pay` URI — the copyable fallback for wallets without `tx`
 *      support. Carries the same fields plus a human-readable `msg`.
 *   3. An in-app link (`/pay?r=…`) that shows a preview and re-checks expiry,
 *      network, destination and outstanding balance before the wallet signs.
 */

import {
  Account,
  Memo,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
} from "@stellar/stellar-sdk";
import { Money } from "@/lib/money";
import { assetKey, isNative, parseAssetKey, toSdkAsset, type StellarNetwork } from "@/lib/stellar/assets";
import { buildQRPaymentURI } from "./generator";

export const PAYMENT_REQUEST_VERSION = 1;
export const DEFAULT_REQUEST_TTL_SECONDS = 24 * 60 * 60;
export const MIN_REQUEST_TTL_SECONDS = 5 * 60;
export const MAX_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MEMO_REFERENCE_PREFIX = "SSR:";
/** SEP-0007 caps `msg` at 300 characters. */
export const MAX_SEP7_MSG_LENGTH = 300;

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  PUBLIC: "Public Global Stellar Network ; September 2015",
  TESTNET: "Test SDF Network ; September 2015",
};

export interface PaymentRequestItem {
  expenseId: string;
  memberId: string;
  /** What this item contributes, exact decimal string. */
  amount: string;
}

export interface PaymentRequest {
  v: typeof PAYMENT_REQUEST_VERSION;
  kind: "share" | "net";
  network: StellarNetwork;
  networkPassphrase: string;
  destination: string;
  /** The payer's account, when known. Required for the `tx` QR. */
  source: string | null;
  asset: string;
  amount: string;
  reference: string;
  memo: string;
  expiresAt: number;
  tripId: string;
  items: PaymentRequestItem[];
}

export type PaymentRequestErrorCode =
  | "INVALID_DESTINATION"
  | "INVALID_SOURCE"
  | "INVALID_ASSET"
  | "INVALID_AMOUNT"
  | "INVALID_ITEMS"
  | "INVALID_EXPIRY"
  | "INVALID_NETWORK"
  | "MALFORMED";

export class PaymentRequestError extends Error {
  constructor(
    readonly code: PaymentRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

const ID_PATTERN = /^[\w-]{1,64}$/;

function exactAmount(value: string, what: string): string {
  const parsed = Money.tryParse(typeof value === "string" ? value.trim() : value);
  if (!parsed || !parsed.isPositive()) {
    throw new PaymentRequestError("INVALID_AMOUNT", `${what} must be a positive amount with at most 7 decimals.`);
  }
  return parsed.format();
}

function canonicalAsset(asset: string): string {
  try {
    return assetKey(parseAssetKey(asset));
  } catch (err) {
    throw new PaymentRequestError("INVALID_ASSET", err instanceof Error ? err.message : "Invalid asset.");
  }
}

/** Deterministic reference over everything the request commits to. */
export function computeReference(
  request: Omit<PaymentRequest, "reference" | "memo">,
): string {
  const canonical = JSON.stringify([
    request.v,
    request.kind,
    request.network,
    request.destination,
    request.source,
    request.asset,
    request.amount,
    request.expiresAt,
    request.tripId,
    request.items.map((i) => [i.expenseId, i.memberId, i.amount]),
  ]);
  return Buffer.from(hash(Buffer.from(canonical, "utf8"))).toString("hex").slice(0, 12).toUpperCase();
}

export interface CreatePaymentRequestInput {
  kind: "share" | "net";
  destination: string;
  source?: string | null;
  asset: string;
  amount: string;
  tripId: string;
  items: PaymentRequestItem[];
  network: StellarNetwork;
  nowSeconds?: number;
  ttlSeconds?: number;
}

export function createPaymentRequest(input: CreatePaymentRequestInput): PaymentRequest {
  const destination = (input.destination ?? "").trim();
  if (!StrKey.isValidEd25519PublicKey(destination)) {
    throw new PaymentRequestError("INVALID_DESTINATION", "The recipient has no valid Stellar address.");
  }
  const source = input.source ? input.source.trim() : null;
  if (source !== null && !StrKey.isValidEd25519PublicKey(source)) {
    throw new PaymentRequestError("INVALID_SOURCE", "The payer's Stellar address is not valid.");
  }
  if (source === destination) {
    throw new PaymentRequestError("INVALID_SOURCE", "The payer and recipient must be different accounts.");
  }
  if (input.network !== "PUBLIC" && input.network !== "TESTNET") {
    throw new PaymentRequestError("INVALID_NETWORK", "Unknown Stellar network.");
  }
  if (!ID_PATTERN.test(input.tripId)) {
    throw new PaymentRequestError("INVALID_ITEMS", "A trip id is required.");
  }

  const asset = canonicalAsset(input.asset);
  const amount = exactAmount(input.amount, "The requested amount");

  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 50) {
    throw new PaymentRequestError("INVALID_ITEMS", "A request must cover between 1 and 50 shares.");
  }
  const items = input.items.map((item) => {
    if (!ID_PATTERN.test(item.expenseId) || !ID_PATTERN.test(item.memberId)) {
      throw new PaymentRequestError("INVALID_ITEMS", "Every share needs an expense and member id.");
    }
    return { expenseId: item.expenseId, memberId: item.memberId, amount: exactAmount(item.amount, "A share amount") };
  });
  if (input.kind === "share" && (items.length !== 1 || items[0].amount !== amount)) {
    throw new PaymentRequestError("INVALID_ITEMS", "A share request must cover exactly that share's amount.");
  }

  const ttl = input.ttlSeconds ?? DEFAULT_REQUEST_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < MIN_REQUEST_TTL_SECONDS || ttl > MAX_REQUEST_TTL_SECONDS) {
    throw new PaymentRequestError("INVALID_EXPIRY", "A request must expire between 5 minutes and 7 days from now.");
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  const base = {
    v: PAYMENT_REQUEST_VERSION,
    kind: input.kind,
    network: input.network,
    networkPassphrase: NETWORK_PASSPHRASES[input.network],
    destination,
    source,
    asset,
    amount,
    expiresAt: now + ttl,
    tripId: input.tripId,
    items,
  } as const;
  const reference = computeReference(base);
  return { ...base, reference, memo: `${MEMO_REFERENCE_PREFIX}${reference}` };
}

// ─── Encodings ────────────────────────────────────────────────────────────────

export function encodePaymentRequest(request: PaymentRequest): string {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

/**
 * Decodes a link parameter. Every field is re-validated and the reference
 * recomputed, so a hand-edited link (amount, destination, expiry…) is refused
 * rather than displayed as if it were the original request.
 */
export function decodePaymentRequest(encoded: string): PaymentRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new PaymentRequestError("MALFORMED", "This payment link is damaged.");
  }
  if (!raw || typeof raw !== "object") throw new PaymentRequestError("MALFORMED", "This payment link is damaged.");
  const r = raw as Partial<PaymentRequest>;
  if (r.v !== PAYMENT_REQUEST_VERSION || (r.kind !== "share" && r.kind !== "net")) {
    throw new PaymentRequestError("MALFORMED", "This payment link is from an unsupported version.");
  }
  if (typeof r.expiresAt !== "number" || !Number.isInteger(r.expiresAt)) {
    throw new PaymentRequestError("MALFORMED", "This payment link has no valid expiry.");
  }

  const rebuilt = createPaymentRequest({
    kind: r.kind,
    destination: String(r.destination ?? ""),
    source: r.source ?? null,
    asset: String(r.asset ?? ""),
    amount: String(r.amount ?? ""),
    tripId: String(r.tripId ?? ""),
    items: Array.isArray(r.items) ? r.items : [],
    network: r.network as StellarNetwork,
    // Rebuild with the original expiry: ttl is irrelevant once decoded.
    nowSeconds: r.expiresAt - MIN_REQUEST_TTL_SECONDS,
    ttlSeconds: MIN_REQUEST_TTL_SECONDS,
  });
  if (rebuilt.reference !== r.reference || rebuilt.memo !== r.memo || rebuilt.networkPassphrase !== r.networkPassphrase) {
    throw new PaymentRequestError("MALFORMED", "This payment link was altered and cannot be used.");
  }
  return rebuilt;
}

export function paymentRequestLink(origin: string, request: PaymentRequest): string {
  return `${origin.replace(/\/+$/, "")}/pay?r=${encodePaymentRequest(request)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function assetLabel(asset: string): string {
  const ref = parseAssetKey(asset);
  return isNative(ref) ? "XLM" : `${ref.code} (${shortAddress(ref.issuer!)})`;
}

/** The wallet-side preview text (SEP-0007 `msg`), bounded to 300 characters. */
export function requestMessage(request: PaymentRequest): string {
  const expires = new Date(request.expiresAt * 1000).toISOString().replace(".000Z", "Z");
  const network = request.network === "PUBLIC" ? "Mainnet" : "Testnet";
  const msg =
    `StellarStar payment request ${request.reference}: pay exactly ${request.amount} ${assetLabel(request.asset)} ` +
    `to ${shortAddress(request.destination)} on ${network}. Expires ${expires}.`;
  return msg.slice(0, MAX_SEP7_MSG_LENGTH);
}

/** SEP-0007 `pay` URI — the copyable fallback. */
export function buildPayURI(request: PaymentRequest): string {
  const ref = parseAssetKey(request.asset);
  return buildQRPaymentURI({
    destination: request.destination,
    amount: request.amount,
    memo: request.memo,
    assetCode: isNative(ref) ? undefined : ref.code,
    assetIssuer: isNative(ref) ? undefined : ref.issuer!,
    networkPassphrase: request.networkPassphrase,
    msg: requestMessage(request),
  });
}

/**
 * The unsigned transaction a `tx` URI carries: time-bounded to the request's
 * expiry and built on the payer's current sequence number.
 */
export function buildRequestTransactionXDR(request: PaymentRequest, sequence: string, fee: string): string {
  if (!request.source) {
    throw new PaymentRequestError("INVALID_SOURCE", "A transaction request needs the payer's account.");
  }
  if (!/^\d{1,20}$/.test(sequence)) throw new PaymentRequestError("MALFORMED", "Invalid account sequence.");
  const tx = new TransactionBuilder(new Account(request.source, sequence), {
    fee,
    networkPassphrase: request.networkPassphrase,
    timebounds: { minTime: 0, maxTime: request.expiresAt },
  })
    .addOperation(
      Operation.payment({
        destination: request.destination,
        asset: toSdkAsset(parseAssetKey(request.asset)),
        amount: request.amount,
      }),
    )
    .addMemo(Memo.text(request.memo))
    .build();
  return tx.toXDR();
}

/** SEP-0007 `tx` URI for the QR. */
export function buildTxURI(request: PaymentRequest, sequence: string, fee: string): string {
  const params = new URLSearchParams({
    xdr: buildRequestTransactionXDR(request, sequence, fee),
    network_passphrase: request.networkPassphrase,
    msg: requestMessage(request),
  });
  return `web+stellar:tx?${params.toString()}`;
}

// ─── Preview and submission gate ──────────────────────────────────────────────

export interface PreviewLine {
  label: string;
  value: string;
}

/** Human-readable preview, shown before any wallet is asked to sign. */
export function describePaymentRequest(request: PaymentRequest, nowSeconds = Math.floor(Date.now() / 1000)) {
  const secondsLeft = request.expiresAt - nowSeconds;
  const lines: PreviewLine[] = [
    { label: "Pay to", value: request.destination },
    ...(request.source ? [{ label: "From", value: request.source }] : []),
    { label: "Amount", value: `${request.amount} ${assetLabel(request.asset)}` },
    { label: "Asset", value: request.asset === "native" ? "XLM (native)" : request.asset },
    { label: "Memo", value: request.memo },
    { label: "Network", value: request.network === "PUBLIC" ? "Mainnet (Public)" : "Testnet" },
    { label: "Expires", value: new Date(request.expiresAt * 1000).toLocaleString() },
    {
      label: "Covers",
      value: request.kind === "net" ? `Net settlement of ${request.items.length} share(s)` : "One expense share",
    },
  ];
  return { lines, expired: secondsLeft <= 0, secondsLeft: Math.max(0, secondsLeft) };
}

export type PaymentRequestBlocker =
  | "EXPIRED"
  | "NETWORK_MISMATCH"
  | "WALLET_NETWORK_MISMATCH"
  | "WRONG_PAYER"
  | "DESTINATION_MISMATCH"
  | "ALREADY_PAID"
  | "AMOUNT_CHANGED";

export interface ItemState {
  /** Remaining balance of the share now; "0.0000000" when paid; null when unknown. */
  outstanding: string | null;
  /** The account the share is owed to now. */
  creditorWallet: string | null;
}

export interface SubmissionContext {
  nowSeconds?: number;
  appNetwork: StellarNetwork;
  walletNetwork?: string | null;
  payerWallet?: string | null;
  /** Live state of every item, keyed `${expenseId}:${memberId}`. */
  items: Map<string, ItemState>;
}

export function itemKey(item: Pick<PaymentRequestItem, "expenseId" | "memberId">): string {
  return `${item.expenseId}:${item.memberId}`;
}

/**
 * Every reason a request must not be submitted, checked against live state
 * immediately before signing. Empty means it may proceed.
 */
export function checkPaymentRequest(request: PaymentRequest, ctx: SubmissionContext): {
  ok: boolean;
  blockers: { code: PaymentRequestBlocker; message: string }[];
} {
  const blockers: { code: PaymentRequestBlocker; message: string }[] = [];
  const now = ctx.nowSeconds ?? Math.floor(Date.now() / 1000);
  const label = (n: string) => (n === "PUBLIC" ? "Mainnet" : n === "TESTNET" ? "Testnet" : "an unknown network");

  if (request.expiresAt <= now) {
    blockers.push({ code: "EXPIRED", message: "This payment request has expired. Ask for a new one." });
  }
  if (request.network !== ctx.appNetwork || request.networkPassphrase !== NETWORK_PASSPHRASES[ctx.appNetwork]) {
    blockers.push({
      code: "NETWORK_MISMATCH",
      message: `This request is for ${label(request.network)}, but this app runs on ${label(ctx.appNetwork)}.`,
    });
  }
  if (ctx.walletNetwork && ctx.walletNetwork !== request.network) {
    blockers.push({
      code: "WALLET_NETWORK_MISMATCH",
      message: `Your wallet is on ${label(ctx.walletNetwork)}; switch it to ${label(request.network)} to pay.`,
    });
  }
  if (request.source && ctx.payerWallet && ctx.payerWallet !== request.source) {
    blockers.push({ code: "WRONG_PAYER", message: "This request is addressed to a different wallet." });
  }

  let paidCount = 0;
  for (const item of request.items) {
    const state = ctx.items.get(itemKey(item));
    if (!state) {
      blockers.push({ code: "AMOUNT_CHANGED", message: "A share in this request no longer exists." });
      continue;
    }
    if (state.creditorWallet && state.creditorWallet !== request.destination) {
      blockers.push({
        code: "DESTINATION_MISMATCH",
        message: "The recipient in this request does not match who is owed. Do not pay it.",
      });
    }
    const outstanding = state.outstanding === null ? null : Money.tryParse(state.outstanding);
    if (outstanding?.isZero()) {
      paidCount++;
    } else if (outstanding && !outstanding.equals(item.amount)) {
      blockers.push({ code: "AMOUNT_CHANGED", message: "The balance changed since this request was made. Ask for a new one." });
    }
  }
  if (paidCount > 0) {
    blockers.push({
      code: "ALREADY_PAID",
      message:
        paidCount === request.items.length
          ? "This request has already been paid."
          : "Part of this request has already been paid. Ask for a new one.",
    });
  }

  // One message per code is enough.
  const seen = new Set<PaymentRequestBlocker>();
  const unique = blockers.filter((b) => (seen.has(b.code) ? false : (seen.add(b.code), true)));
  return { ok: unique.length === 0, blockers: unique };
}
