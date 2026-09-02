/**
 * Public surface of the money layer.
 *
 * Two exact-arithmetic implementations live side by side: `Money` (the one the
 * application uses) and `Amount` (retained for the arithmetic property suite).
 * They declare the same scale constants and the same `divideBigInt` helper, so
 * a blanket `export * from` on both leaves those names ambiguous and TypeScript
 * drops them from the barrel entirely — every `import { STROOPS_PER_UNIT } from
 * "@/lib/money"` then fails to resolve.
 *
 * `Money` is therefore the one that owns the shared names here. `Amount`'s
 * copies are identical in value, so no caller observes a difference; anything
 * needing `Amount`'s own bindings imports "@/lib/money/amount" directly.
 */

export * from "./money";

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
