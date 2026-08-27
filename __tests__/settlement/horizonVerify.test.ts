/**
 * Tests for the oracle's Horizon verification.
 *
 * The governing invariant (4): the tx hash is a lookup key and nothing else the
 * caller says is trusted. So these tests are mostly about what the module
 * *returns* — the facts it derives from Horizon — rather than about it agreeing
 * with an expectation someone handed it. There is no parameter to hand it one.
 */

import {
  amountToStroops,
  HorizonVerificationError,
  verifyPaymentByHash,
} from "@/lib/settlement/horizonVerify";

const TX_HASH = "a".repeat(64);
const SOURCE = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const THIRD_PARTY = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface MockOptions {
  tx?: Record<string, unknown>;
  operations?: Record<string, unknown>[];
  txStatus?: number;
  opsStatus?: number;
}

function mockHorizon({ tx, operations = [], txStatus = 200, opsStatus = 200 }: MockOptions) {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.includes("/operations")) {
      return jsonResponse({ _embedded: { records: operations } }, opsStatus);
    }
    return jsonResponse(tx ?? {}, txStatus);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function successfulTx(overrides: Record<string, unknown> = {}) {
  return {
    successful: true,
    ledger: 1234,
    created_at: new Date().toISOString(),
    source_account: SOURCE,
    memo: "StellarStar|dinner",
    memo_type: "text",
    ...overrides,
  };
}

function paymentOp(overrides: Record<string, unknown> = {}) {
  return {
    type: "payment",
    from: SOURCE,
    to: DESTINATION,
    asset_type: "native",
    amount: "1.0000000",
    ...overrides,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("amountToStroops", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(amountToStroops("1")).toBe(10_000_000n);
    expect(amountToStroops("1.0000001")).toBe(10_000_001n);
    expect(amountToStroops("0.0000001")).toBe(1n);
  });

  it("does not lose precision on values a float would round", () => {
    // 0.1 + 0.2 territory: the reason this is BigInt and not parseFloat.
    expect(amountToStroops("0.1") + amountToStroops("0.2")).toBe(amountToStroops("0.3"));
  });

  it("rejects more than 7 decimals", () => {
    expect(() => amountToStroops("1.00000001")).toThrow(HorizonVerificationError);
  });

  it("rejects non-numeric input", () => {
    expect(() => amountToStroops("1e7")).toThrow(HorizonVerificationError);
  });
});

describe("verifyPaymentByHash", () => {
  it("returns the facts Horizon reports", async () => {
    mockHorizon({ tx: successfulTx(), operations: [paymentOp()] });

    const result = await verifyPaymentByHash(TX_HASH);

    expect(result.source).toBe(SOURCE);
    expect(result.destination).toBe(DESTINATION);
    expect(result.amountStroops).toBe(10_000_000n);
    expect(result.ledger).toBe(1234);
  });

  it("rejects a malformed hash before touching the network", async () => {
    const fetchMock = mockHorizon({ tx: successfulTx() });

    await expect(verifyPaymentByHash("nope")).rejects.toThrow(HorizonVerificationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a transaction that is not on the network", async () => {
    mockHorizon({ txStatus: 404 });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toThrow("not found");
  });

  it("rejects a transaction that failed on the ledger", async () => {
    mockHorizon({ tx: successfulTx({ successful: false }), operations: [paymentOp()] });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toThrow("failed on the ledger");
  });

  it("rejects a transaction with no native payment operation", async () => {
    mockHorizon({
      tx: successfulTx(),
      operations: [
        paymentOp({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER" }),
      ],
    });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toThrow(
      "no payment or path payment delivering the native asset",
    );
  });

  it("accepts a path payment that delivers the native asset", async () => {
    // The payer spent USDC through the DEX; the recipient received XLM. That
    // settles an XLM debt exactly as a direct payment would, and rejecting it
    // would leave the payer out of pocket with the debt still open.
    mockHorizon({
      tx: successfulTx(),
      operations: [
        {
          type: "path_payment_strict_receive",
          from: SOURCE,
          to: DESTINATION,
          asset_type: "native",
          amount: "1.0000000",
          source_asset_type: "credit_alphanum4",
          source_asset_code: "USDC",
          source_asset_issuer: "GISSUER",
          source_amount: "0.1020000",
        },
      ],
    });

    const result = await verifyPaymentByHash(TX_HASH);

    // Attested on what arrived, never on what was spent.
    expect(result.amountStroops).toBe(10_000_000n);
    expect(result.viaPath).toBe(true);
  });

  it("ignores a path payment that delivers some other asset", async () => {
    mockHorizon({
      tx: successfulTx(),
      operations: [
        {
          type: "path_payment_strict_receive",
          from: SOURCE,
          to: DESTINATION,
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: "GISSUER",
          amount: "1.0000000",
          source_asset_type: "native",
          source_amount: "10.0000000",
        },
      ],
    });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toThrow(
      "no payment or path payment delivering the native asset",
    );
  });

  it("rejects a payment too old to attest", async () => {
    // Bounds how far back a caller can reach for an unclaimed payment to
    // attach to a debt created later.
    mockHorizon({
      tx: successfulTx({ created_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }),
      operations: [paymentOp()],
    });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toThrow("too old");
  });

  it("sums only operations between the same source and destination", async () => {
    // A third-party payment riding in the same transaction must not inflate
    // the attested amount.
    mockHorizon({
      tx: successfulTx(),
      operations: [
        paymentOp({ amount: "1.0000000" }),
        paymentOp({ amount: "5.0000000", to: THIRD_PARTY }),
        paymentOp({ amount: "2.0000000" }),
      ],
    });

    const result = await verifyPaymentByHash(TX_HASH);

    expect(result.amountStroops).toBe(30_000_000n);
  });

  it("marks Horizon outages as transient rather than as a verdict", async () => {
    // A 5xx must degrade settlement, not condemn the claim as fabricated.
    mockHorizon({ txStatus: 503 });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toMatchObject({ transient: true });
  });

  it("marks a definitive 404 as non-transient", async () => {
    mockHorizon({ txStatus: 404 });

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toMatchObject({ transient: false });
  });

  it("treats a network error as transient", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(verifyPaymentByHash(TX_HASH)).rejects.toMatchObject({ transient: true });
  });
});
