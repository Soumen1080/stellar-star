import {
  reconcileTripWithChainState,
  reconcileTripFromChain,
} from "@/lib/settlement/reconcile";
import { getContractPayments } from "@/lib/stellar/contract";
import { fetchContractEvents, buildPaymentEventKey } from "@/lib/stellar/events";
import { markSharePaidRow } from "@/lib/supabase/queries";
import { CIRCLE_USDC_ISSUER_TESTNET } from "@/lib/stellar/assets";
import type { Expense } from "@/types/expense";

jest.mock("@/lib/utils/constants", () => {
  const actual = jest.requireActual("@/lib/utils/constants");
  return {
    ...actual,
    CONTRACT_ID: "contract-test-id",
  };
});

jest.mock("@/lib/stellar/contract", () => ({
  getContractPayments: jest.fn(),
  checkIsPaid: jest.fn(),
}));

jest.mock("@/lib/stellar/events", () => {
  const actual = jest.requireActual("@/lib/stellar/events");
  return {
    ...actual,
    fetchContractEvents: jest.fn(),
  };
});

jest.mock("@/lib/supabase/queries", () => ({
  markSharePaidRow: jest.fn().mockResolvedValue(undefined),
  fetchActiveSettlementIntents: jest.fn().mockResolvedValue([]),
}));

const mockedGetContractPayments = getContractPayments as jest.MockedFunction<typeof getContractPayments>;
const mockedFetchContractEvents = fetchContractEvents as jest.MockedFunction<typeof fetchContractEvents>;
const mockedMarkSharePaidRow = markSharePaidRow as jest.MockedFunction<typeof markSharePaidRow>;

