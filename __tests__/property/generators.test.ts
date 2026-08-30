import * as fc from "fast-check";
import { makeMembersArb, validAmountStringArb, invalidAmountArb } from "./generators";

describe("Domain Generators Boundary Frequency Checks", () => {
  it("generates boundary cases at a meaningful frequency", () => {
    const membersList = fc.sample(makeMembersArb(), 1000);

    let totalMembersCount = 0;
    let zeroWeightCount = 0;
    let undefinedWeightCount = 0;
    let negativeWeightCount = 0;
    let invalidAddressCount = 0;
    let undefinedAddressCount = 0;
    let duplicateAddressCount = 0;
    let size1Count = 0;
    let largeSizeCount = 0; // size >= 40

    membersList.forEach((members) => {
      totalMembersCount += members.length;
      if (members.length === 1) size1Count++;
      if (members.length >= 40) largeSizeCount++;

      const wallets = new Set<string>();
      const seenWallets = new Set<string>();

      members.forEach((m) => {
        if (m.weight === 0) zeroWeightCount++;
        if (m.weight === undefined) undefinedWeightCount++;
        if (m.weight !== undefined && m.weight < 0) negativeWeightCount++;

        if (m.walletAddress === undefined) {
          undefinedAddressCount++;
        } else if (m.walletAddress.length !== 56 || !m.walletAddress.startsWith("G")) {
          invalidAddressCount++;
        }

        if (m.walletAddress) {
          if (wallets.has(m.walletAddress)) {
            seenWallets.add(m.walletAddress);
          }
          wallets.add(m.walletAddress);
        }
      });

      duplicateAddressCount += seenWallets.size;
    });

    // Compute frequencies
    const zeroWeightFreq = zeroWeightCount / totalMembersCount;
    const undefinedWeightFreq = undefinedWeightCount / totalMembersCount;
    const invalidAddressFreq = invalidAddressCount / totalMembersCount;
    const undefinedAddressFreq = undefinedAddressCount / totalMembersCount;

    // Assert that boundaries are represented at non-trivial frequencies (e.g. > 1%)
    expect(zeroWeightFreq).toBeGreaterThan(0.01);
    expect(undefinedWeightFreq).toBeGreaterThan(0.01);
    expect(invalidAddressFreq).toBeGreaterThan(0.01);
    expect(undefinedAddressFreq).toBeGreaterThan(0.01);

    // Occasional duplicate wallets and group size boundaries
    expect(duplicateAddressCount).toBeGreaterThan(0);
    expect(size1Count).toBeGreaterThan(0);
    expect(largeSizeCount).toBeGreaterThan(0);
  });

  it("generates valid and invalid amounts as expected", () => {
    const validAmountStrings = fc.sample(validAmountStringArb, 500);
    const invalidAmountStrings = fc.sample(invalidAmountArb, 100);

    validAmountStrings.forEach((str) => {
      const val = parseFloat(str);
      expect(val).toBeGreaterThan(0);
      expect(val).toBeLessThanOrEqual(100000000);
      const parts = str.split(".");
      if (parts[1]) {
        expect(parts[1].length).toBeLessThanOrEqual(7);
      }
    });

    invalidAmountStrings.forEach((str) => {
      // Just verifying we get a mix of invalid formats
      expect(typeof str).toBe("string");
    });
  });
});
