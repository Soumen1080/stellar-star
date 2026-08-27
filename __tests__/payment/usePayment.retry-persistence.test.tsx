/** @jest-environment jsdom */
/**
 * usePayment retry-persistence tests
 *
 * Verifies that pending on-chain retry data is durably written to / restored
 * from localStorage so that partial-success payments survive page refreshes.
 */

import {
  savePendingOnChain,
  loadPendingOnChain,
  clearPendingOnChain,
  type PendingOnChainRecord,
} from "@/lib/utils/pendingOnChain";
import { LS_PENDING_ON_CHAIN } from "@/lib/utils/constants";

const { act, renderHook, waitFor } = require("@testing-library/react");

// ---------------------------------------------------------------------------
// Module mocks (must be declared before any require() of the hook)
// ---------------------------------------------------------------------------

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
  checkIsPaid,
  precheckPoolBalance,
  recordPaymentOnChain,
  getPoolBalanceStroops,
} from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import type { SplitShare } from "@/types/expense";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PAYER    = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const share: SplitShare = {
  memberId:      "member-1",
  name:          "Alice",
  walletAddress: WALLET_A,
  amount:        "2.0000000",
  paid:          false,
};

// ---------------------------------------------------------------------------
// Helper — trigger a partial-success payment for a given hook result
// ---------------------------------------------------------------------------

