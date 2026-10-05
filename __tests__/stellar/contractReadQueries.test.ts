import { nativeToScVal } from "@stellar/stellar-sdk";
import { checkIsPaid, getContractPayments } from "@/lib/stellar/contract";
import { sorobanServer } from "@/lib/stellar/soroban";
import { server } from "@/lib/stellar/client";

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    simulateTransaction: jest.fn(),
  },
}));

// `loadAccount` reaches Horizon through the SDK client, not global `fetch`
// (#227), so the account lookup is stubbed at that seam.
jest.mock("@/lib/stellar/client", () => ({
  server: {
    loadAccount: jest.fn(),
  },
}));

const UNFUNDED_CALLER =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FUNDED_SEQUENCE = "42";

/** What the SDK's `loadAccount` resolves with for a funded account. */
function horizonAccountResponse(sequence: string) {
  return { sequenceNumber: () => sequence };
}

/** How the SDK surfaces an account Horizon does not have. */
function horizonNotFoundError() {
  return Object.assign(new Error("Not Found"), { response: { status: 404 } });
}

function simulationSuccess(retval: ReturnType<typeof nativeToScVal>) {
  return {
    id: "sim-1",
    latestLedger: 1,
    events: [],
    results: [],
    transactionData: "",
    minResourceFee: "0",
    cost: { cpuInsns: "0", memBytes: "0" },
    result: {
      auth: [],
      retval,
    },
  };
}

describe("read-only contract queries with unfunded caller", () => {
  beforeEach(() => {
    jest.mocked(sorobanServer.simulateTransaction).mockReset();
    jest.mocked(server.loadAccount).mockReset();
  });

  it("checkIsPaid simulates with sequence 0 when Horizon returns 404", async () => {
    jest.mocked(server.loadAccount).mockRejectedValue(horizonNotFoundError());

    jest.mocked(sorobanServer.simulateTransaction).mockImplementation(async (tx) => {
      if (!("source" in tx)) {
        throw new Error("Expected a standard transaction for simulation");
      }
      expect(tx.source).toBe(UNFUNDED_CALLER);
      // TransactionBuilder increments the account sequence by 1 on build,
      // so Account("...", "0") yields a transaction with sequence "1".
      expect(tx.sequence).toBe("1");
      return simulationSuccess(nativeToScVal(false)) as unknown as Awaited<
        ReturnType<typeof sorobanServer.simulateTransaction>
      >;
    });

    const result = await checkIsPaid(UNFUNDED_CALLER, "exp-1", UNFUNDED_CALLER);

    expect(result).toEqual({ paid: false, success: true });
    expect(sorobanServer.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("getContractPayments simulates with sequence 0 when Horizon returns 404", async () => {
    jest.mocked(server.loadAccount).mockRejectedValue(horizonNotFoundError());

    jest.mocked(sorobanServer.simulateTransaction).mockImplementation(async (tx) => {
      if (!("source" in tx)) {
        throw new Error("Expected a standard transaction for simulation");
      }
      expect(tx.source).toBe(UNFUNDED_CALLER);
      // TransactionBuilder increments the account sequence by 1 on build,
      // so Account("...", "0") yields a transaction with sequence "1".
      expect(tx.sequence).toBe("1");
      return simulationSuccess(
        nativeToScVal([
          {
            expense_id: "exp-1",
            payer: UNFUNDED_CALLER,
            member: UNFUNDED_CALLER,
            amount: 1_000_000n,
            tx_hash: "abc",
            timestamp: 1n,
          },
        ])
      ) as unknown as Awaited<ReturnType<typeof sorobanServer.simulateTransaction>>;
    });

    const result = await getContractPayments(UNFUNDED_CALLER, "trip-1");

    expect(result.success).toBe(true);
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]?.expenseId).toBe("exp-1");
  });

  it("checkIsPaid still uses Horizon sequence for funded callers", async () => {
    jest
      .mocked(server.loadAccount)
      .mockResolvedValue(
        horizonAccountResponse(FUNDED_SEQUENCE) as unknown as Awaited<
          ReturnType<typeof server.loadAccount>
        >,
      );

    jest.mocked(sorobanServer.simulateTransaction).mockImplementation(async (tx) => {
      if (!("sequence" in tx)) {
        throw new Error("Expected a standard transaction for simulation");
      }
      return simulationSuccess(nativeToScVal(true)) as unknown as Awaited<
        ReturnType<typeof sorobanServer.simulateTransaction>
      >;
    });

    const result = await checkIsPaid(UNFUNDED_CALLER, "exp-2", UNFUNDED_CALLER);

    expect(result).toEqual({ paid: true, success: true });
  });
});
