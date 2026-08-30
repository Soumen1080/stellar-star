import {
  calculateEqualSplit,
  calculateCustomSplit,
  calculateSplit,
  isValidXLMAmount,
  isValidStellarAddress,
  findDuplicateWalletErrors,
} from "@/lib/split/calculator";
import type { Member } from "@/types/expense";

// ─── helpers ──────────────────────────────────────────────────────────────────

function mkMembers(names: string[]): Member[] {
  return names.map((name, i) => ({ id: `m-${i}`, name }));
}

// ─── calculateEqualSplit ──────────────────────────────────────────────────────

describe("calculateEqualSplit", () => {
  it("splits 200 XLM equally between 2 non-payers (payer excluded from shares)", () => {
    const members = mkMembers(["Alice", "Bob", "Charlie"]);
    const shares = calculateEqualSplit(300, members, members[0].id); // Alice paid
    // Bob and Charlie each owe 100
    expect(shares).toHaveLength(2);
    shares.forEach((s) => expect(parseFloat(s.amount)).toBeCloseTo(100, 5));
  });

  it("returns empty array when there are no members", () => {
    expect(calculateEqualSplit(100, [], "none")).toHaveLength(0);
  });

  it("returns empty array when only the payer is in members", () => {
    const members = mkMembers(["Solo"]);
    expect(calculateEqualSplit(100, members, members[0].id)).toHaveLength(0);
  });

  it("amounts are strings with 7 decimal places", () => {
    const members = mkMembers(["A", "B", "C"]);
    const shares = calculateEqualSplit(100, members, members[0].id);
    shares.forEach((s) => expect(s.amount).toMatch(/^\d+\.\d{7}$/));
  });

  it("last share absorbs rounding so total equals original amount", () => {
    const members = mkMembers(["P", "A", "B", "C"]);
    const shares = calculateEqualSplit(100, members, members[0].id);
    const sum = shares.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    // 100 / 4 * 3 non-payers
    expect(sum).toBeCloseTo(75, 5);
  });

  it("shares have paid:false by default", () => {
    const members = mkMembers(["P", "X"]);
    const shares = calculateEqualSplit(50, members, members[0].id);
    shares.forEach((s) => expect(s.paid).toBe(false));
  });

  it("correctly maps member name and id", () => {
    const members = mkMembers(["Payer", "Bob"]);
    const shares = calculateEqualSplit(100, members, members[0].id);
    expect(shares[0].name).toBe("Bob");
    expect(shares[0].memberId).toBe(members[1].id);
  });
});

// ─── calculateCustomSplit ─────────────────────────────────────────────────────

