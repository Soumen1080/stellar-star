/**
 * @jest-environment jsdom
 */

// Regression tests for issue #222.
//
// handleSubmit omitted `currency` from its useCallback dependency array while
// reading it in the body, so the callback held the value from the render that
// created it — "XLM", the initial state. Switching the dropdown re-rendered the
// hook and produced a new callback, but the form submitted whichever one it had
// captured, so a USD or INR expense took the `currency === "XLM"` branch: no
// rate was fetched, no conversion applied, and the amount was stored tagged XLM.
//
// These tests drive the hook the way the form does — change the currency, then
// submit — and assert on what reaches addExpense. They fail against the old
// dependency array and pass with `currency` present.

import type { FormEvent } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useExpenseForm } from "@/hooks/useExpenseForm";
import { useExpense } from "@/hooks/useExpense";
import { fetchExchangeRate } from "@/lib/fx/quote";
import type { Expense, Member } from "@/types/expense";

jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/lib/fx/quote", () => ({
  fetchExchangeRate: jest.fn(),
  describeAge: () => "3 minutes",
}));

const toastInfo = jest.fn();
jest.mock("@/components/ui/Toast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
    info: toastInfo,
  }),
}));

const mockedUseExpense = useExpense as jest.MockedFunction<typeof useExpense>;
const mockedFetchRate = fetchExchangeRate as jest.MockedFunction<typeof fetchExchangeRate>;

const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

const defaultMembers: Member[] = [
  { id: "member-1", name: "Asha", walletAddress: ADDR_A, weight: 1 },
  { id: "member-2", name: "Ravi", walletAddress: ADDR_B, weight: 1 },
];

/** A submit event whose preventDefault the hook calls. */
function submitEvent() {
  return { preventDefault: () => undefined } as unknown as FormEvent;
}

describe("useExpenseForm currency freshness (issue #222)", () => {
  let addExpense: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    addExpense = jest.fn().mockResolvedValue(undefined);
    mockedUseExpense.mockReturnValue({ addExpense } as unknown as ReturnType<typeof useExpense>);
  });

  /** Fills in a valid form, then switches the currency — the reported sequence. */
  async function fillAndSwitch(to: string) {
    const hook = renderHook(() => useExpenseForm({ defaultMembers }));

    await act(async () => {
      hook.result.current.setTitle("Dinner");
      hook.result.current.setTotalAmount("100");
    });
    await act(async () => {
      hook.result.current.setCurrency(to);
    });

    return hook;
  }

  it("submits the currency selected after mount, not the initial XLM", async () => {
    mockedFetchRate.mockResolvedValue({
      rate: "0.25",
      fetchedAtIso: "2026-01-01T00:00:00.000Z",
      stale: false,
      rateAgeMs: 0,
      source: "test",
    } as Awaited<ReturnType<typeof fetchExchangeRate>>);

    const hook = await fillAndSwitch("USD");

    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));

    const saved = addExpense.mock.calls[0][0] as Expense;
    expect(saved.currency).toBe("USD");
    // The rate was actually applied: 100 USD * 0.25 = 25 XLM. Under the stale
    // closure this stayed "100.0000000" because the conversion was skipped.
    expect(saved.totalAmount).toBe("25.0000000");
    expect(saved.exchangeRate).toBe("0.25");
  });

  it("fetches a rate for the selected currency instead of skipping conversion", async () => {
    mockedFetchRate.mockResolvedValue({
      rate: "0.012",
      fetchedAtIso: "2026-01-01T00:00:00.000Z",
      stale: false,
      rateAgeMs: 0,
      source: "test",
    } as Awaited<ReturnType<typeof fetchExchangeRate>>);

    const hook = await fillAndSwitch("INR");

    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));

    // The stale closure never reached this call at all.
    expect(mockedFetchRate).toHaveBeenCalledWith("INR");
    expect((addExpense.mock.calls[0][0] as Expense).currency).toBe("INR");
  });

  it("converts a fractional fiat amount without floating-point drift", async () => {
    mockedFetchRate.mockResolvedValue({
      rate: "0.123456789",
      fetchedAtIso: "2026-01-01T00:00:00.000Z",
      stale: false,
      rateAgeMs: 0,
      source: "test",
    } as Awaited<ReturnType<typeof fetchExchangeRate>>);

    const hook = renderHook(() => useExpenseForm({ defaultMembers }));
    await act(async () => {
      hook.result.current.setTitle("Exact conversion");
      hook.result.current.setTotalAmount("10.01");
      hook.result.current.setCurrency("USD");
    });
    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));
    expect((addExpense.mock.calls[0][0] as Expense).totalAmount).toBe("1.2358025");
  });

  it("honours the degraded path for the freshly selected currency", async () => {
    // Rate unavailable: the expense must not be created, and the form must say
    // so naming the currency the user actually chose.
    mockedFetchRate.mockResolvedValue(null);

    const hook = await fillAndSwitch("USD");

    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    expect(addExpense).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.rateUnavailable).toBe(true));
  });

  it("still short-circuits conversion when XLM is chosen", async () => {
    // The other direction: switching away and back must not leave a currency
    // behind that triggers a pointless rate fetch.
    const hook = await fillAndSwitch("USD");

    await act(async () => {
      hook.result.current.setCurrency("XLM");
    });

    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));

    expect(mockedFetchRate).not.toHaveBeenCalled();

    const saved = addExpense.mock.calls[0][0] as Expense;
    expect(saved.currency).toBe("XLM");
    expect(saved.totalAmount).toBe("100.0000000");
    expect(saved.exchangeRate).toBeUndefined();
  });

  it("notifies through the current toastInfo when the rate is stale", async () => {
    mockedFetchRate.mockResolvedValue({
      rate: "0.25",
      fetchedAtIso: "2026-01-01T00:00:00.000Z",
      stale: true,
      rateAgeMs: 180_000,
      source: "cache",
    } as Awaited<ReturnType<typeof fetchExchangeRate>>);

    const hook = await fillAndSwitch("USD");

    await act(async () => {
      await hook.result.current.handleSubmit(submitEvent());
    });

    await waitFor(() => expect(addExpense).toHaveBeenCalledTimes(1));
    expect(toastInfo).toHaveBeenCalledWith(
      "Using a recent exchange rate",
      expect.stringContaining("3 minutes"),
    );
  });
});
