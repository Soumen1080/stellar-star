import * as fc from "fast-check";
import { StrKey } from "@stellar/stellar-sdk";
import type { Member } from "@/types/expense";
import type { RawDebt } from "@/lib/settlement/netBalance";

/**
 * A `unit` arbitrary drawing single characters from `chars`.
 *
 * fast-check v4 replaced `fc.string`'s `alphabet` option with `unit`; passing
 * `alphabet` is a type error and, before that, was silently ignored — which let
 * these generators emit values outside the alphabet they name.
 */
function charsFrom(chars: string): fc.Arbitrary<string> {
  return fc.constantFrom(...chars.split(""));
}

// ─── Deterministic valid Stellar Address Generator ────────────────────────────
export const validAddressArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => StrKey.encodeEd25519PublicKey(Buffer.from(bytes)));

export const invalidAddressArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 55 }),
  fc.constant(""),
  fc.string({ minLength: 57, maxLength: 100 })
);

// ─── Weights Generator ────────────────────────────────────────────────────────
// Biased towards boundaries: zero, negative, undefined, large, or round values.
export const weightArb = fc.oneof(
  { arbitrary: fc.constant(undefined), weight: 3 },
  { arbitrary: fc.constant(0), weight: 2 },
  { arbitrary: fc.constant(1), weight: 5 },
  { arbitrary: fc.integer({ min: 2, max: 100 }), weight: 3 },
  { arbitrary: fc.double({ min: 0.1, max: 10.0, noNaN: true }), weight: 1 }
);

// ─── Member Generator ─────────────────────────────────────────────────────────
export interface GeneratorMemberOptions {
  forceUniqueWallets?: boolean;
}

export function makeMemberArb(index: number, options: GeneratorMemberOptions = {}): fc.Arbitrary<Member> {
  const walletArb = options.forceUniqueWallets
    ? validAddressArb
    : fc.oneof(
        { arbitrary: validAddressArb, weight: 8 },
        { arbitrary: invalidAddressArb, weight: 1 },
        { arbitrary: fc.constant(undefined), weight: 1 }
      );

  return fc.record({
    id: fc.constant(`m-${index}`),
    name: fc.oneof(
      fc.constant(`Member ${index}`),
      fc.string({ minLength: 3, maxLength: 12, unit: charsFrom("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") })
    ),
    walletAddress: walletArb,
    weight: weightArb,
  });
}

// Generates between 1 and 50 members.
// Biases towards boundary group sizes: 1, 2, 50, and duplicates/zero-weights.
export function makeMembersArb(options: GeneratorMemberOptions = {}): fc.Arbitrary<Member[]> {
  return fc.integer({ min: 1, max: 50 }).chain((size) => {
    const memberArbs = Array.from({ length: size }, (_, i) => makeMemberArb(i, options));
    return fc.tuple(...memberArbs).chain((members) => {
      // Occasional wallet address duplication across members (if not forced unique)
      if (!options.forceUniqueWallets && size > 1) {
        return fc.double().map((rand) => {
          if (rand < 0.2) {
            // Duplicate the first member's wallet address to some others
            const wallet = members[0].walletAddress;
            if (wallet) {
              for (let i = 1; i < members.length; i++) {
                if (Math.random() < 0.3) {
                  members[i] = { ...members[i], walletAddress: wallet };
                }
              }
            }
          }
          return members;
        });
      }
      return fc.constant(members);
    });
  });
}

// ─── XLM / Asset Amount Generator ─────────────────────────────────────────────
// Valid amount: 0 < amount <= 100,000,000 with at most 7 decimals.
export const validAmountStroopsArb = fc.bigInt({
  min: 1n,
  max: 1_000_000_000_000_000n, // 100,000,000 XLM in stroops
});

export const validAmountStringArb = validAmountStroopsArb.map((stroops) => {
  const str = stroops.toString().padStart(8, "0");
  const whole = str.slice(0, -7);
  const frac = str.slice(-7);
  return `${whole || "0"}.${frac}`;
});

export const validAmountFloatArb = validAmountStringArb.map((str) => parseFloat(str));

export const invalidAmountArb = fc.oneof(
  fc.constant("0"),
  fc.constant("-1"),
  fc.constant("100000000.0000001"), // slightly too large (precision)
  fc.constant("100000001"), // too large
  fc.constant("abc"),
  fc.constant(""),
  // More than 7 decimals
  fc.constant("1.12345678"),
  fc.constant("0.00000001") // too small / 8 decimals
);

// ─── Asset Generator ──────────────────────────────────────────────────────────
export const assetArb = fc.oneof(
  fc.constant("native"),
  fc.constant("USDC"),
  fc.tuple(
    fc.string({ minLength: 3, maxLength: 4, unit: charsFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZ") }),
    validAddressArb
  ).map(([code, issuer]) => `${code}:${issuer}`)
);

// ─── Debt Graph Generator ─────────────────────────────────────────────────────
export interface DebtGraphOptions {
  maxDebts?: number;
}

export function makeRawDebtsArb(options: DebtGraphOptions = {}): fc.Arbitrary<{ members: Member[]; debts: RawDebt[] }> {
  const maxDebts = options.maxDebts ?? 30;

  // We generate a set of members first, then generate debts between them
  return makeMembersArb({ forceUniqueWallets: true }).chain((members) => {
    if (members.length < 2) {
      return fc.constant({ members, debts: [] });
    }

    const memberIds = members.map((m) => m.id);

    const debtArb = fc.record({
      expenseId: fc.string({ minLength: 3, maxLength: 8, unit: charsFrom("0123456789abcdef") }),
      fromIdx: fc.integer({ min: 0, max: members.length - 1 }),
      toIdx: fc.integer({ min: 0, max: members.length - 1 }),
      amount: validAmountStringArb,
      asset: assetArb,
    });

    return fc.array(debtArb, { minLength: 0, maxLength: maxDebts }).map((tempDebts) => {
      const debts: RawDebt[] = [];
      tempDebts.forEach((td, i) => {
        // Avoid self-payments unless explicitly testing boundaries
        let fromIdx = td.fromIdx;
        let toIdx = td.toIdx;
        if (fromIdx === toIdx) {
          toIdx = (fromIdx + 1) % members.length;
        }

        const fromMem = members[fromIdx];
        const toMem = members[toIdx];

        debts.push({
          expenseId: `exp-${td.expenseId}-${i}`,
          fromId: fromMem.id,
          toId: toMem.id,
          from: fromMem.name,
          to: toMem.name,
          amount: td.amount,
          asset: td.asset,
          fromWallet: fromMem.walletAddress,
          toWallet: toMem.walletAddress,
        });
      });

      return { members, debts };
    });
  });
}
