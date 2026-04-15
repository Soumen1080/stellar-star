import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { parsePaymentEvent } from "@/lib/stellar/events";

describe("parsePaymentEvent", () => {
  it("parses legacy tuple event payloads", () => {
    const raw = {
      ledger: 101,
      ledgerClosedAt: "2024-01-01T00:00:00Z",
      txHash: "abc123",
      topic: [
        xdr.ScVal.scvSymbol("pmt_rec"),
        nativeToScVal("trip-1", { type: "string" }),
      ],
      value: nativeToScVal(["exp-1", "GAAAA", "2500000"]),
    };

    const parsed = parsePaymentEvent(raw);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      ledger: 101,
      ledgerClosedAt: "2024-01-01T00:00:00Z",
      tripId: "trip-1",
      expenseId: "exp-1",
      member: "GAAAA",
      amountStroops: "2500000",
      txHash: "abc123",
    });
  });

  it("parses structured object event payloads", () => {
    const raw = {
      ledger: 202,
      ledgerClosedAt: "2024-01-02T00:00:00Z",
      txHash: "def456",
      topic: [
        xdr.ScVal.scvSymbol("pmt_rec"),
        nativeToScVal("trip-2", { type: "string" }),
      ],
      value: nativeToScVal({
        expense_id: "exp-2",
        member: "GBBBB",
        amount: "700",
      }),
    };

    const parsed = parsePaymentEvent(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.tripId).toBe("trip-2");
    expect(parsed?.expenseId).toBe("exp-2");
    expect(parsed?.member).toBe("GBBBB");
    expect(parsed?.amountStroops).toBe("700");
  });

  it("returns null when trip ID is missing", () => {
    const raw = {
      topic: [xdr.ScVal.scvSymbol("pmt_rec")],
      value: nativeToScVal(["exp-3", "GCCCC", "10"]),
    };

    expect(parsePaymentEvent(raw)).toBeNull();
  });
});
