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

import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";

describe("submitSignedTransaction", () => {
  beforeEach(() => {
    jest.resetAllMocks();
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
});
