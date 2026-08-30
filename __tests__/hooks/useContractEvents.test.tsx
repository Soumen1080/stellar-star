/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useContractEvents } from "@/hooks/useContractEvents";
import { fetchContractEvents } from "@/lib/stellar/events";

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
      amountStroops: string;
    }) => `${event.tripId}:${event.expenseId}:${event.member.toLowerCase()}:${event.amountStroops}`,
    fetchContractEvents: jest.fn(),
  };
});

const mockedFetchContractEvents = fetchContractEvents as jest.MockedFunction<typeof fetchContractEvents>;

describe("useContractEvents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("preserves distinct payment events even when they share the same tx hash", async () => {
    mockedFetchContractEvents.mockResolvedValue({
      latestLedger: 120,
      events: [
        {
          ledger: 100,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          tripId: "trip-1",
          expenseId: "expense-1",
          member: "G".padEnd(56, "A"),
          amountStroops: "25000000",
          txHash: "tx-shared",
        },
        {
          ledger: 101,
          ledgerClosedAt: "2026-01-01T00:01:00Z",
          tripId: "trip-1",
          expenseId: "expense-2",
          member: "G".padEnd(56, "A"),
          amountStroops: "35000000",
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
});