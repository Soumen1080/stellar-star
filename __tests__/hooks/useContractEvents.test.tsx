/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor, act } from "@testing-library/react";
import { useContractEvents } from "@/hooks/useContractEvents";
import { fetchContractEvents, buildPaymentEventKey } from "@/lib/stellar/events";
import { getContractPayments } from "@/lib/stellar/contract";

jest.mock("@/lib/utils/constants", () => {
  const actual = jest.requireActual("@/lib/utils/constants");
  return {
    ...actual,
    CONTRACT_ID: "contract-test-id",
  };
});

jest.mock("@/lib/stellar/events", () => {
  return {
    buildPaymentEventKey: (event: {
      tripId: string;
      expenseId: string;
      member: string;
      amountStroops: string | bigint;
      asset?: string;
    }) =>
      `${event.tripId}:${event.expenseId}:${event.member.toLowerCase()}:${event.amountStroops.toString()}:${event.asset || "native"}`,
    fetchContractEvents: jest.fn(),
  };
});

jest.mock("@/lib/stellar/contract", () => {
  return {
    getContractPayments: jest.fn(),
  };
});

const mockedFetchContractEvents = fetchContractEvents as jest.MockedFunction<typeof fetchContractEvents>;
const mockedGetContractPayments = getContractPayments as jest.MockedFunction<typeof getContractPayments>;

describe("useContractEvents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetContractPayments.mockResolvedValue({
      payments: [],
      success: true,
    });
    mockedFetchContractEvents.mockResolvedValue({
      events: [],
      latestLedger: 100,
      retentionExpired: false,
      truncated: false,
    });
  });

  it("preserves distinct payment events even when they share the same tx hash", async () => {
    mockedFetchContractEvents.mockResolvedValue({
      latestLedger: 120,
      retentionExpired: false,
      truncated: false,
      events: [
        {
          ledger: 100,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          tripId: "trip-1",
          expenseId: "expense-1",
          member: "G".padEnd(56, "A"),
          amountStroops: "25000000",
          asset: "native",
          txHash: "tx-shared",
        },
        {
          ledger: 101,
          ledgerClosedAt: "2026-01-01T00:01:00Z",
          tripId: "trip-1",
          expenseId: "expense-2",
          member: "G".padEnd(56, "A"),
          amountStroops: "35000000",
          asset: "native",
          txHash: "tx-shared",
        },
      ],
    });

    const { result } = renderHook(() => useContractEvents("trip-1"));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });

    expect(result.current.events.map((event) => event.expenseId)).toEqual([
      "expense-1",
      "expense-2",
    ]);
    expect(result.current.latestLedger).toBe(120);
  });

  it("reconciles historical payments from contract state when event stream is empty (retention expiry)", async () => {
    mockedGetContractPayments.mockResolvedValue({
      success: true,
      payments: [
        {
          tripId: "trip-old",
          expenseId: "exp-historical",
          payer: "G".padEnd(56, "B"),
          member: "G".padEnd(56, "A"),
          amountStroops: 50000000n,
          asset: "native",
          txHash: "tx-historical",
          timestamp: 1700000000,
        },
      ],
    });

    mockedFetchContractEvents.mockResolvedValue({
      events: [],
      latestLedger: 500,
      retentionExpired: true,
      truncated: false,
    });

    const { result } = renderHook(() => useContractEvents("trip-old"));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    expect(result.current.events[0]).toMatchObject({
      tripId: "trip-old",
      expenseId: "exp-historical",
      member: "G".padEnd(56, "A"),
      amountStroops: "50000000",
      txHash: "tx-historical",
    });
  });

  it("deduplicates records present in both contract state and recent events", async () => {
    mockedGetContractPayments.mockResolvedValue({
      success: true,
      payments: [
        {
          tripId: "trip-1",
          expenseId: "exp-1",
          payer: "G".padEnd(56, "B"),
          member: "G".padEnd(56, "A"),
          amountStroops: 10000000n,
          asset: "native",
          txHash: "tx-1",
          timestamp: 1700000000,
        },
      ],
    });

    mockedFetchContractEvents.mockResolvedValue({
      events: [
        {
          ledger: 110,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          tripId: "trip-1",
          expenseId: "exp-1",
          member: "G".padEnd(56, "A"),
          amountStroops: "10000000",
          asset: "native",
          txHash: "tx-1",
        },
      ],
      latestLedger: 110,
      retentionExpired: false,
      truncated: false,
    });

    const { result } = renderHook(() => useContractEvents("trip-1"));

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    expect(result.current.events[0]?.expenseId).toBe("exp-1");
  });
});