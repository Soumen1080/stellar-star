import {
  EMPTY_HISTORY_FILTERS,
  HistoryFilterError,
  dateRangeBounds,
  decodeHistoryCursor,
  encodeHistoryCursor,
  expenseSearchDocument,
  hasActiveHistoryFilters,
  historyFiltersToParams,
  matchesExpenseHistoryFilters,
  parseHistoryFilters,
  parseTimezoneOffset,
  parseTripIdFilter,
  searchTerms,
  settlementStateOf,
  type ExpenseHistoryFilters,
} from "@/lib/expense/historyFilters";
import type { Expense } from "@/types/expense";

const ALICE = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const BOB = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
const TX = "a".repeat(64);

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Beach house",
    description: "Two nights in Goa",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice", walletAddress: ALICE },
      { id: "m2", name: "Bob", walletAddress: BOB },
    ],
    shares: [{ memberId: "m2", name: "Bob", walletAddress: BOB, amount: "50.0000000", paid: false }],
    createdAt: "2026-10-05T10:00:00.000Z",
    settled: false,
    category: "lodging",
    tags: ["goa", "weekend"],
    ...overrides,
  };
}

function filters(overrides: Partial<ExpenseHistoryFilters> = {}): ExpenseHistoryFilters {
  return { ...EMPTY_HISTORY_FILTERS, tags: [], ...overrides };
}

describe("parseHistoryFilters / historyFiltersToParams", () => {
  it("round-trips every filter through the URL", () => {
    const value = filters({
      q: "beach",
      category: "lodging",
      tags: ["goa", "weekend"],
      payer: ALICE,
      status: "partial",
      asset: "native",
      from: "2026-10-01",
      to: "2026-10-31",
    });
    const params = historyFiltersToParams(value);
    expect(parseHistoryFilters(params, { strict: true })).toEqual(value);
  });

  it("keeps unrelated parameters and drops inactive filters", () => {
    const params = historyFiltersToParams(filters({ q: "x" }), new URLSearchParams("tab=settle&status=open"));
    expect(params.get("tab")).toBe("settle");
    expect(params.get("q")).toBe("x");
    expect(params.has("status")).toBe(false);
  });

  it("normalizes tags and asset spellings", () => {
    const parsed = parseHistoryFilters(new URLSearchParams("tags=%23Goa,GOA,Day%202&asset=XLM"));
    expect(parsed.tags).toEqual(["goa", "day-2"]);
    expect(parsed.asset).toBe("native");
  });

  it("is lenient for browser URLs: bad values are dropped, not fatal", () => {
    const parsed = parseHistoryFilters(new URLSearchParams("category=nope&status=weird&from=2026-13-40&q=ok"));
    expect(parsed).toEqual(filters({ q: "ok" }));
  });

  it("is strict for the API: bad values throw HistoryFilterError", () => {
    expect(() => parseHistoryFilters(new URLSearchParams("category=nope"), { strict: true })).toThrow(HistoryFilterError);
    expect(() => parseHistoryFilters(new URLSearchParams("status=weird"), { strict: true })).toThrow(/Invalid status/);
    expect(() => parseHistoryFilters(new URLSearchParams("from=2026-02-30"), { strict: true })).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parseHistoryFilters(new URLSearchParams("from=2026-10-10&to=2026-10-01"), { strict: true }),
    ).toThrow(/on or before/);
    expect(() => parseHistoryFilters(new URLSearchParams(`q=${"x".repeat(201)}`), { strict: true })).toThrow(/at most/);
  });

  it("reports whether any filter is active", () => {
    expect(hasActiveHistoryFilters(filters())).toBe(false);
    expect(hasActiveHistoryFilters(filters({ tags: ["goa"] }))).toBe(true);
  });
});

