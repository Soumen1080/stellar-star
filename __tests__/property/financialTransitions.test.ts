import * as fc from "fast-check";

/** Model the row lock used by record_share_installment under concurrent callers. */
async function settleConcurrently(balance: number, installments: Array<{ amount: number; hash: string }>) {
  let paid = 0;
  const acceptedHashes = new Set<string>();
  let queue: Promise<void> = Promise.resolve();

  const record = async ({ amount, hash }: { amount: number; hash: string }) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (acceptedHashes.has(hash) || amount <= 0 || paid + amount > balance) return false;
      paid += amount;
      acceptedHashes.add(hash);
      return true;
    } finally {
      release();
    }
  };

  const outcomes = await Promise.all(installments.map((item) => record(item)));
  return { paid, accepted: outcomes.filter(Boolean).length, acceptedHashes };
}

describe("financial transition race properties", () => {
  it("never accepts concurrent installments above the share balance", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 10_000_000 }),
      fc.array(fc.record({
        amount: fc.integer({ min: 1, max: 10_000_000 }),
        hash: fc.string({ minLength: 1, maxLength: 8 }),
      }), { minLength: 1, maxLength: 30 }),
      async (balance, installments) => {
        const result = await settleConcurrently(balance, installments);
        expect(result.paid).toBeLessThanOrEqual(balance);
        expect(result.accepted).toBe(result.acceptedHashes.size);
      },
    ));
  });
});
