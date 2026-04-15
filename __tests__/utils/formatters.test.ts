import { formatAddress, formatXLM, cn } from "@/lib/utils";

// ─── formatAddress ────────────────────────────────────────────────────────────

describe("formatAddress", () => {
  const ADDR = "GBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR";

  it("truncates a long address with prefix + '...' + suffix", () => {
    const result = formatAddress(ADDR);
    expect(result.startsWith(ADDR.slice(0, 6))).toBe(true);
    expect(result.endsWith(ADDR.slice(-6))).toBe(true);
    expect(result).toContain("...");
  });

  it("returns empty string for empty input", () => {
    expect(formatAddress("")).toBe("");
  });

  it("includes '...' separator between prefix and suffix", () => {
    expect(formatAddress(ADDR)).toContain("...");
  });

  it("respects custom chars parameter", () => {
    const result = formatAddress(ADDR, 4);
    expect(result.startsWith("GBGJ")).toBe(true);
    expect(result).toContain("...");
  });

  it("shows the first N characters correctly", () => {
    const result = formatAddress(ADDR, 8);
    expect(result.startsWith(ADDR.slice(0, 8))).toBe(true);
  });
});

// ─── formatXLM ────────────────────────────────────────────────────────────────

describe("formatXLM", () => {
  it("formats a whole number with at least 2 decimal places", () => {
    const result = formatXLM(100);
    expect(result).toMatch(/^100\.\d{2,}/);
  });

  it("accepts string input", () => {
    const result = formatXLM("50.5");
    expect(result).toMatch(/^50\./);
  });

  it("formats zero correctly", () => {
    expect(formatXLM(0)).toMatch(/^0\./);
  });

  it("formats a small XLM amount (7 decimal precision)", () => {
    // 0.0000001 should be preserved
    const result = formatXLM("0.0000001");
    expect(result).not.toBe("0.00"); // should not be rounded away
  });
});

// ─── cn (class names) ─────────────────────────────────────────────────────────

describe("cn", () => {
  it("merges class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("ignores falsy values", () => {
    expect(cn("foo", false && "bar", undefined, null as unknown as string)).toBe("foo");
  });

  it("handles Tailwind conflicts — last wins", () => {
    // twMerge should resolve p-4 vs p-2 in favour of the last one
    const result = cn("p-4", "p-2");
    expect(result).toBe("p-2");
  });

  it("returns empty string when nothing is passed", () => {
    expect(cn()).toBe("");
  });
});
