/** @jest-environment jsdom */
/**
 * useNetPayment tests
 *
 * Mirrors usePayment.retry-persistence.test.tsx for the net-settlement flow
 * (Issue #79): verifies that recordNetSettlementOnChain is actually invoked
 * after the Stellar transfer, that Supabase shares are synced regardless of
 * contract outcome, and that a partial (contract-recording) failure is
 * persisted to localStorage and recoverable via retryOnChainRecord.
 */

const { act, renderHook, waitFor } = require("@testing-library/react");

jest.mock("@/lib/stellar/buildTransaction");
jest.mock("@/lib/stellar/submitTransaction");
jest.mock("@/lib/stellar/contract");
jest.mock("@/lib/settlement/settleOnChain");
jest.mock("@/lib/freighter");
jest.mock("@/hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/components/ui/Toast", () => ({ useToast: jest.fn() }));

/** Minimal attestation shape; the hooks only pass it through to the contract. */
const STUB_ATTESTATION = {
  claim: {
    contractId: "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    tripId: "trip-1",
    expenseId: "exp-1",
    payer: "GPAYER",
    member: "GMEMBER",
    amountStroops: "10000000",
    asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    txHash: "a".repeat(64),
    nonce: "b".repeat(64),
    expiresAt: 1900000000,
  },
  signature: "c".repeat(128),
  oraclePublicKey: "GORACLE",
};


import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  precheckPoolBalance,
  recordNetSettlementOnChain,
  getPoolBalanceStroops,
} from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import {
  loadPendingNetSettlement,
  type PendingNetSettlementRecord,
} from "@/lib/utils/pendingOnChain";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAYER    = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const debts = [
  { expenseId: "exp-1", fromId: "member-1", toId: "member-2", from: "Alice", to: "Bob", amount: 3, fromWallet: WALLET_A, toWallet: PAYER },
  { expenseId: "exp-2", fromId: "member-1", toId: "member-2", from: "Alice", to: "Bob", amount: 2, fromWallet: WALLET_A, toWallet: PAYER },
];

async function triggerPay(result: ReturnType<typeof renderHook>["result"]) {
  await act(async () => {
    await result.current.payNetSettlement({
      debts,
      totalAmountXlm: "5.0000000",
      payerWalletAddress: PAYER,
      tripName: "Weekend Trip",
    });
  });
}

