const submitTransactionMock = jest.fn();
const fromXdrMock = jest.fn();

jest.mock("@/lib/stellar/client", () => ({
  server: {
    submitTransaction: (...args: unknown[]) => submitTransactionMock(...args),
  },
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    TransactionBuilder: {
      ...actual.TransactionBuilder,
      fromXDR: (...args: unknown[]) => fromXdrMock(...args),
    },
  };
});

import { submitSignedTransaction, clearSignedSubmitCache } from "@/lib/stellar/submitTransaction";

describe("submitSignedTransaction", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    clearSignedSubmitCache();
    fromXdrMock.mockReturnValue({ id: "tx" });
  });

  it("returns successful submit result", async () => {
    submitTransactionMock.mockResolvedValue({ hash: "abc", ledger: 99 });

    const res = await submitSignedTransaction("SIGNED_XDR");

    expect(fromXdrMock).toHaveBeenCalled();
    expect(submitTransactionMock).toHaveBeenCalled();
    expect(res).toEqual({ hash: "abc", ledger: 99, successful: true });
  });

  it("maps operation errors to friendly messages", async () => {
    submitTransactionMock.mockRejectedValue({
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: "tx_failed",
              operations: ["op_no_destination"],
            },
          },
        },
      },
    });

    await expect(submitSignedTransaction("SIGNED_XDR")).rejects.toThrow(
      "The recipient account doesn't exist on the Stellar network.",
    );
  });

  it("maps tx_bad_seq errors", async () => {
    submitTransactionMock.mockRejectedValue({
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: "tx_bad_seq",
              operations: ["op_success"],
            },
          },
        },
      },
    });

    await expect(submitSignedTransaction("SIGNED_XDR")).rejects.toThrow(
      "Transaction sequence mismatch. Please try again.",
    );
  });

  it("returns generic failure for non-Error throws", async () => {
    submitTransactionMock.mockRejectedValue("unknown");

    await expect(submitSignedTransaction("SIGNED_XDR")).rejects.toThrow(
      "Transaction submission failed.",
    );
  });

  describe("de-duplication by signed XDR", () => {
    it("submits once for concurrent callers holding the same signed XDR", async () => {
      let release: (value: { hash: string; ledger: number }) => void = () => {};
      submitTransactionMock.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );

      const both = Promise.all([
        submitSignedTransaction("SIGNED_XDR"),
        submitSignedTransaction("SIGNED_XDR"),
      ]);

      release({ hash: "dedup-hash", ledger: 77 });
      const [first, second] = await both;

      expect(submitTransactionMock).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ hash: "dedup-hash", ledger: 77, successful: true });
      expect(second).toEqual(first);
    });

    it("serves a retry from cache after a successful submit", async () => {
      submitTransactionMock.mockResolvedValue({ hash: "cached-hash", ledger: 12 });

      const first = await submitSignedTransaction("SIGNED_XDR");
      const second = await submitSignedTransaction("SIGNED_XDR");

      expect(submitTransactionMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it("re-submits after a failure so a genuine retry can recover", async () => {
      submitTransactionMock.mockRejectedValueOnce(
        new Error("Transaction submission failed."),
      );
      submitTransactionMock.mockResolvedValueOnce({ hash: "recovered", ledger: 3 });

      await expect(submitSignedTransaction("SIGNED_XDR")).rejects.toThrow();
      const retried = await submitSignedTransaction("SIGNED_XDR");

      expect(submitTransactionMock).toHaveBeenCalledTimes(2);
      expect(retried).toEqual({ hash: "recovered", ledger: 3, successful: true });
    });

    it("rejects concurrent duplicate callers with the same friendly error", async () => {
      submitTransactionMock.mockRejectedValue({
        response: {
          data: {
            extras: { result_codes: { transaction: "tx_failed", operations: ["op_no_destination"] } },
          },
        },
      });

      const results = await Promise.allSettled([
        submitSignedTransaction("SIGNED_XDR"),
        submitSignedTransaction("SIGNED_XDR"),
      ]);

      expect(submitTransactionMock).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      for (const result of results) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(Error);
        expect((result as PromiseRejectedResult).reason.message).toBe(
          "The recipient account doesn't exist on the Stellar network.",
        );
      }
    });

    it("treats distinct signed XDRs as distinct payments", async () => {
      submitTransactionMock.mockResolvedValue({ hash: "h", ledger: 1 });

      await submitSignedTransaction("SIGNED_XDR_A");
      await submitSignedTransaction("SIGNED_XDR_B");

      expect(submitTransactionMock).toHaveBeenCalledTimes(2);
    });

    it("flushes cached results when the cache is cleared", async () => {
      submitTransactionMock.mockResolvedValue({ hash: "first", ledger: 1 });

      await submitSignedTransaction("SIGNED_XDR");
      clearSignedSubmitCache();
      submitTransactionMock.mockResolvedValue({ hash: "second", ledger: 2 });
      await submitSignedTransaction("SIGNED_XDR");

      expect(submitTransactionMock).toHaveBeenCalledTimes(2);
    });
  });
});
