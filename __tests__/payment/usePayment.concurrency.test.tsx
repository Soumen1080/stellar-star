/** @jest-environment jsdom */
/**
 * usePayment.concurrency.test.tsx
 *
 * Verifies that usePayment properly checks for durable intents,
 * blocks concurrent payments on the same share, and updates intent status.
 */

const { act, renderHook, waitFor } = require("@testing-library/react");

jest.mock("@/lib/stellar/buildTransaction");
jest.mock("@/lib/stellar/submitTransaction");
jest.mock("@/lib/stellar/contract");
jest.mock("@/lib/settlement/settleOnChain");
jest.mock("@/lib/settlement/intent");
jest.mock("@/lib/settlement/reconcile");
jest.mock("@/lib/freighter");
jest.mock("@/hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/components/ui/Toast", () => ({ useToast: jest.fn() }));

import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  checkIsPaid,
  precheckPoolBalance,
  recordPaymentOnChain,
  getPoolBalanceStroops,
} from "@/lib/stellar/contract";
import {
  acquireSettlementIntent,
  markIntentSubmitted,
  markIntentRecorded,
  markIntentFailed,
} from "@/lib/settlement/intent";
import {
  reconcileSettlementIntent,
  reconcilePendingIntentsForWallet,
} from "@/lib/settlement/reconcile";
import { signXDR } from "@/lib/freighter";
import type { SplitShare } from "@/types/expense";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAYER    = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const share: SplitShare = {
  memberId:      "member-1",
  name:          "Alice",
  walletAddress: WALLET_A,
  amount:        "2.0000000",
  paid:          false,
};

describe("usePayment — concurrency and durable intents", () => {
  const { usePayment } =
    require("@/hooks/usePayment") as typeof import("@/hooks/usePayment");

  const mockedUseWallet = (
    jest.requireMock("@/hooks/useWallet") as { useWallet: jest.Mock }
  ).useWallet;
  const mockedUseExpense = (
    jest.requireMock("@/hooks/useExpense") as { useExpense: jest.Mock }
  ).useExpense;
  const mockedUseToast = (
    jest.requireMock("@/components/ui/Toast") as { useToast: jest.Mock }
  ).useToast;

  const mockRefreshBalance = jest.fn();
  const mockMarkSharePaid  = jest.fn(async () => {});
  const mockToastSuccess   = jest.fn();
  const mockToastError     = jest.fn();
  const mockToastInfo      = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();

    mockedUseWallet.mockReturnValue({
      publicKey: WALLET_A,
      refreshBalance: mockRefreshBalance,
    });
    mockedUseExpense.mockReturnValue({ markSharePaid: mockMarkSharePaid });
    mockedUseToast.mockReturnValue({
      success: mockToastSuccess,
      error: mockToastError,
      info: mockToastInfo,
    });

    jest.mocked(buildPaymentTransaction).mockResolvedValue({
      xdr: "unsigned-xdr",
      memo: "Dinner|Alice",
    });
    jest.mocked(signXDR).mockResolvedValue("signed-xdr");
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: "tx-intent-hash",
      ledger: 500,
      successful: true,
    });
    jest.mocked(checkIsPaid).mockResolvedValue({ paid: false, success: true });
    jest.mocked(precheckPoolBalance).mockResolvedValue({
      ok: true,
      requiredStroops: 20000000n,
      balanceStroops: 20000000n,
    });
    jest.mocked(getPoolBalanceStroops).mockResolvedValue(20000000n);
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 501 });

    const settleMod = jest.requireMock("@/lib/settlement/settleOnChain") as {
      fetchAttestation: jest.Mock;
    };
    settleMod.fetchAttestation.mockResolvedValue({
      ok: true,
      attestation: {
        claim: {
          contractId: "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
          tripId: "trip-1",
          expenseId: "exp-1",
          payer: PAYER,
          member: WALLET_A,
          amountStroops: "20000000",
          asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
          txHash: "tx-intent-hash",
          nonce: "nonce-1",
          expiresAt: 1900000000,
        },
        signature: "sig-1",
        oraclePublicKey: "GORACLE",
      },
    });

    jest.mocked(acquireSettlementIntent).mockResolvedValue({
      ok: true,
      intent: {
        id: "intent-1",
        idempotencyKey: "settle:trip-1:exp-1:member-1",
        tripId: "trip-1",
        expenseId: "exp-1",
        memberId: "member-1",
        payerWallet: PAYER,
        memberWallet: WALLET_A,
        amount: "2.0000000",
        currency: "XLM",
        status: "submitting",
        txHash: null,
        ledger: null,
        onChain: false,
        errorMessage: null,
        createdByWallet: WALLET_A,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    });
    jest.mocked(markIntentSubmitted).mockResolvedValue({} as any);
    jest.mocked(markIntentRecorded).mockResolvedValue({} as any);
    jest.mocked(markIntentFailed).mockResolvedValue({} as any);
    jest.mocked(reconcilePendingIntentsForWallet).mockResolvedValue([]);
  });

  it("acquires intent before transaction submit and marks intent submitted immediately upon payment", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: "exp-1" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: PAYER,
        tripId: "trip-1",
      });
    });

    await waitFor(() => expect(result.current.paymentState.status).toBe("success"));

    // Intent was acquired
    expect(acquireSettlementIntent).toHaveBeenCalledWith({
      tripId: "trip-1",
      expenseId: "exp-1",
      memberId: "member-1",
      payerWallet: PAYER,
      memberWallet: WALLET_A,
      amount: "2.0000000",
    });

    // Intent was marked submitted with txHash
    expect(markIntentSubmitted).toHaveBeenCalledWith("intent-1", "tx-intent-hash", 500);

    // Intent was marked recorded
    expect(markIntentRecorded).toHaveBeenCalledWith("intent-1", 501, true);
  });

  it("blocks payment and sets blocked state when another client has an in-progress intent", async () => {
    jest.mocked(acquireSettlementIntent).mockResolvedValue({
      ok: false,
      code: "IN_PROGRESS",
      intent: {
        id: "intent-locked",
        idempotencyKey: "settle:trip-1:exp-1:member-1",
        tripId: "trip-1",
        expenseId: "exp-1",
        memberId: "member-1",
        payerWallet: PAYER,
        memberWallet: "GOTHER",
        amount: "2.0000000",
        currency: "XLM",
        status: "submitting",
        txHash: null,
        ledger: null,
        onChain: false,
        errorMessage: null,
        createdByWallet: "GOTHER",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
      message: "Another client is currently settling this share.",
    });

    const { result } = renderHook(() => usePayment({ expenseId: "exp-1" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: PAYER,
        tripId: "trip-1",
      });
    });

    expect(result.current.paymentState.status).toBe("blocked");
    expect(buildPaymentTransaction).not.toHaveBeenCalled();
    expect(submitSignedTransaction).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Settlement in progress",
      "Another client is currently settling this share.",
    );
  });
});
