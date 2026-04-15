import { decodeContractError } from "@/lib/stellar/contract";

describe("decodeContractError", () => {
  it("maps known contract errors to user-friendly messages", () => {
    const result = decodeContractError("Error(Contract, #1)");
    expect(result).toBe("Payment amount must be greater than zero.");
  });

  it("falls back to numbered generic message for unknown codes", () => {
    const result = decodeContractError("Error(Contract, #99)");
    expect(result).toBe("Contract error #99.");
  });

  it("returns raw message when pattern is not a contract error", () => {
    const raw = "network timeout";
    expect(decodeContractError(raw)).toBe(raw);
  });
});
