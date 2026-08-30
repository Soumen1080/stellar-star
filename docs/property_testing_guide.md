# Property-Based Testing Guide for the Money Path

This guide describes how to run, debug, and expand the property-based testing harness for the money path in the application.

## Overview
Property-based testing is implemented using [fast-check](https://github.com/dubzzz/fast-check). Unlike example-based tests that assert correctness for hardcoded scenarios, property-based tests assert that general *invariants* hold true across thousands of automatically generated inputs (including edge and boundary cases).

## Files and Structure
- **Generators Library**: [generators.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/generators.ts) - Defines domain-specific generators (members, weights, amounts, assets, and debt graphs).
- **Split Invariants**: [split.test.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/split.test.ts) - Verifies arithmetic exactness, formatting, zero-weight logic, and duplicates.
- **Netting Invariants**: [netting.test.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/netting.test.ts) - Verifies conservation of net positions, asset isolation, and determinism.
- **Simplification Invariants**: [simplification.test.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/simplification.test.ts) - Verifies the S5 debt simplification algorithm (cycles collapse, netting, components, benchmarks).
- **Arithmetic Invariants**: [arithmetic.test.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/arithmetic.test.ts) - Verifies conversion exactness of `xlmToStroops` and precision.

---

## Domain Generators
The generators in [generators.ts](file:///c:/Users/SRIZA/Desktop/New%20folder/stellar-star-2.0/__tests__/property/generators.ts) are designed to heavily bias towards boundary and edge cases:
- `makeMembersArb()`: Generates lists of 1 to 50 members with zero weights, negative weights, invalid addresses, and duplicate wallet addresses.
- `validAmountStringArb` / `validAmountFloatArb`: Generates valid XLM amounts up to 100,000,000 with up to 7 decimal places.
- `invalidAmountArb`: Generates invalid formats (e.g. non-numeric, negative, too large, > 7 decimal places).
- `makeRawDebtsArb()`: Generates arbitrary debt graphs with cycles, mixed assets, and self-payments.

---

## Seeded Replay & Shrinking
If a property test fails, `fast-check` will automatically:
1. **Shrink the failure**: Iteratively reduce the failing input to the simplest possible counterexample (e.g. shrinking a complex 50-member graph down to a 2-member graph).
2. **Print the Seed**: Output a unique seed in the console logs.

### Replaying a Failure
To replay the exact same test run that failed:
Set the `FC_SEED` environment variable to the seed printed in the output. For example:

```bash
$env:FC_SEED="1958204859"
npm test
```

The harness is configured in `jest.setup.ts` to automatically read this environment variable and seed the PRNG, ensuring 100% deterministic replayability.

---

## Writing New Property Tests
To add a new property test:
1. Define the invariant/property you want to test.
2. Select or write appropriate generators from `generators.ts`.
3. Call `fc.assert(fc.property(...))` within your test file.

Example:
```typescript
import * as fc from "fast-check";
import { makeMembersArb } from "./generators";

describe("My New Property", () => {
  it("always holds true", () => {
    fc.assert(
      fc.property(makeMembersArb(), (members) => {
        // Assert your invariant here
        expect(members.length).toBeGreaterThanOrEqual(1);
      })
    );
  });
});
```
