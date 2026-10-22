/**
 * paymentRequest.test.ts — QR and link payment requests (#327).
 */

import { Networks, TransactionBuilder, Transaction } from "@stellar/stellar-sdk";
import {
  buildPayURI,
  buildRequestTransactionXDR,
  buildTxURI,
  checkPaymentRequest,
  createPaymentRequest,
  decodePaymentRequest,
  describePaymentRequest,
  encodePaymentRequest,
  itemKey,
  paymentRequestLink,
  PaymentRequestError,
  requestMessage,
  type ItemState,
  type PaymentRequest,
} from "@/lib/qr/paymentRequest";

const CREDITOR = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const DEBTOR = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const NOW = 1_900_000_000;

function shareRequest(overrides: Partial<Parameters<typeof createPaymentRequest>[0]> = {}): PaymentRequest {
  return createPaymentRequest({
    kind: "share",
    destination: CREDITOR,
    source: DEBTOR,
    asset: "native",
    amount: "12.3456789",
    tripId: "trip-1",
    items: [{ expenseId: "exp-1", memberId: "bob", amount: "12.3456789" }],
    network: "TESTNET",
    nowSeconds: NOW,
    ...overrides,
  });
}

function query(uri: string): URLSearchParams {
  return new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
}

function live(request: PaymentRequest, state: Partial<ItemState> = {}): Map<string, ItemState> {
  return new Map(
    request.items.map((item) => [itemKey(item), { outstanding: item.amount, creditorWallet: CREDITOR, ...state }]),
  );
}

describe("createPaymentRequest", () => {
  it("captures destination, canonical asset, exact amount, safe memo, expiry and network", () => {
    const request = shareRequest({ asset: `USDC:${ISSUER}`, ttlSeconds: 3600 });
    expect(request).toMatchObject({
      destination: CREDITOR,
      source: DEBTOR,
      asset: `USDC:${ISSUER}`,
      amount: "12.3456789",
      expiresAt: NOW + 3600,
      network: "TESTNET",
      networkPassphrase: Networks.TESTNET,
    });
    expect(request.memo).toMatch(/^SSR:[0-9A-F]{12}$/);
    expect(new TextEncoder().encode(request.memo).length).toBeLessThanOrEqual(28);
  });

  it("canonicalises the asset key and normalises the amount without rounding", () => {
    expect(shareRequest({ asset: "XLM", amount: "5", items: [{ expenseId: "exp-1", memberId: "bob", amount: "5.0" }] })).toMatchObject({
      asset: "native",
      amount: "5.0000000",
    });
    expect(() => shareRequest({ amount: "1.00000001" })).toThrow(/at most 7 decimals/);
    expect(() => shareRequest({ amount: "0" })).toThrow(/positive/);
  });

  it("rejects bad addresses, assets, expiries and mismatched share amounts", () => {
    expect(() => shareRequest({ destination: "nope" })).toThrow(/valid Stellar address/);
    expect(() => shareRequest({ source: CREDITOR })).toThrow(/different accounts/);
    expect(() => shareRequest({ asset: "USDC" })).toThrow(/Malformed asset key/);
    expect(() => shareRequest({ ttlSeconds: 60 })).toThrow(/expire/);
    expect(() => shareRequest({ ttlSeconds: 8 * 24 * 3600 })).toThrow(/expire/);
    expect(() => shareRequest({ items: [{ expenseId: "exp-1", memberId: "bob", amount: "1" }] })).toThrow(/exactly/);
  });

  it("never puts trip or expense names in the memo", () => {
    const request = shareRequest({ tripId: "secret-trip", items: [{ expenseId: "birthday-dinner", memberId: "bob", amount: "12.3456789" }] });
    expect(request.memo).not.toMatch(/secret|birthday/i);
    expect(buildPayURI(request)).not.toMatch(/secret|birthday/i);
  });

  it("derives a deterministic reference that changes with any committed field", () => {
    expect(shareRequest().reference).toBe(shareRequest().reference);
    expect(shareRequest({ amount: "1", items: [{ expenseId: "exp-1", memberId: "bob", amount: "1" }] }).reference).not.toBe(
      shareRequest().reference,
    );
  });
});

describe("SEP-0007 encodings", () => {
  it("builds a pay URI with every field plus a human-readable msg", () => {
    const request = shareRequest({ asset: `USDC:${ISSUER}` });
    const uri = buildPayURI(request);
    expect(uri.startsWith("web+stellar:pay?")).toBe(true);
    const q = query(uri);
    expect(q.get("destination")).toBe(CREDITOR);
    expect(q.get("amount")).toBe("12.3456789");
    expect(q.get("asset_code")).toBe("USDC");
    expect(q.get("asset_issuer")).toBe(ISSUER);
    expect(q.get("memo")).toBe(request.memo);
    expect(q.get("memo_type")).toBe("MEMO_TEXT");
    expect(q.get("network_passphrase")).toBe(Networks.TESTNET);
    expect(q.get("msg")).toBe(requestMessage(request));
    expect(q.get("msg")).toMatch(/exactly 12\.3456789 USDC .* on Testnet\. Expires 2030-03-18T17:46:40Z/);
    expect(q.get("msg")!.length).toBeLessThanOrEqual(300);
  });

  it("builds a tx URI whose transaction expires on-chain and is bound to one network", () => {
    const request = shareRequest();
    const uri = buildTxURI(request, "4242", "200");
    expect(uri.startsWith("web+stellar:tx?")).toBe(true);
    const q = query(uri);
    expect(q.get("network_passphrase")).toBe(Networks.TESTNET);

    const tx = TransactionBuilder.fromXDR(q.get("xdr")!, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(DEBTOR);
    expect(tx.sequence).toBe("4243");
    expect(tx.timeBounds).toEqual({ minTime: "0", maxTime: String(request.expiresAt) });
    expect(tx.memo.value?.toString()).toBe(request.memo);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: "payment", destination: CREDITOR, amount: "12.3456789" });

    // A signature over this transaction is only valid on the passphrase it was
    // built for: the same envelope hashes differently on Mainnet.
    const onMainnet = TransactionBuilder.fromXDR(q.get("xdr")!, Networks.PUBLIC) as Transaction;
    expect(Buffer.from(onMainnet.hash()).equals(Buffer.from(tx.hash()))).toBe(false);
  });

  it("requires the payer's account for a tx request", () => {
    expect(() => buildRequestTransactionXDR(shareRequest({ source: null }), "1", "100")).toThrow(/payer's account/);
  });
});

