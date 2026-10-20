/**
 * #324 — CSV/PDF export and portable archive.
 */

import fs from "node:fs";
import path from "node:path";
import { amount, encodeCell, text, toCsv } from "@/lib/export/csv";
import {
  CSV_HEADER,
  buildArchive,
  buildExportRows,
  buildTripCsv,
  computeTripBalances,
  explorerTxUrl,
  exportFileStem,
  type ExportableExpense,
} from "@/lib/export/tripExport";
import type { Trip } from "@/types/trip";

const EXPLORER = "https://stellar.expert/explorer/testnet";
const HASH = "a".repeat(64);
const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

const trip: Trip = {
  id: "trip-1",
  name: "Goa, 2026",
  members: [
    { id: "a", name: "Asha", walletAddress: ADDR_A },
    { id: "b", name: "Ravi", walletAddress: ADDR_B },
  ],
  expenseIds: ["e1", "e2"],
  createdAt: "2026-01-01T00:00:00Z",
  settled: false,
};

const expenses: ExportableExpense[] = [
  {
    id: "e1",
    title: "Dinner",
    totalAmount: "81.2345675",
    currency: "EUR",
    enteredAmount: "25.00",
    exchangeRate: "3.2493827",
    exchangeRateSource: "coingecko",
    exchangeRateTimestamp: "2026-01-02T10:00:00.000Z",
    category: "Food",
    splitMode: "equal",
    paidByMemberId: "a",
    members: trip.members,
    shares: [
      { memberId: "a", name: "Asha", walletAddress: ADDR_A, amount: "40.6172838", paid: true },
      { memberId: "b", name: "Ravi", walletAddress: ADDR_B, amount: "40.6172837", paid: true, txHash: HASH },
    ],
    createdAt: "2026-01-02T10:00:00Z",
    settled: true,
  },
  {
    id: "e2",
    title: "=HYPERLINK(\"http://evil\")",
    totalAmount: "0.0000002",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "b",
    members: trip.members,
    shares: [
      { memberId: "a", name: "Asha", amount: "0.0000001", paid: true },
      { memberId: "b", name: "Ravi", amount: "0.0000001", paid: false },
    ],
    createdAt: "2026-01-03T10:00:00Z",
    settled: false,
  },
];

function parseCsv(csv: string): string[][] {
  // Sufficient for these fixtures: no embedded newlines.
  return csv.trim().split("\r\n").map((line) => {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { cells.push(current); current = ""; }
      else current += ch;
    }
    cells.push(current);
    return cells;
  });
}

describe("CSV encoding", () => {
  it("writes amounts exactly, never in float or exponent notation", () => {
    expect(encodeCell(amount("0.0000001"))).toBe("0.0000001");
    expect(encodeCell(amount("12345678901.1234567"))).toBe("12345678901.1234567");
    expect(encodeCell(amount("-3.5000000"))).toBe("-3.5000000");
    expect(() => encodeCell(amount("1e-7"))).toThrow(/non-decimal/);
    expect(() => encodeCell(amount("NaN"))).toThrow();
  });

  it("neutralises spreadsheet formulas in text but quotes commas and quotes", () => {
    expect(encodeCell(text("=SUM(A1)"))).toBe("'=SUM(A1)");
    expect(encodeCell(text("-2+3"))).toBe("'-2+3");
    expect(encodeCell(text("@cmd"))).toBe("'@cmd");
    expect(encodeCell(text('Goa, "2026"'))).toBe('"Goa, ""2026"""');
  });

  it("rejects rows of the wrong width", () => {
    expect(() => toCsv(["a", "b"], [[text("x")]])).toThrow(RangeError);
  });
});

describe("trip CSV", () => {
  const rows = parseCsv(buildTripCsv(trip, expenses, { explorerBase: EXPLORER }));
  const [header, ...body] = rows;
  const col = (name: string) => header.indexOf(name);
  const byType = (type: string) => body.filter((r) => r[col("record_type")] === type);

  it("has every column the issue asks for", () => {
    expect(header).toEqual(CSV_HEADER);
    for (const name of ["category", "entered_amount", "entered_currency", "exchange_rate", "exchange_rate_source",
      "exchange_rate_timestamp", "settlement_asset", "transaction_hash", "explorer_url"]) {
      expect(header).toContain(name);
    }
  });

  it("includes expenses, shares and adjustments", () => {
    expect(byType("expense")).toHaveLength(2);
    expect(byType("share")).toHaveLength(4);
    // Asha's 0.0000001 share in e2 was marked paid with no transaction.
    const [adjustment] = byType("adjustment");
    expect(adjustment[col("member_name")]).toBe("Asha");
    expect(adjustment[col("amount")]).toBe("0.0000001");
    expect(adjustment[col("note")]).toMatch(/without an on-chain transaction/);
  });

  it("carries category, exchange-rate provenance and settlement asset", () => {
    const dinner = byType("expense")[0];
    expect(dinner[col("category")]).toBe("Food");
    expect(dinner[col("amount")]).toBe("81.2345675");
    expect(dinner[col("settlement_asset")]).toBe("XLM");
    expect(dinner[col("entered_amount")]).toBe("25.00");
    expect(dinner[col("entered_currency")]).toBe("EUR");
    expect(dinner[col("exchange_rate")]).toBe("3.2493827");
    expect(dinner[col("exchange_rate_source")]).toBe("coingecko");
    expect(dinner[col("exchange_rate_timestamp")]).toBe("2026-01-02T10:00:00.000Z");
  });

  it("includes transaction hashes and explorer links for paid shares", () => {
    const ravi = byType("share").find((r) => r[col("expense_id")] === "e1" && r[col("member_name")] === "Ravi")!;
    expect(ravi[col("transaction_hash")]).toBe(HASH);
    expect(ravi[col("explorer_url")]).toBe(`${EXPLORER}/tx/${HASH}`);
  });

  it("keeps the smallest amounts exact and the formula title inert", () => {
    const tiny = byType("expense")[1];
    expect(tiny[col("amount")]).toBe("0.0000002");
    expect(tiny[col("expense_title")].startsWith("'=")).toBe(true);
  });

  it("only links well-formed transaction hashes", () => {
    expect(explorerTxUrl(HASH, `${EXPLORER}/`)).toBe(`${EXPLORER}/tx/${HASH}`);
    expect(explorerTxUrl("javascript:alert(1)", EXPLORER)).toBeUndefined();
    expect(explorerTxUrl(undefined, EXPLORER)).toBeUndefined();
  });
});