describe("calculateCustomSplit", () => {
  it("splits proportionally by weight", () => {
    const members: Member[] = [
      { id: "p", name: "Payer", weight: 1 },
      { id: "a", name: "Alice", weight: 3 },
      { id: "b", name: "Bob",   weight: 1 },
    ];
    // totalWeight = 5; payer excluded from shares
    const shares = calculateCustomSplit(500, members, "p");
    const alice = shares.find((s) => s.name === "Alice")!;
    const bob   = shares.find((s) => s.name === "Bob")!;
    // Alice: 3/5 * 500 = 300; Bob: 1/5 * 500 = 100
    expect(parseFloat(alice.amount)).toBeCloseTo(300, 5);
    expect(parseFloat(bob.amount)).toBeCloseTo(100, 5);
  });

  it("uses weight 1 as default when weight is undefined", () => {
    const members = mkMembers(["P", "A", "B"]);
    const shares = calculateCustomSplit(300, members, members[0].id);
    // A and B each get 1/3 of 300 = 100
    shares.forEach((s) => expect(parseFloat(s.amount)).toBeCloseTo(100, 5));
  });

  it("returns empty array when members is empty", () => {
    expect(calculateCustomSplit(100, [], "none")).toHaveLength(0);
  });

  it("returns empty array when only the payer is present", () => {
    const members: Member[] = [{ id: "p", name: "Payer", weight: 1 }];
    expect(calculateCustomSplit(100, members, "p")).toHaveLength(0);
  });

  it("distributes rounding remainder to the final share for zero precision loss (3-way custom split with repeating decimals)", () => {
    const totalXLM = 100;
    const members: Member[] = [
      { id: "p", name: "Payer", weight: 1 },
      { id: "a", name: "Alice", weight: 1 },
      { id: "b", name: "Bob", weight: 1 },
    ];
    // Each member has weight 1 out of 3. Non-payer target = 66.6666666666...
    const shares = calculateCustomSplit(totalXLM, members, "p");
    expect(shares).toHaveLength(2);

    const nonPayerSum = shares.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    const payerShare = totalXLM * (1 / 3); // 33.3333333333...

    // Sum of non-payer shares + payer share must equal total bill amount exactly at 7 decimal places
    expect(nonPayerSum + payerShare).toBeCloseTo(totalXLM, 7);
    // Deterministic largest remainder tie-breaking assigns bonus to "a" (Alice)
    expect(shares.map(s => s.amount).sort()).toEqual(["33.3333333", "33.3333334"]);
    expect(parseFloat(shares[0].amount) + parseFloat(shares[1].amount)).toBeCloseTo(66.6666667, 7);
  });

  it("ensures zero-loss precision when total weight produces non-terminating decimals (e.g. weights 1:2:4, total bill 100)", () => {
    const totalXLM = 100;
    const members: Member[] = [
      { id: "p", name: "Payer", weight: 1 },
      { id: "a", name: "Alice", weight: 2 },
      { id: "b", name: "Bob", weight: 4 },
    ];
    // totalWeight = 7. Payer share = 1/7 * 100 = 14.2857142857...
    // Non-payer target = 6/7 * 100 = 85.7142857142...
    const shares = calculateCustomSplit(totalXLM, members, "p");

    const sumNonPayers = shares.reduce((acc, s) => acc + parseFloat(s.amount), 0);
    const payerAmount = (totalXLM * 1) / 7;

    // Total bill must match exact sum
    expect(sumNonPayers + payerAmount).toBeCloseTo(totalXLM, 7);
  });
});

// ─── calculateSplit dispatcher ────────────────────────────────────────────────

describe("calculateSplit", () => {
  it("delegates to equal split when mode is 'equal'", () => {
    const members = mkMembers(["P", "A", "B"]);
    const shares = calculateSplit(200, members, members[0].id, "equal");
    shares.forEach((s) => expect(parseFloat(s.amount)).toBeCloseTo(66.6666666, 4));
  });

  it("delegates to custom split when mode is 'custom'", () => {
    const members: Member[] = [
      { id: "p", name: "P", weight: 1 },
      { id: "a", name: "A", weight: 4 },
    ];
    const shares = calculateSplit(100, members, "p", "custom");
    // A: 4/5 * 100 = 80
    expect(parseFloat(shares[0].amount)).toBeCloseTo(80, 5);
  });
});

// ─── isValidXLMAmount ─────────────────────────────────────────────────────────

describe("isValidXLMAmount", () => {
  // ── Basic range validation (existing cases, unchanged) ────────────────────
  it.each([
    ["1",         true],
    ["0.0000001", true],   // 7 decimal places — the minimum valid stroop amount
    ["100000000", true],
    ["0",         false],
    ["-1",        false],
    ["abc",       false],
    ["",          false],
    ["100000001", false],
  ])("isValidXLMAmount(%s) === %s", (input, expected) => {
    expect(isValidXLMAmount(input)).toBe(expected);
  });

  // ── Stroop precision boundary (new cases — issue #111) ────────────────────

  // 0 decimal places — plain integers are always fine
  it("accepts an integer amount (0 decimal places)", () => {
    expect(isValidXLMAmount("10")).toBe(true);
  });

  // 7 decimal places — exactly at the stroop limit; must be accepted
  it("accepts exactly 7 decimal places (stroop precision limit)", () => {
    expect(isValidXLMAmount("10.1234567")).toBe(true);
  });

  it("accepts 0.0000001 — the smallest valid stroop amount (7 decimal places)", () => {
    expect(isValidXLMAmount("0.0000001")).toBe(true);
  });

  it("accepts 1.0000000 — trailing zeros within 7 decimal places", () => {
    expect(isValidXLMAmount("1.0000000")).toBe(true);
  });

  // 8 decimal places — one digit beyond the stroop limit; must be rejected
  it("rejects 8 decimal places (beyond stroop precision)", () => {
    expect(isValidXLMAmount("10.12345678")).toBe(false);
  });

  it("rejects 10.123456789 — the example from issue #111", () => {
    expect(isValidXLMAmount("10.123456789")).toBe(false);
  });

  it("rejects 0.00000001 — 8 decimal places even though value is tiny", () => {
    expect(isValidXLMAmount("0.00000001")).toBe(false);
  });

  it("rejects 1.00000000 — 8 decimal places even though trailing zeros", () => {
    expect(isValidXLMAmount("1.00000000")).toBe(false);
  });

  // Edge cases around the precision check
  it("accepts a value with exactly a dot but no decimals treated correctly", () => {
    // "5." is parsed as 5 by parseFloat; dot index present but no trailing digits
    expect(isValidXLMAmount("5.")).toBe(true);
  });

  it("strips leading/trailing whitespace before checking", () => {
    expect(isValidXLMAmount("  10.5  ")).toBe(true);
    expect(isValidXLMAmount("  10.12345678  ")).toBe(false);
  });
});