describe("On-chain Reconciliation Engine", () => {
  const memberWalletA = "GA".padEnd(56, "A");
  const memberWalletB = "GB".padEnd(56, "B");
  const usdcAsset = `USDC:${CIRCLE_USDC_ISSUER_TESTNET}`;

  const mockExpenses: Expense[] = [
    {
      id: "exp-xlm-1",
      title: "Dinner XLM",
      totalAmount: "20.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m-b",
      members: [
        { id: "m-a", name: "Alice", walletAddress: memberWalletA },
        { id: "m-b", name: "Bob", walletAddress: memberWalletB },
      ],
      shares: [
        {
          memberId: "m-a",
          name: "Alice",
          walletAddress: memberWalletA,
          amount: "10.0000000",
          paid: false,
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      settled: false,
    },
    {
      id: "exp-usdc-1",
      title: "Hotel USDC",
      totalAmount: "20.0000000",
      currency: usdcAsset,
      splitMode: "equal",
      paidByMemberId: "m-b",
      members: [
        { id: "m-a", name: "Alice", walletAddress: memberWalletA },
        { id: "m-b", name: "Bob", walletAddress: memberWalletB },
      ],
      shares: [
        {
          memberId: "m-a",
          name: "Alice",
          walletAddress: memberWalletA,
          amount: "10.0000000",
          paid: false,
        },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      settled: false,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Invariant 1: Exact matching across asset, amount, member, and expense", () => {
    it("does not match a 10 USDC payment against a 10 XLM expense", async () => {
      const usdcPayment = {
        tripId: "trip-1",
        expenseId: "exp-xlm-1", // Targets the XLM expense but with USDC asset
        member: memberWalletA,
        amountStroops: 100000000n, // 10 units in stroops
        asset: usdcAsset,
        txHash: "tx-usdc-payment",
        timestamp: 1700000000,
        payer: memberWalletB,
      };

      const result = await reconcileTripWithChainState("trip-1", mockExpenses, [usdcPayment]);

      expect(result.reconciledCount).toBe(0);
      expect(result.repairedExpenseIds).toEqual([]);
      expect(mockedMarkSharePaidRow).not.toHaveBeenCalled();
    });

    it("matches an exact XLM payment to an XLM expense", async () => {
      const xlmPayment = {
        tripId: "trip-1",
        expenseId: "exp-xlm-1",
        member: memberWalletA,
        amountStroops: 100000000n,
        asset: "native",
        txHash: "tx-xlm-payment",
        timestamp: 1700000000,
        payer: memberWalletB,
      };

      const result = await reconcileTripWithChainState("trip-1", mockExpenses, [xlmPayment]);

      expect(result.reconciledCount).toBe(1);
      expect(result.repairedExpenseIds).toEqual(["exp-xlm-1"]);
      expect(mockedMarkSharePaidRow).toHaveBeenCalledWith(
        "exp-xlm-1",
        "m-a",
        "tx-xlm-payment",
        undefined,
      );
    });

    it("matches an exact USDC payment to a USDC expense", async () => {
      const usdcPayment = {
        tripId: "trip-1",
        expenseId: "exp-usdc-1",
        member: memberWalletA,
        amountStroops: 100000000n,
        asset: usdcAsset,
        txHash: "tx-usdc-exact",
        timestamp: 1700000000,
        payer: memberWalletB,
      };

      const result = await reconcileTripWithChainState("trip-1", mockExpenses, [usdcPayment]);

      expect(result.reconciledCount).toBe(1);
      expect(result.repairedExpenseIds).toEqual(["exp-usdc-1"]);
      expect(mockedMarkSharePaidRow).toHaveBeenCalledWith(
        "exp-usdc-1",
        "m-a",
        "tx-usdc-exact",
        undefined,
      );
    });
  });

  describe("Invariant 2: Retention Window Expiry (Old Trips)", () => {
    it("reconciles completely from contract storage when RPC events are empty/expired", async () => {
      mockedGetContractPayments.mockResolvedValueOnce({
        success: true,
        payments: [
          {
            tripId: "trip-old",
            expenseId: "exp-xlm-1",
            payer: memberWalletB,
            member: memberWalletA,
            amountStroops: 100000000n,
            asset: "native",
            txHash: "tx-contract-durable",
            timestamp: 1690000000,
          },
        ],
      });

      // Events are completely empty because 24h retention window passed
      mockedFetchContractEvents.mockResolvedValueOnce({
        events: [],
        latestLedger: 9999,
      });

      const result = await reconcileTripFromChain("trip-old", mockExpenses);

      expect(result.source).toBe("state");
      expect(result.reconciledCount).toBe(1);
      expect(result.repairedExpenseIds).toEqual(["exp-xlm-1"]);
      expect(mockedMarkSharePaidRow).toHaveBeenCalledWith(
        "exp-xlm-1",
        "m-a",
        "tx-contract-durable",
        undefined,
      );
    });
  });

  describe("Invariant 3: Idempotence & Disagreement Resolution", () => {
    it("is idempotent and produces zero mutations when shares are already marked paid", async () => {
      const alreadyPaidExpenses: Expense[] = [
        {
          ...mockExpenses[0],
          shares: [
            {
              memberId: "m-a",
              name: "Alice",
              walletAddress: memberWalletA,
              amount: "10.0000000",
              paid: true, // already marked paid
            },
          ],
        },
      ];

      const xlmPayment = {
        tripId: "trip-1",
        expenseId: "exp-xlm-1",
        member: memberWalletA,
        amountStroops: 100000000n,
        asset: "native",
        txHash: "tx-xlm-payment",
        timestamp: 1700000000,
        payer: memberWalletB,
      };

      const result = await reconcileTripWithChainState("trip-1", alreadyPaidExpenses, [xlmPayment]);

      expect(result.reconciledCount).toBe(0);
      expect(mockedMarkSharePaidRow).not.toHaveBeenCalled();
    });

    it("merges and deduplicates when both contract state and live events report payments", async () => {
      mockedGetContractPayments.mockResolvedValueOnce({
        success: true,
        payments: [
          {
            tripId: "trip-1",
            expenseId: "exp-xlm-1",
            payer: memberWalletB,
            member: memberWalletA,
            amountStroops: 100000000n,
            asset: "native",
            txHash: "tx-shared",
            timestamp: 1700000000,
          },
        ],
      });

      mockedFetchContractEvents.mockResolvedValueOnce({
        events: [
          {
            ledger: 100,
            ledgerClosedAt: "2026-01-01T00:00:00Z",
            tripId: "trip-1",
            expenseId: "exp-xlm-1",
            member: memberWalletA,
            amountStroops: "100000000",
            asset: "native",
            txHash: "tx-shared",
          },
        ],
        latestLedger: 100,
      });

      const result = await reconcileTripFromChain("trip-1", mockExpenses);

      expect(result.source).toBe("merged");
      expect(result.reconciledCount).toBe(1);
      expect(mockedMarkSharePaidRow).toHaveBeenCalledTimes(1);
    });
  });

  describe("Invariant 5: Archived & TTL-expired contract storage handling", () => {
    it("handles isArchived state response gracefully and falls back to event stream", async () => {
      mockedGetContractPayments.mockResolvedValueOnce({
        success: true,
        isArchived: true,
        payments: [],
      });

      mockedFetchContractEvents.mockResolvedValueOnce({
        events: [
          {
            ledger: 50,
            ledgerClosedAt: "2026-01-01T00:00:00Z",
            tripId: "trip-1",
            expenseId: "exp-xlm-1",
            member: memberWalletA,
            amountStroops: "100000000",
            asset: "native",
            txHash: "tx-event-fallback",
          },
        ],
        latestLedger: 50,
      });

      const result = await reconcileTripFromChain("trip-1", mockExpenses);

      expect(result.source).toBe("events");
      expect(result.reconciledCount).toBe(1);
      expect(mockedMarkSharePaidRow).toHaveBeenCalledWith(
        "exp-xlm-1",
        "m-a",
        "tx-event-fallback",
        undefined,
      );
    });
  });
});