async function triggerPartialSuccess(
  result: ReturnType<typeof renderHook>["result"],
) {
  await act(async () => {
    await result.current.payShare({
      share,
      expenseTitle: "Dinner",
      payerWalletAddress: PAYER,
      tripId: "trip-persist",
    });
  });
  await waitFor(() =>
    expect(result.current.paymentState.status).toBe("partial_success"),
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("usePayment — retry persistence", () => {
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
      publicKey:       WALLET_A,
      refreshBalance:  mockRefreshBalance,
    });
    mockedUseExpense.mockReturnValue({ markSharePaid: mockMarkSharePaid });
    mockedUseToast.mockReturnValue({
      success: mockToastSuccess,
      error:   mockToastError,
      info:    mockToastInfo,
    });

    jest.mocked(buildPaymentTransaction).mockResolvedValue({
      xdr: "unsigned-xdr",
      memo: "Dinner|Alice",
    });
    jest.mocked(signXDR).mockResolvedValue("signed-xdr");
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: "tx-persist-hash",
      ledger: 500,
      successful: true,
    });
    jest.mocked(checkIsPaid).mockResolvedValue({ paid: false, success: true });
    jest.mocked(precheckPoolBalance).mockResolvedValue({
      ok: true,
      requiredStroops: 20000000n,
      balanceStroops:  20000000n,
    });
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
    jest.mocked(recordPaymentOnChain).mockResolvedValue({
      success: false,
      error:   "Soroban node busy",
    });
    jest.mocked(getPoolBalanceStroops).mockResolvedValue(20000000n);
  });

  // ── 1. Pending record is written to localStorage on partial failure ──────

  it("writes pending record to localStorage when on-chain recording fails", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: "exp-persist-1" }));

    await triggerPartialSuccess(result);

    // hasPendingRetry should be true
    expect(result.current.hasPendingRetry).toBe(true);

    // localStorage must contain the serialised record
    const stored = loadPendingOnChain(WALLET_A, "exp-persist-1");
    expect(stored).not.toBeNull();
    expect(stored!.txHash).toBe("tx-persist-hash");
    expect(stored!.expenseId).toBe("exp-persist-1");
    expect(stored!.memberPublicKey).toBe(WALLET_A);
  });

  // ── 2. Pending state is restored from localStorage on fresh mount ────────

  it("restores pending retry state from localStorage on mount", async () => {
    // Pre-seed localStorage as if a previous session stored a record
    const record: PendingOnChainRecord = {
      memberPublicKey: WALLET_A,
      tripId:          "trip-restore",
      expenseId:       "exp-persist-2",
      payerPublicKey:  PAYER,
      amountXlm:       "2.0000000",
      memoText:        "Dinner|Alice",
      txHash:          "tx-restore-hash",
      ledger:          600,
    };
    savePendingOnChain(WALLET_A, record);

    // Mount a fresh hook instance (simulates page refresh)
    const { result } = renderHook(() => usePayment({ expenseId: "exp-persist-2" }));

    await waitFor(() =>
      expect(result.current.paymentState.status).toBe("partial_success"),
    );

    expect(result.current.hasPendingRetry).toBe(true);
    expect(result.current.txHash).toBe("tx-restore-hash");
  });

  // ── 3. localStorage is cleared after a successful retry ─────────────────

  it("clears localStorage after a successful on-chain retry", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: "exp-persist-3" }));

    // First call fails, second succeeds
    jest
      .mocked(recordPaymentOnChain)
      .mockResolvedValueOnce({ success: false, error: "Busy" })
      .mockResolvedValueOnce({ success: true, ledger: 700 });

    await triggerPartialSuccess(result);
    expect(loadPendingOnChain(WALLET_A, "exp-persist-3")).not.toBeNull();

    // Now retry succeeds
    jest.mocked(precheckPoolBalance).mockResolvedValue({
      ok: true,
      requiredStroops: 20000000n,
      balanceStroops:  20000000n,
    });
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

    await act(async () => {
      await result.current.retryOnChainRecord();
    });

    await waitFor(() =>
      expect(result.current.paymentState.status).toBe("success"),
    );

    // localStorage entry must be gone
    expect(loadPendingOnChain(WALLET_A, "exp-persist-3")).toBeNull();
    expect(result.current.hasPendingRetry).toBe(false);
  });

  // ── 4. reset() clears localStorage ──────────────────────────────────────

  it("clears localStorage when reset() is called", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: "exp-persist-4" }));

    await triggerPartialSuccess(result);
    expect(loadPendingOnChain(WALLET_A, "exp-persist-4")).not.toBeNull();

    act(() => { result.current.reset(); });

    expect(loadPendingOnChain(WALLET_A, "exp-persist-4")).toBeNull();
    expect(result.current.hasPendingRetry).toBe(false);
    expect(result.current.paymentState.status).toBe("idle");
  });

  // ── 5. Records are wallet-scoped (different wallet = no restore) ─────────

  it("does not restore records belonging to a different wallet", async () => {
    // Store a record under WALLET_B
    const record: PendingOnChainRecord = {
      memberPublicKey: WALLET_B,
      tripId:          "trip-other",
      expenseId:       "exp-persist-5",
      payerPublicKey:  PAYER,
      amountXlm:       "1.0000000",
      memoText:        "Dinner|Alice",
      txHash:          "tx-other-wallet",
      ledger:          800,
    };
    savePendingOnChain(WALLET_B, record);

    // Mount hook as WALLET_A
    const { result } = renderHook(() => usePayment({ expenseId: "exp-persist-5" }));

    // Give mount effect time to settle
    await act(async () => {});

    // WALLET_A has no persisted record for this expense — state stays idle
    expect(result.current.paymentState.status).toBe("idle");
    expect(result.current.hasPendingRetry).toBe(false);

    // WALLET_B record must still be intact in storage
    expect(loadPendingOnChain(WALLET_B, "exp-persist-5")).not.toBeNull();
  });

  // ── 6. pendingOnChain utility: clearPendingOnChain removes wallet key when empty

  it("pendingOnChain utility removes the wallet-level key when all expenses cleared", () => {
    const record: PendingOnChainRecord = {
      memberPublicKey: WALLET_A,
      tripId:          "t",
      expenseId:       "e-only",
      payerPublicKey:  PAYER,
      amountXlm:       "1",
      memoText:        "Dinner|Alice",
      txHash:          "h",
      ledger:          1,
    };
    savePendingOnChain(WALLET_A, record);
    clearPendingOnChain(WALLET_A, "e-only");

    const raw = localStorage.getItem(LS_PENDING_ON_CHAIN);
    const parsed = raw ? JSON.parse(raw) : {};
    // Wallet-level key should be pruned
    expect(parsed[WALLET_A]).toBeUndefined();
  });
});