describe("useNetPayment — on-chain recording (Issue #79)", () => {
  const { useNetPayment } =
    require("@/hooks/useNetPayment") as typeof import("@/hooks/useNetPayment");

  const mockedUseWallet = (jest.requireMock("@/hooks/useWallet") as { useWallet: jest.Mock }).useWallet;
  const mockedUseExpense = (jest.requireMock("@/hooks/useExpense") as { useExpense: jest.Mock }).useExpense;
  const mockedUseToast = (jest.requireMock("@/components/ui/Toast") as { useToast: jest.Mock }).useToast;

  const mockRefreshBalance = jest.fn();
  const mockMarkSharePaid  = jest.fn(async () => {});

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();

    mockedUseWallet.mockReturnValue({ publicKey: WALLET_A, refreshBalance: mockRefreshBalance });
    mockedUseExpense.mockReturnValue({ markSharePaid: mockMarkSharePaid });
    mockedUseToast.mockReturnValue({ success: jest.fn(), error: jest.fn(), info: jest.fn() });

    jest.mocked(buildPaymentTransaction).mockResolvedValue({ xdr: "unsigned-xdr", memo: "Weekend Trip" });
    jest.mocked(signXDR).mockResolvedValue("signed-xdr");
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: "tx-net-hash",
      ledger: 500,
      successful: true,
    });
    jest.mocked(precheckPoolBalance).mockResolvedValue({
      ok: true,
      requiredStroops: 50000000n,
      balanceStroops: 50000000n,
    });
    jest.mocked(getPoolBalanceStroops).mockResolvedValue(50000000n);
    const settleMod = jest.requireMock("@/lib/settlement/settleOnChain") as {
      fetchAttestation: jest.Mock;
      fetchAttestationsForDebts: jest.Mock;
      xlmToStroopsString: jest.Mock;
    };
    // A stand-in oracle that always attests. The adversarial cases for the
    // attestation itself live in __tests__/settlement and in the contract.
    settleMod.fetchAttestation.mockResolvedValue({ ok: true, attestation: STUB_ATTESTATION });
    settleMod.fetchAttestationsForDebts.mockResolvedValue({
      ok: true,
      attestations: [STUB_ATTESTATION, STUB_ATTESTATION, STUB_ATTESTATION],
    });
    settleMod.xlmToStroopsString.mockImplementation((xlm: string) => xlm);
    jest.mocked(recordNetSettlementOnChain).mockResolvedValue({ success: true, ledger: 501 });
  });

  it("invokes the contract once per underlying debt and marks success with onChain: true", async () => {
    const { result } = renderHook(() => useNetPayment({ tripId: "trip-1" }));

    await triggerPay(result);

    await waitFor(() => expect(result.current.paymentState.status).toBe("success"));
    expect(result.current.onChain).toBe(true);

    expect(recordNetSettlementOnChain).toHaveBeenCalledTimes(1);
    const call = jest.mocked(recordNetSettlementOnChain).mock.calls[0][0];
    expect(call.debts).toEqual([
      { expenseId: "exp-1", amountXlm: "3" },
      { expenseId: "exp-2", amountXlm: "2" },
    ]);
    expect(call.tripId).toBe("trip-1");
    expect(call.payerPublicKey).toBe(PAYER);

    // Supabase is synced for every underlying share once the settlement succeeds.
    expect(mockMarkSharePaid).toHaveBeenCalledTimes(2);
    expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-1", "member-1", "tx-net-hash");
    expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-2", "member-1", "tx-net-hash");
  });

  it("persists a pending record and reports partial_success when contract recording fails", async () => {
    jest.mocked(recordNetSettlementOnChain).mockResolvedValue({
      success: false,
      error: "Soroban node busy",
    });

    const { result } = renderHook(() => useNetPayment({ tripId: "trip-1" }));
    await triggerPay(result);

    await waitFor(() => expect(result.current.paymentState.status).toBe("partial_success"));
    expect(result.current.onChain).toBe(false);
    expect(result.current.hasPendingRetry).toBe(true);

    // Money moved (Stellar transfer succeeded) so shares are still marked paid -
    // the UI is responsible for showing "paid, not yet on-chain" via onChain: false.
    expect(mockMarkSharePaid).toHaveBeenCalledTimes(2);

    const stored = loadPendingNetSettlement(WALLET_A, "trip-1", PAYER);
    expect(stored).not.toBeNull();
    expect(stored!.txHash).toBe("tx-net-hash");
    expect(stored!.debts).toEqual([
      { expenseId: "exp-1", amountXlm: "3" },
      { expenseId: "exp-2", amountXlm: "2" },
    ]);
  });

  it("restores a persisted pending record via loadPendingForPayer", async () => {
    const record: PendingNetSettlementRecord = {
      memberPublicKey: WALLET_A,
      tripId: "trip-restore",
      payerPublicKey: PAYER,
      totalAmountXlm: "5.0000000",
      memoText: "Weekend Trip",
      txHash: "tx-restore-hash",
      ledger: 600,
      debts: [{ expenseId: "exp-1", amountXlm: "3" }],
    };
    const { savePendingNetSettlement } = require("@/lib/utils/pendingOnChain");
    savePendingNetSettlement(WALLET_A, record);

    const { result } = renderHook(() => useNetPayment({ tripId: "trip-restore" }));
    act(() => result.current.loadPendingForPayer(PAYER));

    await waitFor(() => expect(result.current.paymentState.status).toBe("partial_success"));
    expect(result.current.hasPendingRetry).toBe(true);
    expect(result.current.txHash).toBe("tx-restore-hash");
  });

  it("clears the pending record and reaches on-chain success after a successful retry", async () => {
    jest.mocked(recordNetSettlementOnChain).mockResolvedValue({
      success: false,
      error: "Busy",
    });
    const { result } = renderHook(() => useNetPayment({ tripId: "trip-1" }));
    await triggerPay(result);
    await waitFor(() => expect(result.current.paymentState.status).toBe("partial_success"));
    expect(loadPendingNetSettlement(WALLET_A, "trip-1", PAYER)).not.toBeNull();

    jest.mocked(recordNetSettlementOnChain).mockResolvedValue({ success: true, ledger: 700 });
    await act(async () => {
      await result.current.retryOnChainRecord();
    });

    await waitFor(() => expect(result.current.paymentState.status).toBe("success"));
    expect(result.current.onChain).toBe(true);
    expect(loadPendingNetSettlement(WALLET_A, "trip-1", PAYER)).toBeNull();
    expect(result.current.hasPendingRetry).toBe(false);
  });

  it("does not restore a pending record belonging to a different wallet", async () => {
    const record: PendingNetSettlementRecord = {
      memberPublicKey: WALLET_B,
      tripId: "trip-other",
      payerPublicKey: PAYER,
      totalAmountXlm: "1.0000000",
      memoText: "Other",
      txHash: "tx-other",
      ledger: 800,
      debts: [{ expenseId: "exp-x", amountXlm: "1" }],
    };
    const { savePendingNetSettlement } = require("@/lib/utils/pendingOnChain");
    savePendingNetSettlement(WALLET_B, record);

    const { result } = renderHook(() => useNetPayment({ tripId: "trip-other" }));
    act(() => result.current.loadPendingForPayer(PAYER));

    expect(result.current.paymentState.status).toBe("idle");
    expect(result.current.hasPendingRetry).toBe(false);
    expect(loadPendingNetSettlement(WALLET_B, "trip-other", PAYER)).not.toBeNull();
  });
});