describe("matchesExpenseHistoryFilters", () => {
  const utc = 0;

  it("matches everything with no filters", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters(), utc)).toBe(true);
  });

  it.each([
    ["title", "beach"],
    ["description", "goa"],
    ["member name", "bob"],
    ["wallet address", ALICE.toLowerCase()],
    ["tag", "weekend"],
  ])("searches by %s", (_field, q) => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ q }), utc)).toBe(true);
  });

  it("searches by transaction hash", () => {
    const paid = expense({ shares: [{ ...expense().shares[0], paid: true, txHash: TX }] });
    expect(matchesExpenseHistoryFilters(paid, filters({ q: TX.slice(0, 12) }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(expense(), filters({ q: TX.slice(0, 12) }), utc)).toBe(false);
  });

  it("requires every search term to match", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ q: "beach bob" }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(expense(), filters({ q: "beach carol" }), utc)).toBe(false);
  });

  it("filters by category, including uncategorized", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ category: "food" }), utc)).toBe(false);
    expect(matchesExpenseHistoryFilters(expense({ category: null }), filters({ category: "uncategorized" }), utc)).toBe(true);
  });

  it("requires all selected tags", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ tags: ["goa", "weekend"] }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(expense(), filters({ tags: ["goa", "food"] }), utc)).toBe(false);
  });

  it("filters by payer member id or payer wallet", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ payer: "m1" }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(expense(), filters({ payer: ALICE }), utc)).toBe(true);
    // Bob is a member but not the payer.
    expect(matchesExpenseHistoryFilters(expense(), filters({ payer: BOB }), utc)).toBe(false);
  });

  it("distinguishes unpaid, partial, settled and open", () => {
    const unpaid = expense();
    const partial = expense({
      shares: [
        { memberId: "m2", name: "Bob", amount: "25", paid: true, txHash: TX },
        { memberId: "m3", name: "Cy", amount: "25", paid: false },
      ],
    });
    const settled = expense({ settled: true });

    expect([unpaid, partial, settled].map(settlementStateOf)).toEqual(["unpaid", "partial", "settled"]);
    expect(matchesExpenseHistoryFilters(partial, filters({ status: "open" }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(settled, filters({ status: "open" }), utc)).toBe(false);
    expect(matchesExpenseHistoryFilters(unpaid, filters({ status: "partial" }), utc)).toBe(false);
  });

  it("filters by settlement asset, treating a missing asset as native", () => {
    expect(matchesExpenseHistoryFilters(expense(), filters({ asset: "native" }), utc)).toBe(true);
    const usdc = expense({
      settlementAsset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
    expect(matchesExpenseHistoryFilters(usdc, filters({ asset: "native" }), utc)).toBe(false);
  });

  it("treats the date range as inclusive local days", () => {
    // 2026-10-05T10:00Z
    expect(matchesExpenseHistoryFilters(expense(), filters({ from: "2026-10-05", to: "2026-10-05" }), utc)).toBe(true);
    expect(matchesExpenseHistoryFilters(expense(), filters({ from: "2026-10-06" }), utc)).toBe(false);
    expect(matchesExpenseHistoryFilters(expense(), filters({ to: "2026-10-04" }), utc)).toBe(false);
    // In UTC+14 the same instant is already 2026-10-06 locally.
    expect(matchesExpenseHistoryFilters(expense(), filters({ from: "2026-10-06" }), -14 * 60)).toBe(true);
  });
});

describe("date bounds, terms, cursors", () => {
  it("converts local days to a half-open UTC range", () => {
    expect(dateRangeBounds("2026-10-01", "2026-10-01", -330)).toEqual({
      fromIso: "2026-09-30T18:30:00.000Z",
      toIso: "2026-10-01T18:30:00.000Z",
    });
  });

  it("lowercases and caps search terms", () => {
    expect(searchTerms("  Beach   BOB ")).toEqual(["beach", "bob"]);
    expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
  });

  it("keeps the database timestamp verbatim in the cursor", () => {
    const createdAt = "2026-10-05T10:00:00.123456+00:00";
    const id = "11111111-1111-4111-8111-111111111111";
    expect(decodeHistoryCursor(encodeHistoryCursor(createdAt, id))).toEqual({ createdAt, id });
  });

  it("accepts a legacy timestamp-only cursor and rejects garbage", () => {
    expect(decodeHistoryCursor("2026-10-05T10:00:00.000Z")).toEqual({
      createdAt: "2026-10-05T10:00:00.000Z",
      id: null,
    });
    expect(decodeHistoryCursor(null)).toBeNull();
    expect(() => decodeHistoryCursor("bad-cursor")).toThrow(/ISO 8601/);
    expect(() => decodeHistoryCursor("2026-10-05T10:00:00Z|not-a-uuid")).toThrow(/ISO 8601/);
  });

  it("validates tzOffset and tripId", () => {
    expect(parseTimezoneOffset("-330")).toBe(-330);
    expect(parseTimezoneOffset(null)).toBe(0);
    expect(() => parseTimezoneOffset("9999")).toThrow(/tzOffset/);
    expect(parseTripIdFilter("11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(() => parseTripIdFilter("1; drop table")).toThrow(/tripId/);
  });

  it("builds the search document from every searchable field", () => {
    const doc = expenseSearchDocument(expense());
    for (const fragment of ["beach house", "goa", "lodging", "weekend", "alice", ALICE.toLowerCase()]) {
      expect(doc).toContain(fragment);
    }
  });
});