describe("balances", () => {
  it("sums exactly per settlement asset and reports what is outstanding", () => {
    const [xlm] = computeTripBalances(trip, expenses);
    expect(xlm.asset).toBe("XLM");
    expect(xlm.total).toBe("81.2345677");
    const asha = xlm.members.find((m) => m.memberId === "a")!;
    const ravi = xlm.members.find((m) => m.memberId === "b")!;
    expect(asha).toMatchObject({ paid: "81.2345675", share: "40.6172839", outstanding: "0.0000000" });
    // Ravi fronted e2; nothing is still owed to him since Asha's share is marked paid.
    expect(ravi).toMatchObject({ paid: "0.0000002", share: "40.6172838", outstanding: "0.0000000" });
  });
});

describe("portable archive", () => {
  const otherTrip: Trip = { ...trip, id: "trip-2", name: "Other", expenseIds: ["e3"] };
  const stray: ExportableExpense = { ...expenses[1], id: "e9", title: "Standalone" };

  it("contains only the trips it was given, with their expenses and balances", () => {
    const archive = buildArchive({
      wallet: ADDR_A, network: "TESTNET", explorerBase: EXPLORER,
      trips: [trip], expenses: [...expenses, stray], generatedAt: "2026-10-20T00:00:00Z",
      includeUnassigned: false,
    });
    expect(archive.trips.map((t) => t.trip.id)).toEqual(["trip-1"]);
    expect(archive.trips[0].expenses.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(archive.unassignedExpenses).toEqual([]);
    expect(archive.counts).toEqual({ trips: 1, expenses: 2, shares: 4 });
    expect(archive.amountEncoding).toBe("decimal-string");
    expect(JSON.stringify(archive)).not.toContain("Other");
  });

  it("keeps amounts as strings through JSON serialisation", () => {
    const archive = buildArchive({ wallet: ADDR_A, network: "TESTNET", explorerBase: EXPLORER, trips: [trip], expenses });
    const json = JSON.stringify(archive);
    expect(json).toContain('"totalAmount":"0.0000002"');
    expect(json).not.toMatch(/\d[eE]-\d/);
  });

  it("includes visible expenses outside any trip only for a full export", () => {
    const full = buildArchive({ wallet: ADDR_A, network: "TESTNET", explorerBase: EXPLORER, trips: [trip, otherTrip], expenses: [...expenses, stray] });
    expect(full.unassignedExpenses.map((e) => e.id)).toEqual(["e9"]);
    expect(full.csv).toContain("Standalone");
  });

  it("names files safely", () => {
    expect(exportFileStem('Goa, 2026 / "fun"', new Date("2026-10-20T00:00:00Z"))).toBe("goa-2026-fun-2026-10-20");
    expect(exportFileStem("///", new Date("2026-10-20T00:00:00Z"))).toBe("trip-2026-10-20");
  });
});

describe("export audit schema (static)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const sql = fs.readFileSync(path.join(ROOT, "migrations/0011_export_audit_events.sql"), "utf8");
  const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

  it("is append-only and private to the actor", () => {
    expect(sql).not.toMatch(/CREATE POLICY \w+ ON public\.export_audit_events\s+FOR (UPDATE|DELETE)/);
    expect(sql).toMatch(/FOR SELECT USING \(actor_wallet = public\.current_wallet\(\)\)/);
    expect(sql).toMatch(/GRANT SELECT, INSERT ON public\.export_audit_events TO authenticated;/);
  });

  it("is mirrored and recorded in the setup path", () => {
    expect(setup).toContain("CREATE TABLE IF NOT EXISTS public.export_audit_events");
    expect(setup).toContain("('0011', '0011_export_audit_events', 'export_audit_events_v1')");
  });
});