// ─── isValidStellarAddress ────────────────────────────────────────────────────

describe("isValidStellarAddress", () => {
  it("accepts a valid Stellar G-address (56 chars)", () => {
    expect(
      isValidStellarAddress("GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV"),
    ).toBe(true);
  });

  it("rejects addresses that do not start with G", () => {
    expect(isValidStellarAddress("XBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR")).toBe(false);
  });

  it("rejects addresses that are too short", () => {
    expect(isValidStellarAddress("GABC123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("rejects an address that matches G[A-Z2-7]{55} shape but has an invalid checksum", () => {
    // Correct length and charset but checksum is wrong
    expect(isValidStellarAddress("GBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDS")).toBe(false);
  });

  it("rejects another regex-shaped address with bad checksum", () => {
    expect(isValidStellarAddress("G" + "A".repeat(55))).toBe(false);
  });
});

// ─── findDuplicateWalletErrors ────────────────────────────────────────────────

describe("findDuplicateWalletErrors", () => {
  const ADDR_A = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
  const ADDR_B = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";
  const ADDR_C = "GA4ZPR3FCSUCTM4NK4SKNMBXV4IS7CUDISAX7PWK3PWFBWIQH2OW2O6I";

  it("flags both members when two share the same address", () => {
    const errors = findDuplicateWalletErrors([ADDR_A, ADDR_A]);
    expect(errors[0]).toMatch(/Duplicate wallet address/);
    expect(errors[1]).toMatch(/Duplicate wallet address/);
  });

  it("trims whitespace before comparing", () => {
    const errors = findDuplicateWalletErrors([`  ${ADDR_A}  `, ADDR_A]);
    expect(errors[1]).toMatch(/Duplicate wallet address/);
  });

  it("skips lowercase input, since only valid (uppercase) StrKey addresses are compared", () => {
    // StrKey addresses are always uppercase; a lowercased address fails
    // isValidStellarAddress and is excluded from duplicate detection
    // entirely (its own field-level "Invalid Stellar address" error covers it).
    const errors = findDuplicateWalletErrors([ADDR_A.toLowerCase(), ADDR_A]);
    expect(errors).toEqual({});
  });

  it("flags every member sharing an address, not just the second", () => {
    const errors = findDuplicateWalletErrors([ADDR_A, ADDR_A, ADDR_A]);
    expect(errors[0]).toMatch(/Duplicate wallet address/);
    expect(errors[1]).toMatch(/Duplicate wallet address/);
    expect(errors[2]).toMatch(/Duplicate wallet address/);
  });

  it("does not flag distinct valid addresses", () => {
    const errors = findDuplicateWalletErrors([ADDR_A, ADDR_B, ADDR_C]);
    expect(errors).toEqual({});
  });

  it("ignores empty and invalid entries when checking for duplicates", () => {
    const errors = findDuplicateWalletErrors([undefined, "", "not-an-address", ADDR_A, ADDR_A]);
    expect(Object.keys(errors)).toEqual(["3", "4"]);
  });
});
