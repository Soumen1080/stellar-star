/**
 * @jest-environment jsdom
 */

import {
  pollTransactionStatus,
  cancelTransactionPoll,
  cancelAllTransactionPolls,
} from "@/lib/stellar/contract";
import { sorobanServer } from "@/lib/stellar/soroban";
import { rpc } from "@stellar/stellar-sdk";

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    getTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
  },
}));

const mockedGetTransaction = sorobanServer.getTransaction as jest.MockedFunction<
  typeof sorobanServer.getTransaction
>;

describe("Contract Transaction Polling Optimization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cancelAllTransactionPolls();
  });

  afterEach(() => {
    cancelAllTransactionPolls();
  });

  it("deduplicates concurrent polls for the same transaction hash", async () => {
    mockedGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 150,
    } as any);

    const txHash = "tx-hash-dedup-1";
    const poll1 = pollTransactionStatus(txHash, { initialIntervalMs: 5 });
    const poll2 = pollTransactionStatus(txHash, { initialIntervalMs: 5 });

    const [res1, res2] = await Promise.all([poll1, poll2]);

    expect(res1.ledger).toBe(150);
    expect(res2.ledger).toBe(150);
    // Only one getTransaction call despite two callers
    expect(mockedGetTransaction).toHaveBeenCalledTimes(1);
  });

  it("applies backoff when retrying pending transactions", async () => {
    let callCount = 0;
    mockedGetTransaction.mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND } as any;
      }
      return {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 160,
      } as any;
    });

    const txHash = "tx-hash-backoff";
    const result = await pollTransactionStatus(txHash, { initialIntervalMs: 10, maxIntervalMs: 50 });

    expect(result.ledger).toBe(160);
    expect(callCount).toBe(3);
  });

  it("cancels in-flight poll when cancelTransactionPoll is called", async () => {
    mockedGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as any);

    const txHash = "tx-hash-cancel";
    const pollPromise = pollTransactionStatus(txHash, { initialIntervalMs: 50 });

    // Cancel the poll
    cancelTransactionPoll(txHash);

    await expect(pollPromise).rejects.toThrow(/aborted/i);
  });

  it("cancels in-flight poll via AbortSignal", async () => {
    mockedGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as any);

    const abortController = new AbortController();
    const txHash = "tx-hash-signal";
    const pollPromise = pollTransactionStatus(txHash, {
      signal: abortController.signal,
      initialIntervalMs: 50,
    });

    abortController.abort();

    await expect(pollPromise).rejects.toThrow(/aborted/i);
  });

  it("pauses transaction polling while the tab is hidden and resumes when visible", async () => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });

    mockedGetTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 175,
    } as any);

    const txHash = "tx-hash-visibility";
    const pollPromise = pollTransactionStatus(txHash, { initialIntervalMs: 10 });

    // While hidden, polling waits
    expect(mockedGetTransaction).not.toHaveBeenCalled();

    // Now switch tab to visible
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    const res = await pollPromise;
    expect(res.ledger).toBe(175);
    expect(mockedGetTransaction).toHaveBeenCalledTimes(1);
  });
});
