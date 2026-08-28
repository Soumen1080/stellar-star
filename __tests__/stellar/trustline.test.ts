import { buildChangeTrustTransaction } from "@/lib/stellar/trustline";
import { Transaction } from "@stellar/stellar-sdk";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

// Setup fetch mock
global.fetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ sequence: "123" }),
})) as unknown as typeof fetch;

describe("buildChangeTrustTransaction", () => {
  it("builds a valid ChangeTrust transaction with correct asset", async () => {
    const { xdr } = await buildChangeTrustTransaction({
      publicKey: ACCOUNT,
      asset: USDC,
    });

    const tx = new Transaction(xdr, "Test SDF Network ; September 2015");
    expect(tx.operations.length).toBe(1);
    expect(tx.operations[0].type).toBe("changeTrust");

    const op = tx.operations[0] as any;
    expect(op.line.code).toBe("USDC");
    expect(op.line.issuer).toBe(CIRCLE_USDC_ISSUER_TESTNET);
  });
});
