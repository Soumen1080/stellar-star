import * as fc from "fast-check";
import {
  calculateEqualSplit,
  calculateCustomSplit,
  calculateSplit,
  isValidXLMAmount,
  isValidStellarAddress,
  findDuplicateWalletErrors,
} from "@/lib/split/calculator";
import {
  makeMembersArb,
  validAmountFloatArb,
  validAmountStringArb,
  invalidAmountArb,
} from "./generators";

describe("Split Property Tests", () => {
  it("conserves total XLM in equal split", () => {
    fc.assert(
      fc.property(
        validAmountFloatArb,
        makeMembersArb({ forceUniqueWallets: true }).filter((m) => m.length >= 2),
        fc.nat(),
        (totalXLM, members, paidIdx) => {
          const payer = members[paidIdx % members.length];
          const shares = calculateEqualSplit(totalXLM, members, payer.id);

          expect(shares).toHaveLength(members.length - 1);

          // All share amounts should have exactly 7 decimal places
          shares.forEach((s) => {
            expect(s.amount).toMatch(/^\d+\.\d{7}$/);
          });

          // Conservation: Payer's share is the remainder. The actual payer's share (total - sumNonPayers)
          // must be within rounding tolerance of expected perHead share.
          const sumNonPayers = shares.reduce((acc, s) => acc + parseFloat(s.amount), 0);
          const actualPayerShare = totalXLM - sumNonPayers;
          const expectedPayerShare = totalXLM / members.length;
          const maxRoundingError = members.length * 1e-7;
          expect(Math.abs(actualPayerShare - expectedPayerShare)).toBeLessThanOrEqual(maxRoundingError + 1e-9);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("conserves total XLM in custom split", () => {
    fc.assert(
      fc.property(
        validAmountFloatArb,
        makeMembersArb({ forceUniqueWallets: true }).filter((m) => {
          if (m.length < 2) return false;
          // Ensure total weight is positive
          const totalWeight = m.reduce((s, x) => s + (x.weight ?? 1), 0);
          return totalWeight > 0;
        }),
        fc.nat(),
        (totalXLM, members, paidIdx) => {
          const payer = members[paidIdx % members.length];
          const shares = calculateCustomSplit(totalXLM, members, payer.id);

          expect(shares).toHaveLength(members.length - 1);

          // Check formatting
          shares.forEach((s) => {
            expect(s.amount).toMatch(/^\d+\.\d{7}$/);
          });

          // Conservation: Payer's share is the remainder. The actual payer's share (total - sumNonPayers)
          // must be within rounding tolerance of expected custom share.
          const sumNonPayers = shares.reduce((acc, s) => acc + parseFloat(s.amount), 0);
          const totalWeight = members.reduce((s, m) => s + (m.weight ?? 1), 0);
          const payerWeight = payer.weight ?? 1;
          const expectedPayerShare = (totalXLM * payerWeight) / totalWeight;
          const actualPayerShare = totalXLM - sumNonPayers;
          const maxRoundingError = members.length * 1e-7;
          expect(Math.abs(actualPayerShare - expectedPayerShare)).toBeLessThanOrEqual(maxRoundingError + 1e-9);

          // Zero-weight members should receive 0.0000000 (except the last non-payer who absorbs remainder)
          shares.forEach((s, idx) => {
            const isLast = idx === shares.length - 1;
            const m = members.find((x) => x.id === s.memberId);
            if (m && m.weight === 0 && !isLast) {
              expect(s.amount).toBe("0.0000000");
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(
        validAmountFloatArb,
        makeMembersArb({ forceUniqueWallets: true }).filter((m) => m.length >= 2),
        fc.nat(),
        fc.constantFrom("equal", "custom" as const),
        (totalXLM, members, paidIdx, mode) => {
          const payer = members[paidIdx % members.length];
          const shares1 = calculateSplit(totalXLM, members, payer.id, mode);
          const shares2 = calculateSplit(totalXLM, members, payer.id, mode);

          expect(shares1).toEqual(shares2);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("validates XLM amounts correctly", () => {
    fc.assert(
      fc.property(validAmountStringArb, (str) => {
        expect(isValidXLMAmount(str)).toBe(true);
      }),
      { numRuns: 100 }
    );

    fc.assert(
      fc.property(invalidAmountArb, (str) => {
        expect(isValidXLMAmount(str)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it("identifies duplicate wallets correctly", () => {
    fc.assert(
      fc.property(
        makeMembersArb({ forceUniqueWallets: false }),
        (members) => {
          const addresses = members.map((m) => m.walletAddress);
          const errors = findDuplicateWalletErrors(addresses);

          // Count frequency of each address (only if non-empty and valid)
          const freq = new Map<string, number>();
          addresses.forEach((addr) => {
            const trimmed = addr?.trim();
            if (!trimmed || !isValidStellarAddress(trimmed)) return;
            const norm = trimmed.toUpperCase();
            freq.set(norm, (freq.get(norm) ?? 0) + 1);
          });

          // Verify errors
          addresses.forEach((addr, idx) => {
            const trimmed = addr?.trim();
            if (!trimmed || !isValidStellarAddress(trimmed)) {
              expect(errors[idx]).toBeUndefined();
              return;
            }
            const norm = trimmed.toUpperCase();
            const count = freq.get(norm) ?? 0;

            if (count > 1) {
              expect(errors[idx]).toBeDefined();
              expect(errors[idx]).toContain("Duplicate wallet address");
            } else {
              expect(errors[idx]).toBeUndefined();
            }
          });
        }
      ),
      { numRuns: 100 }
    );
  });
});
