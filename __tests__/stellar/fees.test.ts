import {
  fetchFeeStats,
  suggestBaseFee,
  getSuggestedBaseFee,
  clearFeeCache,
  FEE_MIN_STROOPS,
  FEE_MAX_STROOPS,
} from "@/lib/stellar/fees";

describe("suggestBaseFee", () => {
  it("falls back to the protocol minimum when stats are missing", () => {
    expect(suggestBaseFee(null)).toBe(FEE_MIN_STROOPS);
    expect(suggestBaseFee(undefined)).toBe(FEE_MIN_STROOPS);
  });

  it("adds the median accepted fee to the ledger base fee", () => {
    const stats = {
      last_ledger_base_fee: "100",
      fee_charged: { p50_accepted_fee: "100" },
    };
    expect(suggestBaseFee(stats)).toBe(200);
  });

  it("reflects surge via a higher median accepted fee", () => {
    const stats = {
      last_ledger_base_fee: "100",
      fee_charged: { p50_accepted_fee: "50000" },
    };
    expect(suggestBaseFee(stats)).toBe(50100);
  });

  it("returns the fallback for unparseable stats", () => {
    const stats = {
      last_ledger_base_fee: "abc",
      fee_charged: { p50_accepted_fee: "nope" },
    } as never;
    expect(suggestBaseFee(stats)).toBe(FEE_MIN_STROOPS);
  });

  it("clamps the result to the configured maximum", () => {
    const stats = {
      last_ledger_base_fee: "0",
      fee_charged: { p50_accepted_fee: "999999999" },
    };
    const result = suggestBaseFee(stats);
    expect(result).toBeLessThanOrEqual(FEE_MAX_STROOPS);
    expect(result).toBeGreaterThanOrEqual(FEE_MIN_STROOPS);
  });
});

describe("fetchFeeStats", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns parsed stats when the response is ok", async () => {
    const json = { last_ledger_base_fee: "100", fee_charged: { p50_accepted_fee: "100" } };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => json,
    }) as unknown as typeof fetch;

    const res = await fetchFeeStats("https://horizon.example");
    expect(res).toEqual(json);
  });

  it("returns null on a non-ok response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    expect(await fetchFeeStats("https://horizon.example")).toBeNull();
  });

  it("returns null when fetch throws (never propagates)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    expect(await fetchFeeStats("https://horizon.example")).toBeNull();
  });
});

describe("getSuggestedBaseFee", () => {
  beforeEach(() => clearFeeCache());
  afterEach(() => {
    jest.restoreAllMocks();
    clearFeeCache();
  });

  it("fetches once and caches the suggestion", async () => {
    const json = { last_ledger_base_fee: "100", fee_charged: { p50_accepted_fee: "300" } };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => json,
    }) as unknown as typeof fetch;
    global.fetch = fetchMock;

    const a = await getSuggestedBaseFee({ horizonUrl: "https://h" });
    const b = await getSuggestedBaseFee({ horizonUrl: "https://h" });

    expect(a).toBe("400");
    expect(b).toBe("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the fallback string when fee stats are unavailable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("down")) as unknown as typeof fetch;
    const fee = await getSuggestedBaseFee({ fallback: 123 });
    expect(fee).toBe("123");
  });
});
