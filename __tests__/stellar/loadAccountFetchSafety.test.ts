/**
 * Regression test for #227.
 *
 * `loadAccount` used to call global `fetch` directly, so it threw
 * `ReferenceError: fetch is not defined` in any Node/Jest environment without
 * that global. These tests delete `globalThis.fetch` for their duration and
 * assert the money-path helpers still resolve an account — which they can only
 * do by going through the SDK's axios-backed `Horizon.Server`.
 */

const mockLoadAccount = jest.fn();
const mockSimulateTransaction = jest.fn();

jest.mock("@/lib/stellar/client", () => ({
  server: {
    loadAccount: (...args: unknown[]) => mockLoadAccount(...args),
  },
}));

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    simulateTransaction: (...args: unknown[]) => mockSimulateTransaction(...args),
  },
}));

jest.mock("@/lib/stellar/fees", () => ({
  getSuggestedBaseFee: jest.fn().mockResolvedValue(1000),
}));

const CALLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const MEMBER = "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH";

/** Runs `fn` with `globalThis.fetch` removed, restoring it afterwards. */
async function withoutGlobalFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  // @ts-expect-error -- deliberately simulating an environment with no fetch.
  delete globalThis.fetch;
  try {
    expect(typeof (globalThis as { fetch?: unknown }).fetch).toBe("undefined");
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "fetch", original);
  }
}

/** Captures the error a promise rejects with, or null if it resolves. */
async function errorFrom(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe("#227 loadAccount does not depend on global fetch", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAccount.mockResolvedValue({ sequenceNumber: () => "12345" });
    // Stop the call at simulation — reaching it is what the test is about.
    mockSimulateTransaction.mockResolvedValue({
      error: "simulation stopped here on purpose",
    });
  });

  it("reaches Horizon through the SDK client, not global fetch", async () => {
    const { getPoolBalanceStroops } = await import("@/lib/stellar/contract");

    const err = await withoutGlobalFetch(() =>
      errorFrom(() => getPoolBalanceStroops(CALLER, MEMBER)),
    );

    // The old implementation threw ReferenceError inside loadAccount, before
    // simulation was ever reached. Both assertions below prove it got past it.
    expect(mockLoadAccount).toHaveBeenCalledWith(CALLER);
    expect(mockSimulateTransaction).toHaveBeenCalled();
    expect(err?.message ?? "").not.toMatch(/fetch is not defined/i);
  });

  it("builds the account from the sequence the SDK reports", async () => {
    mockLoadAccount.mockResolvedValue({ sequenceNumber: () => "98765" });

    const { getPoolBalanceStroops } = await import("@/lib/stellar/contract");

    await withoutGlobalFetch(() =>
      errorFrom(() => getPoolBalanceStroops(CALLER, MEMBER)),
    );

    // The transaction handed to simulation carries the sequence we supplied,
    // incremented once by TransactionBuilder.
    const tx = mockSimulateTransaction.mock.calls[0][0];
    expect(String(tx.sequence)).toBe("98766");
  });

  it("surfaces a 404 as a funded-account message when no fallback is given", async () => {
    mockLoadAccount.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { status: 404 } }),
    );

    const { getPoolBalanceStroops } = await import("@/lib/stellar/contract");

    const err = await withoutGlobalFetch(() =>
      errorFrom(() => getPoolBalanceStroops(CALLER, MEMBER)),
    );

    expect(err?.message).toMatch(/404/);
    expect(err?.message).toMatch(/funded/i);
    expect(err?.message).not.toMatch(/fetch is not defined/i);
  });

  it("propagates a non-404 HTTP status in the error message", async () => {
    mockLoadAccount.mockRejectedValue(
      Object.assign(new Error("Server Error"), { response: { status: 503 } }),
    );

    const { getPoolBalanceStroops } = await import("@/lib/stellar/contract");

    const err = await withoutGlobalFetch(() =>
      errorFrom(() => getPoolBalanceStroops(CALLER, MEMBER)),
    );

    expect(err?.message).toMatch(/503/);
  });

  it("reports a transport error without a status, rather than crashing", async () => {
    mockLoadAccount.mockRejectedValue(new Error("socket hang up"));

    const { getPoolBalanceStroops } = await import("@/lib/stellar/contract");

    const err = await withoutGlobalFetch(() =>
      errorFrom(() => getPoolBalanceStroops(CALLER, MEMBER)),
    );

    expect(err?.message).toMatch(/socket hang up/);
    expect(err?.message).not.toMatch(/fetch is not defined/i);
  });
});
