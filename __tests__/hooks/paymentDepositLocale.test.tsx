/**
 * @jest-environment jsdom
 */

// Regression tests for issue #223.
//
// depositPool formats its success toast with formatMoney(amount, "XLM", locale)
// but omitted `locale` from its useCallback dependency array, in both
// usePayment and useNetPayment. The callback therefore held the locale from the
// render that created it.
//
// That is not only a problem for someone switching language mid-session.
// LocaleProvider initialises to "en-US" and only corrects to the saved or
// browser locale inside a mount effect, so for every non-en-US user the locale
// changes once immediately after mount, with no interaction at all. A callback
// captured before that effect formats German amounts with English separators —
// "1,234.57" where the user expects "1.234,57".
//
// These tests render through the real LocaleProvider so that mount-effect
// correction actually happens, then assert on the toast text. They fail against
// the old dependency array.

import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/context/LocaleContext";
import { usePayment } from "@/hooks/usePayment";
import { useNetPayment } from "@/hooks/useNetPayment";
import { depositPoolBalance, getPoolBalanceStroops } from "@/lib/stellar/contract";

const PUBLIC_KEY = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

const toastSuccess = jest.fn();
const toastError = jest.fn();

jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ success: toastSuccess, error: toastError, info: jest.fn() }),
}));

jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    publicKey: PUBLIC_KEY,
    refreshBalance: jest.fn(),
    network: "TESTNET",
  }),
}));

jest.mock("@/hooks/useExpense", () => ({
  useExpense: () => ({ markSharePaid: jest.fn() }),
}));

jest.mock("@/lib/stellar/contract", () => ({
  depositPoolBalance: jest.fn(),
  getPoolBalanceStroops: jest.fn(),
  stroopsToXlm: (s: string | bigint) => String(Number(s) / 10_000_000),
  recordPaymentOnChain: jest.fn(),
  recordNetSettlementOnChain: jest.fn(),
  checkIsPaid: jest.fn(),
  precheckPoolBalance: jest.fn().mockResolvedValue({ ok: true }),
}));

// Settlement/reconciliation side effects are irrelevant here and would reach
// the network or localStorage on mount.
jest.mock("@/lib/settlement/reconcile", () => ({
  reconcileSettlementIntent: jest.fn(),
  reconcilePendingIntentsForWallet: jest.fn().mockResolvedValue(undefined),
}));

const mockedDeposit = depositPoolBalance as jest.MockedFunction<typeof depositPoolBalance>;
const mockedPoolBalance = getPoolBalanceStroops as jest.MockedFunction<
  typeof getPoolBalanceStroops
>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <LocaleProvider>{children}</LocaleProvider>;
}

describe("depositPool locale freshness (issue #223)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockedDeposit.mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof depositPoolBalance>
    >);
    mockedPoolBalance.mockResolvedValue("0" as Awaited<
      ReturnType<typeof getPoolBalanceStroops>
    >);
  });

  /** The description string handed to the success toast. */
  function depositToastBody(): string {
    const call = toastSuccess.mock.calls.find(([title]) => title === "Deposit successful");
    expect(call).toBeDefined();
    return call![1] as string;
  }

  describe.each([
    ["usePayment", () => usePayment({ expenseId: "expense-1" })],
    ["useNetPayment", () => useNetPayment({ tripId: "trip-1" })],
  ])("%s", (_name, useHook) => {
    it("formats the deposit toast with the locale restored after mount", async () => {
      // A returning German user: the provider reads this on mount and moves off
      // its "en-US" initial value, which is the transition the stale callback
      // missed entirely.
      localStorage.setItem("stellar-star-locale", "de-DE");

      const { result } = renderHook(useHook, { wrapper });

      // Let the provider's mount effect apply de-DE before we submit.
      await waitFor(() => expect(mockedPoolBalance).toHaveBeenCalled());

      await act(async () => {
        await result.current.depositPool("1234.5678901");
      });

      const body = depositToastBody();
      // de-DE groups with "." and uses "," for the decimal separator.
      expect(body).toContain("1.234");
      expect(body).not.toContain("1,234");
    });

    it("formats with en-US when that is the active locale", async () => {
      localStorage.setItem("stellar-star-locale", "en-US");

      const { result } = renderHook(useHook, { wrapper });
      await waitFor(() => expect(mockedPoolBalance).toHaveBeenCalled());

      await act(async () => {
        await result.current.depositPool("1234.5678901");
      });

      const body = depositToastBody();
      expect(body).toContain("1,234");
      expect(body).not.toContain("1.234");
    });

    it("picks up a locale change made after the callback was first created", async () => {
      const { result } = renderHook(useHook, { wrapper });
      await waitFor(() => expect(mockedPoolBalance).toHaveBeenCalled());

      // Deposit once under the default locale so the callback is definitely
      // created and used before the switch.
      await act(async () => {
        await result.current.depositPool("1234.5678901");
      });
      expect(depositToastBody()).toContain("1,234");

      toastSuccess.mockClear();
      localStorage.setItem("stellar-star-locale", "de-DE");

      // Remount to apply the new preference the way a language switch does.
      const second = renderHook(useHook, { wrapper });
      await waitFor(() => expect(mockedPoolBalance).toHaveBeenCalled());

      await act(async () => {
        await second.result.current.depositPool("1234.5678901");
      });

      expect(depositToastBody()).toContain("1.234");
    });
  });
});
