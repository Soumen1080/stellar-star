import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  fetchContractEvents,
  isRetentionWindowError,
} from "@/lib/stellar/events";
import { sorobanServer } from "@/lib/stellar/soroban";

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    getEvents: jest.fn(),
    getLatestLedger: jest.fn(),
  },
}));

jest.mock("@/lib/utils/constants", () => {
  const actual = jest.requireActual("@/lib/utils/constants");
  return { ...actual, CONTRACT_ID: "CONTRACT_TEST_ID" };
});

const mockedGetEvents = sorobanServer.getEvents as jest.Mock;
const mockedGetLatestLedger = sorobanServer.getLatestLedger as jest.Mock;

function rawPaymentEvent(index: number) {
  return {
    ledger: 100 + index,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    txHash: `tx-${index}`,
    topic: [
      xdr.ScVal.scvSymbol("pmt_rec"),
      nativeToScVal("trip-1", { type: "string" }),
    ],
    value: nativeToScVal([`exp-${index}`, "GAAAA", String(index + 1)]),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetLatestLedger.mockResolvedValue({ sequence: 10_000 });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("isRetentionWindowError", () => {
  it("recognises the RPC responses that mean the ledger range was pruned", () => {
    expect(
      isRetentionWindowError(new Error("startLedger must be within the ledger range")),
    ).toBe(true);
    expect(
      isRetentionWindowError(new Error("start ledger 12 is outside of retention window")),
    ).toBe(true);
    expect(isRetentionWindowError(new Error("ledger data is pruned"))).toBe(true);
  });

  it("does not classify unrelated failures as retention expiry", () => {
    expect(isRetentionWindowError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isRetentionWindowError(new Error("invalid contract id"))).toBe(false);
  });
});

describe("fetchContractEvents — retention expiry", () => {
  it("flags retentionExpired instead of reporting an empty, authoritative result", async () => {
    mockedGetEvents.mockRejectedValue(
      new Error("startLedger 5 is before the oldest retained ledger"),
    );

    const result = await fetchContractEvents(5, "trip-1");

    expect(result.retentionExpired).toBe(true);
    expect(result.events).toEqual([]);
    // The caller must be able to distinguish "no payments" from "cannot know".
    expect(result.truncated).toBe(false);
  });

  it("keeps retentionExpired false for ordinary transport failures", async () => {
    mockedGetEvents.mockRejectedValue(new Error("socket hang up"));

    const result = await fetchContractEvents(9_500, "trip-1");

    expect(result.retentionExpired).toBe(false);
    expect(result.error).toContain("socket hang up");
  });
});

describe("fetchContractEvents — exhaustive pagination", () => {
  it("follows the cursor through a short page rather than stopping early", async () => {
    // A page smaller than the limit is not end-of-stream: the cursor is.
    mockedGetEvents
      .mockResolvedValueOnce({
        events: [rawPaymentEvent(0)],
        latestLedger: 10_000,
        cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        events: [rawPaymentEvent(1)],
        latestLedger: 10_000,
        cursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        events: [rawPaymentEvent(2)],
        latestLedger: 10_000,
        cursor: undefined,
      });

    const result = await fetchContractEvents(0, "trip-1");

    expect(mockedGetEvents).toHaveBeenCalledTimes(3);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.expenseId)).toEqual(["exp-0", "exp-1", "exp-2"]);
    expect(result.truncated).toBe(false);
  });

  it("passes the cursor and drops startLedger on subsequent pages", async () => {
    mockedGetEvents
      .mockResolvedValueOnce({
        events: [rawPaymentEvent(0)],
        latestLedger: 10_000,
        cursor: "cursor-1",
      })
      .mockResolvedValueOnce({ events: [rawPaymentEvent(1)], latestLedger: 10_000 });

    await fetchContractEvents(9_000, "trip-1");

    const firstCall = mockedGetEvents.mock.calls[0][0];
    const secondCall = mockedGetEvents.mock.calls[1][0];

    expect(firstCall.startLedger).toBe(9_000);
    expect(firstCall.pagination.cursor).toBeUndefined();
    // Soroban RPC rejects startLedger and cursor together.
    expect(secondCall.startLedger).toBeUndefined();
    expect(secondCall.pagination.cursor).toBe("cursor-1");
  });

  it("terminates when the server repeats a cursor instead of looping forever", async () => {
    mockedGetEvents.mockResolvedValue({
      events: [rawPaymentEvent(0)],
      latestLedger: 10_000,
      cursor: "stuck",
    });

    const result = await fetchContractEvents(0, "trip-1");

    // First page sets the cursor, second returns the same one and stops.
    expect(mockedGetEvents).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(2);
  });

  it("reports truncated when the page budget runs out with records outstanding", async () => {
    let n = 0;
    mockedGetEvents.mockImplementation(async () => ({
      events: [rawPaymentEvent(n)],
      latestLedger: 10_000,
      cursor: `cursor-${n++}`,
    }));

    const result = await fetchContractEvents(0, "trip-1");

    // An active trip must never *silently* drop records past the page budget.
    expect(result.truncated).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
  });
});
