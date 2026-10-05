/**
 * Public entry point for money arithmetic.
 *
 * Two exact-arithmetic implementations live side by side: `money.ts` (the
 * `Money` class, used throughout the app) and `amount.ts` (the `Amount` class,
 * exercised directly by the property tests). They declare the same scale
 * constants and the same `RoundingMode` / `divideBigInt` helpers, so a blanket
 * `export *` from both makes each of those names ambiguous and TypeScript drops
 * them from the barrel entirely — which is why `STROOPS_PER_UNIT` and friends
 * could not be imported from "@/lib/money".
 *
 * `money.ts` is the canonical source for the shared names. `amount.ts` is
 * re-exported for everything unique to it; importers that want its duplicated
 * constants should reach for "@/lib/money/amount" directly.
 */

export * from "./money";
export * from "./assetPrecision";

export {
  Amount,
  parse,
  tryParse,
  add,
  sub,
  mul,
  div,
  format,
  compare,
  toStroops,
  fromStroops,
  toScVal,
  fromScVal,
  sum,
  min,
  max,
} from "./amount";
