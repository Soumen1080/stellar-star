import { computeNetPayments, simplifyDebts, type RawDebt } from "@/lib/settlement/netBalance";

describe("computeNetPayments", () => {
  // ─── Basic single debt ─────────────────────────────────────────────────────

  it("produces one payment for a simple single debt", () => {
    const debts: RawDebt[] = [{ expenseId: "exp1", fromId: "u1", toId: "u2", from: "Alice", to: "Bob", amount: 100, asset: "native" }];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("Alice");
    expect(result[0].to).toBe("Bob");
    expect(parseFloat(result[0].amount)).toBeCloseTo(100, 5);
    expect(result[0].settledDebts).toHaveLength(1);
    expect(result[0].settledDebts[0].expenseId).toBe("exp1");
  });

  // ─── Empty debts ──────────────────────────────────────────────────────────

  it("returns empty array when there are no debts", () => {
    expect(computeNetPayments([])).toHaveLength(0);
  });

  // ─── Simplification vs Pairwise ───────────────────────────────────────────

  it("cancels mutual opposing debts by default in simplified mode", () => {
    // Alice owes Bob 100, Bob owes Alice 40 => Alice owes Bob 60 net
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "Alice", to: "Bob", amount: 100, asset: "native" },
      { expenseId: "exp2", fromId: "u2", toId: "u1", from: "Bob",   to: "Alice", amount: 40, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("Alice");
    expect(result[0].to).toBe("Bob");
    expect(parseFloat(result[0].amount)).toBeCloseTo(60, 5);
  });

  it("supports pairwise mode when explicitly requested", () => {
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "Alice", to: "Bob", amount: 100, asset: "native" },
      { expenseId: "exp2", fromId: "u2", toId: "u1", from: "Bob",   to: "Alice", amount: 40, asset: "native" },
    ];
    const result = computeNetPayments(debts, { mode: "pairwise" });
    expect(result).toHaveLength(2);
    
    const p1 = result.find(p => p.from === "Alice" && p.to === "Bob");
    expect(parseFloat(p1!.amount)).toBeCloseTo(100, 5);
    
    const p2 = result.find(p => p.from === "Bob" && p.to === "Alice");
    expect(parseFloat(p2!.amount)).toBeCloseTo(40, 5);
  });

  it("consolidates multiple debts in the same direction exactly", () => {
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "Alice", to: "Bob", amount: 50, asset: "native" },
      { expenseId: "exp2", fromId: "u1", toId: "u2", from: "Alice", to: "Bob", amount: 50, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(parseFloat(result[0].amount)).toBeCloseTo(100, 5);
    expect(result[0].settledDebts).toHaveLength(2);
  });

  // ─── Transitive chains ─────────────────────────────────────────────────────

  it("simplifies transitive chains in simplified mode (A->B 100, B->C 100 => A->C 100)", () => {
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "A", to: "B", amount: 100, asset: "native" },
      { expenseId: "exp2", fromId: "u2", toId: "u3", from: "B", to: "C", amount: 100, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("A");
    expect(result[0].to).toBe("C");
    expect(parseFloat(result[0].amount)).toBeCloseTo(100, 5);
  });

  it("preserves chains in pairwise mode", () => {
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "A", to: "B", amount: 100, asset: "native" },
      { expenseId: "exp2", fromId: "u2", toId: "u3", from: "B", to: "C", amount: 100, asset: "native" },
    ];
    const result = computeNetPayments(debts, { mode: "pairwise" });
    expect(result).toHaveLength(2);
    expect(result[0].from).toBe("A");
    expect(result[0].to).toBe("B");
    expect(result[1].from).toBe("B");
    expect(result[1].to).toBe("C");
  });

  it("works with multiple creditors/debtors", () => {
    // Alice paid for everyone: Bob owes 30, Carol owes 70
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u2", toId: "u1", from: "Bob",   to: "Alice", amount: 30, asset: "native" },
      { expenseId: "exp1", fromId: "u3", toId: "u1", from: "Carol", to: "Alice", amount: 70, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    const total = result.reduce((s, p) => s + parseFloat(p.amount), 0);
    expect(total).toBeCloseTo(100, 5);
    result.forEach((p) => expect(p.to).toBe("Alice"));
  });
  
  it("differentiates duplicate names using fromId and toId", () => {
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "userA1", toId: "userB1", from: "John", to: "Jane", amount: 30, asset: "native" },
      { expenseId: "exp2", fromId: "userA2", toId: "userB1", from: "John", to: "Jane", amount: 70, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    // Two different Johns paying Jane, should remain separate payments
    expect(result).toHaveLength(2);
    expect(result[0].from).toBe("John");
    expect(result[1].from).toBe("John");
  });

  // ─── Wallet passthrough ────────────────────────────────────────────────────

  it("propagates wallet addresses to the result", () => {
    const debts: RawDebt[] = [
      {
        expenseId: "exp1",
        fromId: "u1",
        toId: "u2",
        from:       "Alice",
        to:         "Bob",
        amount:     50,
        asset:      "native",
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
    const debts: RawDebt[] = [{ expenseId: "exp1", fromId: "u1", toId: "u2", from: "A", to: "B", amount: 33.3333333, asset: "native" }];
    const result = computeNetPayments(debts);
    expect(result[0].amount).toMatch(/^\d+\.\d{7}$/);
  });

  it("isolates debts in different assets completely", () => {
    // A owes B 20 USDC and 50 XLM
    const debts: RawDebt[] = [
      { expenseId: "exp1", fromId: "u1", toId: "u2", from: "A", to: "B", amount: 20, asset: "USDC:GABC..." },
      { expenseId: "exp2", fromId: "u1", toId: "u2", from: "A", to: "B", amount: 50, asset: "native" },
    ];
    const result = computeNetPayments(debts);
    expect(result).toHaveLength(2);
    
    const usdcP = result.find(p => p.asset === "USDC:GABC...");
    expect(parseFloat(usdcP!.amount)).toBeCloseTo(20, 5);
    
    const xlmP = result.find(p => p.asset === "native");
    expect(parseFloat(xlmP!.amount)).toBeCloseTo(50, 5);
  });
});
