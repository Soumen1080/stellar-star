import { buildChangeTrustTransaction } from "@/lib/stellar/trustline";
import { Transaction } from "@stellar/stellar-sdk";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

// buildChangeTrustTransaction now reads live ledger state (base reserve) and
// the account (affordability + sequence), so the mock must answer both routes.
global.fetch = jest.fn(async (url: string) => {
  if (String(url).includes("/ledgers")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: [{ base_reserve_in_stroops: 5_000_000 }] },
      }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      sequence: "123",
      subentry_count: 0,
      num_sponsoring: 0,
      num_sponsored: 0,
      balances: [{ asset_type: "native", balance: "100.0000000" }],
    }),
  };
}) as unknown as typeof fetch;

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
