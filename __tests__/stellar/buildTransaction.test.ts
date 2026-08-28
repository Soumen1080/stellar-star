import { buildPaymentTransaction, trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { clearFeeCache } from "@/lib/stellar/fees";
import { MEMO_MAX_BYTES, MEMO_PREFIX } from "@/lib/utils/constants";

const sourcePublicKey = "GCUOC6KXBSOHRIMBWAHOOHLNJVHJGDPVMCMRXDKKUYQ4AUO5PNX2WYVF";
const destinationPublicKey = "GCGQLYHZDOSEWXKLKHYSZXYRUWTEPGLPDHWVIZQRL5XDE2BIEJ76XVMV";

describe("buildPaymentTransaction", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    clearFeeCache();
  });

  it("builds xdr and prefixes memo", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sequence: "12345" }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "1.25",
      memoText: "Dinner",
    });

    expect(typeof result.xdr).toBe("string");
    expect(result.xdr.length).toBeGreaterThan(20);
    expect(result.memo).toBe(`${MEMO_PREFIX}|Dinner`);
    // Account lookup + adaptive fee_stats fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("consults Horizon fee_stats for an adaptive fee", async () => {
    const accountMock = { ok: true, json: async () => ({ sequence: "12345" }) };
    const feeMock = {
      ok: true,
      json: async () => ({
        last_ledger_base_fee: "100",
        fee_charged: { p50_accepted_fee: "300" },
      }),
    };
    const fetchMock = jest.fn((input: unknown) => {
      if (String(input).includes("/fee_stats")) return Promise.resolve(feeMock);
      return Promise.resolve(accountMock);
    }) as unknown as typeof fetch;
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock;

    await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/fee_stats"),
      expect.anything()
    );
  });

  it("trims long memo text to byte limit", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sequence: "54321" }),
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const longMemo = "very-long-note-".repeat(10);
    const result = await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "0.5",
      memoText: longMemo,
    });

    const memoBytes = new TextEncoder().encode(result.memo).length;
    expect(result.memo.startsWith(`${MEMO_PREFIX}|`)).toBe(true);
    expect(memoBytes).toBeLessThanOrEqual(MEMO_MAX_BYTES);
  });

  it("throws when horizon account lookup fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      buildPaymentTransaction({
        sourcePublicKey,
        destinationPublicKey,
        amount: "2",
      }),
    ).rejects.toThrow("Failed to load account from Horizon");
  });
});

describe("trimToMemoBytes", () => {
  it("leaves short ASCII strings unchanged", () => {
    const text = "Hello World";
    expect(trimToMemoBytes(text, 28)).toBe(text);
  });

  it("truncates long ASCII strings to exactly 28 bytes", () => {
    const text = "12345678901234567890123456789012345";
    const truncated = trimToMemoBytes(text, 28);
    expect(truncated).toBe("1234567890123456789012345678");
    expect(new TextEncoder().encode(truncated).length).toBe(28);
  });

  it("avoids splitting surrogate pairs (e.g. 🍔 emoji) at the boundary", () => {
    // 🍔 is 4 bytes.
    // "1234567890123456789012345" is 25 bytes.
    // If we append 🍔 (4 bytes), total is 29 bytes.
    // Slicing at 28 bytes would split the surrogate pair of 🍔 in half.
    // trimToMemoBytes should drop the partial surrogate pair, returning only 25 bytes.
    const text = "1234567890123456789012345🍔";
    const truncated = trimToMemoBytes(text, 28);
    expect(truncated).toBe("1234567890123456789012345");
    expect(new TextEncoder().encode(truncated).length).toBe(25);
  });

  it("includes the multi-byte character if it fits exactly within the boundary", () => {
    // 🍔 is 4 bytes.
    // "123456789012345678901234" is 24 bytes.
    // Total: 28 bytes. It should include the emoji.
    const text = "123456789012345678901234🍔";
    const truncated = trimToMemoBytes(text, 28);
    expect(truncated).toBe(text);
    expect(new TextEncoder().encode(truncated).length).toBe(28);
  });
});
