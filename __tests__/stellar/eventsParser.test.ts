import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  fetchContractEvents,
  parsePaymentEvent,
  buildPaymentEventKey,
} from "@/lib/stellar/events";
import { sorobanServer } from "@/lib/stellar/soroban";
import { CIRCLE_USDC_ISSUER_TESTNET } from "@/lib/stellar/assets";

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    getEvents: jest.fn(),
    getLatestLedger: jest.fn(),
  },
}));

function rawPaymentEvent(index: number) {
  return {
    ledger: 100 + index,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    txHash: `tx-${index}`,
    topic: [
      xdr.ScVal.scvSymbol("pmt_rec"),
      nativeToScVal("trip-1", { type: "string" }),
    ],
    value: nativeToScVal([`exp-${index}`, "GAAAA", String(index)]),
  };
}

describe("buildPaymentEventKey", () => {
  it("discriminates between different assets on the same trip, expense, member, and amount", () => {
    const member = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const xlmKey = buildPaymentEventKey({
      tripId: "trip-1",
      expenseId: "exp-1",
      member,
      amountStroops: "100000000",
      asset: "native",
    });

    const usdcKey = buildPaymentEventKey({
      tripId: "trip-1",
      expenseId: "exp-1",
      member,
      amountStroops: "100000000",
      asset: `USDC:${CIRCLE_USDC_ISSUER_TESTNET}`,
    });

    expect(xlmKey).not.toEqual(usdcKey);
    expect(xlmKey).toBe(`trip-1:exp-1:${member.toLowerCase()}:100000000:native`);
    expect(usdcKey).toBe(`trip-1:exp-1:${member.toLowerCase()}:100000000:USDC:${CIRCLE_USDC_ISSUER_TESTNET}`);
  });

  it("handles BigInt amounts and normalizes case-insensitively", () => {
    const key = buildPaymentEventKey({
      tripId: "trip-A",
      expenseId: "exp-B",
      member: "GABCDEF",
      amountStroops: 25000000n,
    });
    expect(key).toBe("trip-A:exp-B:gabcdef:25000000:native");
  });
});

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
      asset: "native",
      txHash: "abc123",
      payer: undefined,
      timestamp: undefined,
    });
  });

  it("parses structured object event payloads with custom asset", () => {
    const usdcAsset = `USDC:${CIRCLE_USDC_ISSUER_TESTNET}`;
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
        asset: usdcAsset,
      }),
    };

    const parsed = parsePaymentEvent(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.tripId).toBe("trip-2");
    expect(parsed?.expenseId).toBe("exp-2");
    expect(parsed?.member).toBe("GBBBB");
    expect(parsed?.amountStroops).toBe("700");
    expect(parsed?.asset).toBe(usdcAsset);
  });

  it("returns null when trip ID is missing", () => {
    const raw = {
      topic: [xdr.ScVal.scvSymbol("pmt_rec")],
      value: nativeToScVal(["exp-3", "GCCCC", "10"]),
    };

    expect(parsePaymentEvent(raw)).toBeNull();
  });

  it("parses multiple events from the same member correctly", () => {
    const rawEvents = [
      {
        ledger: 101,
        ledgerClosedAt: "2024-01-01T00:00:00Z",
        txHash: "abc123",
        topic: [
          xdr.ScVal.scvSymbol("pmt_rec"),
          nativeToScVal("trip-1", { type: "string" }),
        ],
        value: nativeToScVal(["exp-1", "GAAAA", "2500000"]),
      },
      {
        ledger: 102,
        ledgerClosedAt: "2024-01-01T00:05:00Z",
        txHash: "def456",
        topic: [
          xdr.ScVal.scvSymbol("pmt_rec"),
          nativeToScVal("trip-1", { type: "string" }),
        ],
        value: nativeToScVal(["exp-2", "GAAAA", "3500000"]),
      },
    ];

    const parsed1 = parsePaymentEvent(rawEvents[0]);
    const parsed2 = parsePaymentEvent(rawEvents[1]);

    expect(parsed1).toEqual(expect.objectContaining({
      expenseId: "exp-1",
      member: "GAAAA",
      amountStroops: "2500000",
    }));

    expect(parsed2).toEqual(expect.objectContaining({
      expenseId: "exp-2",
      member: "GAAAA",
      amountStroops: "3500000",
    }));
  });
});

describe("fetchContractEvents", () => {
  beforeEach(() => {
    jest.mocked(sorobanServer.getEvents).mockReset();
    jest.mocked(sorobanServer.getLatestLedger).mockReset();
  });

  it("fetches and parses additional pages when a page reaches the limit", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => rawPaymentEvent(index));
    const secondPage = [rawPaymentEvent(200), rawPaymentEvent(201)];

    jest.mocked(sorobanServer.getEvents)
      .mockResolvedValueOnce({
        events: firstPage,
        latestLedger: 500,
        cursor: "page-1",
      } as any)
      // No cursor on the final page: that, not a short page, is what tells
      // fetchContractEvents the stream is drained. RPC may return fewer than
      // `limit` records and still have more behind the cursor, so handing back
      // "page-2" here would correctly provoke a third request.
      .mockResolvedValueOnce({
        events: secondPage,
        latestLedger: 501,
      } as any);

    const result = await fetchContractEvents(42, "trip-1");

    expect(result.events).toHaveLength(202);
    expect(result.events[0]?.expenseId).toBe("exp-0");
    expect(result.events[201]?.expenseId).toBe("exp-201");
    expect(result.latestLedger).toBe(501);

    expect(sorobanServer.getEvents).toHaveBeenCalledTimes(2);
  });

  it("gracefully handles retention window expiry errors from RPC", async () => {
    jest.mocked(sorobanServer.getEvents).mockRejectedValueOnce(
      new Error("startLedger is before oldest ledger 1000")
    );

    const result = await fetchContractEvents(100, "trip-expired");

    expect(result.events).toEqual([]);
    expect(result.latestLedger).toBe(100);
  });
});
