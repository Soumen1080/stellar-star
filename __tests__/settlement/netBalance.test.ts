import { computeNetPayments, type RawDebt } from "@/lib/settlement/netBalance";

describe("computeNetPayments", () => {
  // ─── Basic single debt ─────────────────────────────────────────────────────

  it("produces one payment for a simple single debt", () => {
    const debts: RawDebt[] = [{ from: "Alice", to: "Bob", amount: 100 }];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("Alice");
    expect(result[0].to).toBe("Bob");
    expect(parseFloat(result[0].amount)).toBeCloseTo(100, 5);
  });

  // ─── Empty debts ──────────────────────────────────────────────────────────

  it("returns empty array when there are no debts", () => {
    expect(computeNetPayments([])).toHaveLength(0);
  });

  // ─── Netting ──────────────────────────────────────────────────────────────

  it("nets opposing debts between two people", () => {
    // Alice owes Bob 100, Bob owes Alice 40 → Alice owes Bob 60 net
    const debts: RawDebt[] = [
      { from: "Alice", to: "Bob", amount: 100 },
      { from: "Bob",   to: "Alice", amount: 40 },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("Alice");
    expect(result[0].to).toBe("Bob");
    expect(parseFloat(result[0].amount)).toBeCloseTo(60, 5);
  });

  it("produces zero payments when debts exactly cancel out", () => {
    const debts: RawDebt[] = [
      { from: "Alice", to: "Bob", amount: 50 },
      { from: "Bob",   to: "Alice", amount: 50 },
    ];
    expect(computeNetPayments(debts)).toHaveLength(0);
  });

  // ─── Three-person settlement ───────────────────────────────────────────────

  it("produces minimal payments for a chain of 3 people", () => {
    // A owes B 100, B owes C 100 → A pays C 100 directly (or A→B 100, B→C 100)
    // netBalance: A = -100, B = 0, C = +100. So A pays C 100.
    const debts: RawDebt[] = [
      { from: "A", to: "B", amount: 100 },
      { from: "B", to: "C", amount: 100 },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("A");
    expect(result[0].to).toBe("C");
    expect(parseFloat(result[0].amount)).toBeCloseTo(100, 5);
  });

  it("works with multiple creditors/debtors", () => {
    // Alice paid for everyone: Bob owes 30, Carol owes 70
    const debts: RawDebt[] = [
      { from: "Bob",   to: "Alice", amount: 30 },
      { from: "Carol", to: "Alice", amount: 70 },
    ];
    const result = computeNetPayments(debts);
    // Both debts are to Alice — should produce 2 separate payments
    const total = result.reduce((s, p) => s + parseFloat(p.amount), 0);
    expect(total).toBeCloseTo(100, 5);
    result.forEach((p) => expect(p.to).toBe("Alice"));
  });

  // ─── Wallet passthrough ────────────────────────────────────────────────────

  it("propagates wallet addresses to the result", () => {
    const debts: RawDebt[] = [
      {
        from:       "Alice",
        to:         "Bob",
        amount:     50,
        fromWallet: "GABC",
        toWallet:   "GXYZ",
      },
    ];
    const result = computeNetPayments(debts);
    expect(result[0].fromWallet).toBe("GABC");
    expect(result[0].toWallet).toBe("GXYZ");
  });

  // ─── Amount format ─────────────────────────────────────────────────────────

  it("amounts in the result are strings with 7 decimal places", () => {
    const debts: RawDebt[] = [{ from: "A", to: "B", amount: 33.3333333 }];
    const result = computeNetPayments(debts);
    expect(result[0].amount).toMatch(/^\d+\.\d{7}$/);
  });
});