describe("app link", () => {
  it("round-trips through the /pay link", () => {
    const request = shareRequest();
    const link = paymentRequestLink("https://app.example/", request);
    expect(link.startsWith("https://app.example/pay?r=")).toBe(true);
    expect(decodePaymentRequest(new URL(link).searchParams.get("r")!)).toEqual(request);
  });

  it("refuses an altered link instead of showing it as genuine", () => {
    const request = shareRequest();
    for (const tampered of [
      { ...request, amount: "1.0000000" },
      { ...request, destination: DEBTOR, source: CREDITOR },
      { ...request, expiresAt: request.expiresAt + 86_400 },
      { ...request, network: "PUBLIC" as const },
    ]) {
      expect(() => decodePaymentRequest(encodePaymentRequest(tampered))).toThrow(PaymentRequestError);
    }
    // A self-consistent edit (amount and item changed together) is caught by the reference.
    const edited = { ...request, amount: "1.0000000", items: [{ ...request.items[0], amount: "1.0000000" }] };
    expect(() => decodePaymentRequest(encodePaymentRequest(edited))).toThrow(/altered/);
    expect(() => decodePaymentRequest("%%%")).toThrow(/damaged/);
  });
});

describe("preview", () => {
  it("lists every field in plain words before signing", () => {
    const { lines, expired, secondsLeft } = describePaymentRequest(shareRequest({ ttlSeconds: 3600 }), NOW + 600);
    expect(lines.map((l) => l.label)).toEqual(["Pay to", "From", "Amount", "Asset", "Memo", "Network", "Expires", "Covers"]);
    expect(lines.find((l) => l.label === "Amount")!.value).toBe("12.3456789 XLM");
    expect(lines.find((l) => l.label === "Network")!.value).toBe("Testnet");
    expect(expired).toBe(false);
    expect(secondsLeft).toBe(3000);
  });
});

describe("checkPaymentRequest — what cannot be submitted", () => {
  const ctx = (request: PaymentRequest, extra: Partial<Parameters<typeof checkPaymentRequest>[1]> = {}) =>
    checkPaymentRequest(request, {
      nowSeconds: NOW + 60,
      appNetwork: "TESTNET",
      walletNetwork: "TESTNET",
      payerWallet: DEBTOR,
      items: live(request),
      ...extra,
    });
  const codes = (result: ReturnType<typeof checkPaymentRequest>) => result.blockers.map((b) => b.code);

  it("allows a fresh, unpaid, same-network request", () => {
    expect(ctx(shareRequest())).toEqual({ ok: true, blockers: [] });
  });

  it("blocks an expired request", () => {
    const request = shareRequest({ ttlSeconds: 300 });
    expect(codes(ctx(request, { nowSeconds: request.expiresAt }))).toEqual(["EXPIRED"]);
  });

  it("blocks an already-paid request, fully or partly", () => {
    const request = shareRequest();
    expect(codes(ctx(request, { items: live(request, { outstanding: "0.0000000" }) }))).toEqual(["ALREADY_PAID"]);

    const net = createPaymentRequest({
      kind: "net",
      destination: CREDITOR,
      source: DEBTOR,
      asset: "native",
      amount: "15",
      tripId: "trip-1",
      items: [
        { expenseId: "exp-1", memberId: "bob", amount: "10" },
        { expenseId: "exp-2", memberId: "bob", amount: "5" },
      ],
      network: "TESTNET",
      nowSeconds: NOW,
    });
    const partlyPaid = live(net);
    partlyPaid.set("exp-2:bob", { outstanding: "0.0000000", creditorWallet: CREDITOR });
    const result = ctx(net, { items: partlyPaid });
    expect(codes(result)).toEqual(["ALREADY_PAID"]);
    expect(result.blockers[0].message).toMatch(/Part of this request/);
  });

  it("blocks a request for another network, and a wallet on another network", () => {
    const mainnet = shareRequest({ network: "PUBLIC" });
    expect(codes(ctx(mainnet, { walletNetwork: null }))).toEqual(["NETWORK_MISMATCH"]);
    expect(codes(ctx(shareRequest(), { walletNetwork: "PUBLIC" }))).toEqual(["WALLET_NETWORK_MISMATCH"]);
  });

  it("blocks a request whose recipient is not who is owed, or that is addressed to another payer", () => {
    const request = shareRequest();
    expect(codes(ctx(request, { items: live(request, { creditorWallet: ISSUER }) }))).toEqual(["DESTINATION_MISMATCH"]);
    expect(codes(ctx(request, { payerWallet: ISSUER }))).toEqual(["WRONG_PAYER"]);
  });

  it("blocks a request whose share changed or vanished since it was made", () => {
    const request = shareRequest();
    expect(codes(ctx(request, { items: live(request, { outstanding: "20.0000000" }) }))).toEqual(["AMOUNT_CHANGED"]);
    expect(codes(ctx(request, { items: new Map() }))).toEqual(["AMOUNT_CHANGED"]);
  });
});
