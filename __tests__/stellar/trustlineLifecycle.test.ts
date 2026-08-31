/**
 * Trustline lifecycle: reserve math from live ledger parameters, the full
 * state space, and the guards that stop a user signing a doomed transaction.
 */

import {
  buildChangeTrustTransaction,
  InsufficientReserveError,
} from "@/lib/stellar/trustline";
import {
  describeOnboardingNeed,
  getAccountState,
  getNetworkBaseReserve,
  baseReserveIsLive,
  isBlockingNeed,
  minimumBalanceStroops,
  trustlineReserveStroops,
  BASE_RESERVE_STROOPS,
  __resetBaseReserveCache,
  type AccountState,
} from "@/lib/stellar/accountState";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SPONSOR = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

/** A ledger page as Horizon returns it, carrying the network base reserve. */
function ledgerPage(baseReserveInStroops: number) {
  return {
    _embedded: {
      records: [{ base_reserve_in_stroops: baseReserveInStroops }],
    },
  };
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    sequence: "123",
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    ...overrides,
  };
}

/**
 * Routes by URL so a test can describe the whole ledger, not a call sequence.
 * getAccountState reads /accounts and /ledgers, and the order is an
 * implementation detail tests should not encode.
 */
function routedFetch(routes: { ledger?: unknown; account?: unknown; accountStatus?: number }) {
  return jest.fn(async (url: string) => {
    if (String(url).includes("/ledgers")) {
      return {
        ok: true,
        status: 200,
        json: async () => routes.ledger ?? ledgerPage(5_000_000),
      };
    }
    const status = routes.accountStatus ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => routes.account ?? account(),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  __resetBaseReserveCache();
  jest.restoreAllMocks();
});

describe("base reserve is read from the ledger, never hardcoded", () => {
  it("uses the network's value even when it differs from the historical 0.5 XLM", async () => {
    // The base reserve is a network parameter and can be voted up.
    const fetchImpl = routedFetch({ ledger: ledgerPage(10_000_000) });

    const reserve = await getNetworkBaseReserve("https://horizon.test", fetchImpl);

    expect(reserve).toBe(10_000_000n);
    expect(reserve).not.toBe(BASE_RESERVE_STROOPS);
    expect(baseReserveIsLive()).toBe(true);
  });

  it("propagates the live value into the account's reserve requirement", async () => {
    const fetchImpl = routedFetch({
      ledger: ledgerPage(10_000_000),
      account: account({ subentry_count: 1 }),
    });

    const state = await getAccountState(ACCOUNT, "https://horizon.test", fetchImpl);

    expect(state.baseReserveStroops).toBe(10_000_000n);
    // (2 base + 1 subentry) x 1 XLM
    expect(state.reserveStroops).toBe(30_000_000n);
  });

  it("falls back to the constant when the ledger cannot be read, and retries next call", async () => {
    const failing = jest.fn(async () => {
      throw new Error("horizon down");
    }) as unknown as typeof fetch;

    const first = await getNetworkBaseReserve("https://horizon.test", failing);
    expect(first).toBe(BASE_RESERVE_STROOPS);
    // A guessed value must not masquerade as a ledger reading.
    expect(baseReserveIsLive()).toBe(false);

    // A failed read must not pin the fallback for the cache window.
    const recovering = routedFetch({ ledger: ledgerPage(7_500_000) });
    const second = await getNetworkBaseReserve("https://horizon.test", recovering);
    expect(second).toBe(7_500_000n);
    expect(baseReserveIsLive()).toBe(true);
  });
});

describe("reserve math accounts for subentries, sponsorship and liabilities", () => {
  it("charges a base reserve per subentry", () => {
    expect(minimumBalanceStroops(0, 0, 0, 5_000_000n)).toBe(10_000_000n);
    expect(minimumBalanceStroops(3, 0, 0, 5_000_000n)).toBe(25_000_000n);
  });

  it("credits sponsored entries and charges sponsored-for entries", () => {
    // Someone else pays for two of ours; we pay for one of theirs.
    expect(minimumBalanceStroops(2, 1, 2, 5_000_000n)).toBe(
      minimumBalanceStroops(2, 0, 0, 5_000_000n) - 5_000_000n,
    );
  });

  it("never returns a negative reserve when sponsorship exceeds entries", () => {
    expect(minimumBalanceStroops(0, 0, 99, 5_000_000n)).toBe(0n);
  });

  it("excludes selling liabilities from spendable balance", async () => {
    const fetchImpl = routedFetch({
      account: account({
        subentry_count: 1,
        balances: [
          {
            asset_type: "native",
            balance: "10.0000000",
            selling_liabilities: "4.0000000",
          },
        ],
      }),
    });

    const state = await getAccountState(ACCOUNT, "https://horizon.test", fetchImpl);

    // 10 XLM - 1.5 reserve - 4 committed to open offers.
    expect(state.spendableStroops).toBe(45_000_000n);
  });

  it("does not report a trustline as affordable when offers have committed the balance", async () => {
    const fetchImpl = routedFetch({
      account: account({
        balances: [
          {
            asset_type: "native",
            balance: "1.4000000",
            selling_liabilities: "0.3000000",
          },
        ],
      }),
    });

    const state = await getAccountState(ACCOUNT, "https://horizon.test", fetchImpl);
    const need = describeOnboardingNeed(state, USDC);

    expect(need.kind).toBe("trustline_missing");
    // Balance alone (1.4) looks like it clears 1.0 reserve + 0.5 trustline,
    // but 0.3 is already spoken for by an open offer.
    expect(need).toMatchObject({ affordable: false });
  });
});

describe("the full trustline state space is distinguishable", () => {
  function stateWith(trustline: Record<string, unknown> | null, extra = {}): Promise<AccountState> {
    return getAccountState(
      ACCOUNT,
      "https://horizon.test",
      routedFetch({
        account: account({
          subentry_count: trustline ? 1 : 0,
          balances: [
            { asset_type: "native", balance: "100.0000000" },
            ...(trustline
              ? [
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: "USDC",
                    asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
                    balance: "0.0000000",
                    limit: "1000.0000000",
                    is_authorized: true,
                    ...trustline,
                  },
                ]
              : []),
          ],
          ...extra,
        }),
      }),
    );
  }

  it("no account -> account_creation", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon.test",
      routedFetch({ accountStatus: 404 }),
    );
    expect(describeOnboardingNeed(state, USDC).kind).toBe("account_creation");
  });

  it("no trustline -> trustline_missing", async () => {
    const state = await stateWith(null);
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_missing");
  });

  it("unauthorized -> trustline_unauthorized", async () => {
    const state = await stateWith({
      is_authorized: false,
      is_authorized_to_maintain_liabilities: false,
    });
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_unauthorized");
  });

  it("authorized only to maintain liabilities -> trustline_auth_maintain", async () => {
    const state = await stateWith({
      is_authorized: false,
      is_authorized_to_maintain_liabilities: true,
    });
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_auth_maintain");
  });

  it("at limit -> trustline_at_limit", async () => {
    const state = await stateWith({ balance: "1000.0000000", limit: "1000.0000000" });
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_at_limit");
  });

  it("counts buying liabilities toward the limit", async () => {
    // Headroom exists on paper, but an open buy offer will consume it.
    const state = await stateWith({
      balance: "900.0000000",
      limit: "1000.0000000",
      buying_liabilities: "100.0000000",
    });
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_at_limit");
  });

  it("sponsored -> trustline_sponsored, and is not a blocker", async () => {
    const state = await stateWith({ sponsor: SPONSOR });
    const need = describeOnboardingNeed(state, USDC);

    expect(need.kind).toBe("trustline_sponsored");
    expect(need).toMatchObject({ sponsor: SPONSOR });
    // The user can receive the asset today; only the payer differs.
    expect(isBlockingNeed(need)).toBe(false);
  });

  it("prefers a blocking state over the sponsorship notice", async () => {
    const state = await stateWith({ sponsor: SPONSOR, is_authorized: false });
    expect(describeOnboardingNeed(state, USDC).kind).toBe("trustline_unauthorized");
  });

  it("usable trustline -> none", async () => {
    const state = await stateWith({});
    expect(describeOnboardingNeed(state, USDC).kind).toBe("none");
  });

  it("native XLM never needs a trustline", async () => {
    const state = await stateWith(null);
    expect(describeOnboardingNeed(state, NATIVE_ASSET).kind).toBe("none");
  });

  it("every state maps to exactly one kind", async () => {
    const kinds = await Promise.all(
      [
        stateWith(null),
        stateWith({ is_authorized: false }),
        stateWith({ balance: "1000.0000000", limit: "1000.0000000" }),
        stateWith({ sponsor: SPONSOR }),
        stateWith({}),
      ].map(async (p) => describeOnboardingNeed(await p, USDC).kind),
    );
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe("buildChangeTrustTransaction guards before signing", () => {
  it("refuses native XLM outright", async () => {
    global.fetch = routedFetch({});
    await expect(
      buildChangeTrustTransaction({ publicKey: ACCOUNT, asset: NATIVE_ASSET }),
    ).rejects.toThrow(/does not require a trustline/i);
  });

  it("throws InsufficientReserveError instead of producing an unaffordable XDR", async () => {
    // 1.2 XLM: covers the 1.0 bare-account reserve, but not the extra 0.5.
    global.fetch = routedFetch({
      account: account({ balances: [{ asset_type: "native", balance: "1.2000000" }] }),
    });

    await expect(
      buildChangeTrustTransaction({ publicKey: ACCOUNT, asset: USDC }),
    ).rejects.toBeInstanceOf(InsufficientReserveError);
  });

  it("states the shortfall in XLM so the user is told before, not after, failing", async () => {
    global.fetch = routedFetch({
      account: account({ balances: [{ asset_type: "native", balance: "1.2000000" }] }),
    });

    await expect(
      buildChangeTrustTransaction({ publicKey: ACCOUNT, asset: USDC }),
    ).rejects.toThrow(/0\.5000000 XLM in reserve.*0\.2000000 XLM is spendable/s);
  });

  it("refuses an account that does not exist yet", async () => {
    global.fetch = routedFetch({ accountStatus: 404 });
    await expect(
      buildChangeTrustTransaction({ publicKey: ACCOUNT, asset: USDC }),
    ).rejects.toThrow(/does not exist yet/i);
  });

  it("sizes the reserve from the live base reserve, not the constant", async () => {
    global.fetch = routedFetch({ ledger: ledgerPage(10_000_000) });

    const { reserveStroops } = await buildChangeTrustTransaction({
      publicKey: ACCOUNT,
      asset: USDC,
    });

    expect(reserveStroops).toBe(10_000_000n);
  });

  it("returns the reserve alongside the XDR so it can be disclosed before signing", async () => {
    global.fetch = routedFetch({});

    const result = await buildChangeTrustTransaction({
      publicKey: ACCOUNT,
      asset: USDC,
    });

    expect(result.xdr).toEqual(expect.any(String));
    expect(result.reserveStroops).toBe(trustlineReserveStroops(5_000_000n));
  });

  it("allows a caller that has already checked to skip the affordability gate", async () => {
    global.fetch = routedFetch({
      account: account({ balances: [{ asset_type: "native", balance: "1.2000000" }] }),
    });

    await expect(
      buildChangeTrustTransaction({
        publicKey: ACCOUNT,
        asset: USDC,
        skipAffordabilityCheck: true,
      }),
    ).resolves.toMatchObject({ xdr: expect.any(String) });
  });
});
