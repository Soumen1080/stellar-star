/**
 * Verification must accept a path payment as proof of settlement.
 *
 * The bug being guarded against: a check asserting `op.type === "payment"`
 * silently rejects a path payment. The payer's money is gone, the recipient has
 * the right amount of the right asset, and the app says the debt is unpaid.
 */

import {
  describeSettlementOperation,
  explainSettlementMismatch,
  findSettlementOperation,
  isSettlementOperation,
} from "@/lib/stellar/verifyPaymentOperation";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const SOURCE = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const THIRD_PARTY = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

/** Recorded shape of a direct native payment. */
const DIRECT_PAYMENT = {
  type: "payment",
  from: SOURCE,
  to: DEST,
  asset_type: "native",
  amount: "10.0000000",
};

/**
 * Recorded shape of a path payment: the payer spent XLM, the recipient
 * received USDC. Note `asset_*` describes what *arrived*, and `source_asset_*`
 * what was spent.
 */
const PATH_PAYMENT_TO_USDC = {
  type: "path_payment_strict_receive",
  from: SOURCE,
  to: DEST,
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
  amount: "10.0000000",
  source_asset_type: "native",
  source_amount: "102.5000000",
};

/** A path payment that delivers native XLM, paid for with USDC. */
const PATH_PAYMENT_TO_NATIVE = {
  type: "path_payment_strict_receive",
  from: SOURCE,
  to: DEST,
  asset_type: "native",
  amount: "10.0000000",
  source_asset_type: "credit_alphanum4",
  source_asset_code: "USDC",
  source_asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
  source_amount: "1.0200000",
};

describe("operation type recognition", () => {
  it("accepts direct payments and both path payment forms", () => {
    expect(isSettlementOperation(DIRECT_PAYMENT)).toBe(true);
    expect(isSettlementOperation(PATH_PAYMENT_TO_USDC)).toBe(true);
    expect(isSettlementOperation({ type: "path_payment_strict_send" })).toBe(true);
  });

  it("rejects operations that cannot settle anything", () => {
    expect(isSettlementOperation({ type: "create_account" })).toBe(false);
    expect(isSettlementOperation({ type: "change_trust" })).toBe(false);
    expect(isSettlementOperation({ type: "manage_sell_offer" })).toBe(false);
  });
});

describe("normalising operations", () => {
  it("reads a direct payment", () => {
    const described = describeSettlementOperation(DIRECT_PAYMENT);

    expect(described?.receivedAmount).toBe("10.0000000");
    expect(described?.receivedAsset).toEqual(NATIVE_ASSET);
    expect(described?.viaPath).toBe(false);
  });

  it("reads a path payment's received asset, not its spent asset", () => {
    // The distinction the whole module exists for.
    const described = describeSettlementOperation(PATH_PAYMENT_TO_USDC);

    expect(described?.receivedAsset).toEqual(USDC);
    expect(described?.receivedAmount).toBe("10.0000000");
    expect(described?.spentAsset).toEqual(NATIVE_ASSET);
    expect(described?.spentAmount).toBe("102.5000000");
    expect(described?.viaPath).toBe(true);
  });

  it("falls back to the transaction source when the op has none", () => {
    const described = describeSettlementOperation(
      { ...DIRECT_PAYMENT, from: undefined },
      SOURCE,
    );

    expect(described?.source).toBe(SOURCE);
  });
});

describe("matching a settlement", () => {
  const usdcDebt = { source: SOURCE, destination: DEST, asset: USDC, amount: "10.0000000" };
  const xlmDebt = {
    source: SOURCE,
    destination: DEST,
    asset: NATIVE_ASSET,
    amount: "10.0000000",
  };

  it("accepts a path payment as proof — invariant 4", () => {
    const match = findSettlementOperation([PATH_PAYMENT_TO_USDC], usdcDebt);

    expect(match).not.toBeNull();
    expect(match?.viaPath).toBe(true);
  });

  it("still accepts a direct payment", () => {
    expect(findSettlementOperation([DIRECT_PAYMENT], xlmDebt)).not.toBeNull();
  });

  it("accepts a path payment that delivers native", () => {
    expect(findSettlementOperation([PATH_PAYMENT_TO_NATIVE], xlmDebt)).not.toBeNull();
  });

  it("asserts on the destination asset, not the source", () => {
    // The payer spent XLM. A check against the *spent* asset would wrongly
    // accept this as settling an XLM debt.
    expect(findSettlementOperation([PATH_PAYMENT_TO_USDC], xlmDebt)).toBeNull();
  });

  it("rejects the right amount of the wrong asset", () => {
    // Anyone can issue a token called USDC; only the issuer distinguishes them.
    const counterfeit = {
      ...PATH_PAYMENT_TO_USDC,
      asset_issuer: "GFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
    };

    expect(findSettlementOperation([counterfeit], usdcDebt)).toBeNull();
  });

  it("rejects an underpayment", () => {
    // Invariant 1: exactly the amount owed, never less.
    const short = { ...PATH_PAYMENT_TO_USDC, amount: "9.9999999" };

    expect(findSettlementOperation([short], usdcDebt)).toBeNull();
  });

  it("rejects a payment to someone else", () => {
    const misdirected = { ...PATH_PAYMENT_TO_USDC, to: THIRD_PARTY };

    expect(findSettlementOperation([misdirected], usdcDebt)).toBeNull();
  });

  it("finds the settlement among unrelated operations", () => {
    const operations = [
      { type: "manage_sell_offer" },
      { ...DIRECT_PAYMENT, to: THIRD_PARTY },
      PATH_PAYMENT_TO_USDC,
    ];

    expect(findSettlementOperation(operations, usdcDebt)?.viaPath).toBe(true);
  });

  it("treats equivalent decimal spellings as equal", () => {
    const padded = { ...PATH_PAYMENT_TO_USDC, amount: "10.00" };

    expect(findSettlementOperation([padded], usdcDebt)).not.toBeNull();
  });
});

describe("mismatch explanations", () => {
  const usdcDebt = { source: SOURCE, destination: DEST, asset: USDC, amount: "10.0000000" };

  it("says when there is no payment at all", () => {
    expect(explainSettlementMismatch([{ type: "change_trust" }], usdcDebt)).toMatch(
      /no payment or path-payment/i,
    );
  });

  it("says when the asset is wrong", () => {
    expect(explainSettlementMismatch([DIRECT_PAYMENT], usdcDebt)).toMatch(/XLM/);
  });

  it("says when the amount is wrong", () => {
    const short = { ...PATH_PAYMENT_TO_USDC, amount: "5.0000000" };

    expect(explainSettlementMismatch([short], usdcDebt)).toMatch(/5\.0000000/);
  });
});
