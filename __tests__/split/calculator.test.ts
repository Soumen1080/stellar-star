import {
  calculateEqualSplit,
  calculateCustomSplit,
  calculateSplit,
  isValidXLMAmount,
  isValidStellarAddress,
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
  it.each([
    ["1", true],
    ["0.0000001", true],
    ["100000000", true],
    ["0", false],
    ["-1", false],
    ["abc", false],
    ["", false],
    ["100000001", false],
  ])("isValidXLMAmount(%s) === %s", (input, expected) => {
    expect(isValidXLMAmount(input)).toBe(expected);
  });
});

// ─── isValidStellarAddress ────────────────────────────────────────────────────

describe("isValidStellarAddress", () => {
  it("accepts a valid Stellar G-address (56 chars)", () => {
    expect(
      isValidStellarAddress("GBGJFHVDS5CQJCFGGLOFMFXZJ3RCUZHDNJV5PBSYVLVQNKFX7SRP7CDR"),
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
});
