import { verifyPaymentTransaction } from "@/lib/stellar/verifyTransaction";

describe("verifyPaymentTransaction", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  const mockTxResponse = (successful: boolean, sourceAccount: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      successful,
      source_account: sourceAccount,
      ledger: 123,
    }),
  });

  const mockOpsResponse = (records: any[]) => ({
    ok: true,
    status: 200,
    json: async () => ({
      _embedded: {
        records,
      },
    }),
  });

  it("returns true for a valid matching payment", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockTxResponse(true, "SOURCE123"))
      .mockResolvedValueOnce(
        mockOpsResponse([
          {
            type: "payment",
            source_account: "SOURCE123",
            to: "DEST456",
            asset_type: "native",
            amount: "10.0000000",
          },
        ])
      );

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
    });

    expect(result.valid).toBe(true);
  });

  it("uses transaction source account if operation source is missing", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockTxResponse(true, "SOURCE123"))
      .mockResolvedValueOnce(
        mockOpsResponse([
          {
            type: "payment",
            to: "DEST456",
            asset_type: "native",
            amount: "10.0000000",
          },
        ])
      );

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
    });

    expect(result.valid).toBe(true);
  });

  it("returns false if transaction is not successful", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockTxResponse(false, "SOURCE123"));

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/failed/i);
  });

  it("returns false if amount does not match", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockTxResponse(true, "SOURCE123"))
      .mockResolvedValueOnce(
        mockOpsResponse([
          {
            type: "payment",
            source_account: "SOURCE123",
            to: "DEST456",
            asset_type: "native",
            amount: "5.0000000",
          },
        ])
      );

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
    });

    expect(result.valid).toBe(false);
    // The mismatch reason is now named rather than generic, so a payer can see
    // that the amount was wrong instead of just "no match".
    expect(result.error).toMatch(/but 10 is owed/i);
  });

  it("returns false if destination does not match", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(mockTxResponse(true, "SOURCE123"))
      .mockResolvedValueOnce(
        mockOpsResponse([
          {
            type: "payment",
            source_account: "SOURCE123",
            to: "WRONGDEST",
            asset_type: "native",
            amount: "10.0000000",
          },
        ])
      );

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
    });

    expect(result.valid).toBe(false);
  });

  it("returns false if memo does not match the expected payment memo", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          successful: true,
          source_account: "SOURCE123",
          ledger: 123,
          memo_type: "text",
          memo: "wrong-memo",
        }),
      })
      .mockResolvedValueOnce(
        mockOpsResponse([
          {
            type: "payment",
            source_account: "SOURCE123",
            to: "DEST456",
            asset_type: "native",
            amount: "10.0000000",
          },
        ])
      );

    const result = await verifyPaymentTransaction({
      txHash: "fakehash",
      expectedSource: "SOURCE123",
      expectedDestination: "DEST456",
      expectedAmountXlm: "10",
      expectedMemo: "StellarStar|Dinner|Alice",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/memo/i);
  });
});
