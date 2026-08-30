/**
 * Account state detection: unfunded, partially funded, funded.
 *
 * The case that matters most is the first one — a Horizon 404 must be a state
 * with a next step, not an error that stops the flow.
 */

import {
  canReceive,
  describeOnboardingNeed,
  getAccountState,
  minimumBalanceStroops,
  stroopsToXlm,
  trustlineReserveStroops,
} from "@/lib/stellar/accountState";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

function mockFetch(body: unknown, status = 200) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("reserve arithmetic", () => {
  it("requires two base reserves for a bare account", () => {
    expect(minimumBalanceStroops(0, 0, 0, 5_000_000n)).toBe(10_000_000n); // 1 XLM
  });

  it("adds half a lumen per subentry", () => {
    // The number that makes an empty wallet unable to receive USDC.
    expect(minimumBalanceStroops(1, 0, 0, 5_000_000n)).toBe(15_000_000n); // 1.5 XLM
    expect(trustlineReserveStroops(5_000_000n)).toBe(5_000_000n);
  });

  it("reduces the reserve requirement when sponsored", () => {
    // 1 subentry, but 2 entries are sponsored (the 2 base reserves).
    // Effective = 2 + 1 + 0 - 2 = 1. Min balance = 0.5 XLM.
    expect(minimumBalanceStroops(1, 0, 2, 5_000_000n)).toBe(5_000_000n);
  });
});

describe("unfunded accounts", () => {
  it("treats a Horizon 404 as a state, not an error", async () => {
    // The dead end this whole feature exists to remove.
    const state = await getAccountState(ACCOUNT, "https://horizon", mockFetch({}, 404));

    expect(state.status).toBe("unfunded");
    expect(state.balanceStroops).toBe(0n);
  });

  it("still throws when Horizon itself fails", async () => {
    // "We could not check" is not the same as "there is nothing there", and
    // conflating them would report a real account as missing.
    await expect(
      getAccountState(ACCOUNT, "https://horizon", mockFetch({}, 503)),
    ).rejects.toThrow(/network problem/i);
  });

  it("cannot receive anything, native included", async () => {
    const state = await getAccountState(ACCOUNT, "https://horizon", mockFetch({}, 404));

    expect(canReceive(state, NATIVE_ASSET)).toBe(false);
    expect(canReceive(state, USDC)).toBe(false);
  });

  it("needs account creation, sized to include one trustline", async () => {
    const state = await getAccountState(ACCOUNT, "https://horizon", mockFetch({}, 404));
    const need = describeOnboardingNeed(state, USDC);

    expect(need.kind).toBe("account_creation");
    // Sized so the created account can actually hold the asset, rather than
    // needing a second top-up immediately.
    if (need.kind === "account_creation") {
      expect(need.reserveStroops).toBe(15_000_000n);
    }
  });
});

describe("partially funded accounts", () => {
  /** Exists, but every lumen is locked in reserve. */
  const RESERVE_LOCKED = {
    balances: [{ asset_type: "native", balance: "1.0000000" }],
    subentry_count: 0,
  };

  it("reports reserve_locked when nothing is spendable", async () => {
    const state = await getAccountState(ACCOUNT, "https://horizon", mockFetch(RESERVE_LOCKED));

    expect(state.status).toBe("reserve_locked");
    expect(state.balanceStroops).toBe(10_000_000n);
    expect(state.spendableStroops).toBe(0n);
  });

  it("cannot afford a trustline it does not have", async () => {
    // Holding XLM is not the same as being able to transact with it.
    const state = await getAccountState(ACCOUNT, "https://horizon", mockFetch(RESERVE_LOCKED));
    const need = describeOnboardingNeed(state, USDC);

    expect(need.kind).toBe("trustline_missing");
    if (need.kind === "trustline_missing") {
      expect(need.affordable).toBe(false);
    }
  });

  it("can afford a trustline once it has spendable balance", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [{ asset_type: "native", balance: "5.0000000" }],
        subentry_count: 0,
      }),
    );
    const need = describeOnboardingNeed(state, USDC);

    expect(need.kind).toBe("trustline_missing");
    if (need.kind === "trustline_missing") {
      expect(need.affordable).toBe(true);
    }
  });

  it("subtracts subentry reserves from spendable balance", async () => {
    // 2 XLM held, one trustline => 1.5 locked, 0.5 spendable.
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "2.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
            balance: "0",
          },
        ],
        subentry_count: 1,
      }),
    );

    expect(state.reserveStroops).toBe(15_000_000n);
    expect(state.spendableStroops).toBe(5_000_000n);
    expect(stroopsToXlm(state.spendableStroops)).toBe("0.5000000");
  });
});

describe("funded accounts", () => {
  it("can receive an asset it already trusts", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
            balance: "25.0000000",
            limit: "1000.0000000",
            is_authorized: true,
          },
        ],
        subentry_count: 1,
      }),
    );

    expect(state.status).toBe("funded");
    expect(canReceive(state, USDC)).toBe(true);
    expect(describeOnboardingNeed(state, USDC).kind).toBe("none");
  });

  it("does not confuse a counterfeit issuer for a real trustline", async () => {
    // Anyone can issue a token called USDC.
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
            balance: "25.0000000",
          },
        ],
        subentry_count: 1,
      }),
    );

    expect(canReceive(state, USDC)).toBe(false);
  });

  it("reports sponsorship when the account is sponsored", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [{ asset_type: "native", balance: "1.5000000" }],
        subentry_count: 1,
        sponsor: "GSPONSOR",
        num_sponsored: 2,
      }),
    );

    expect(state.sponsored).toBe(true);
    expect(state.sponsorId).toBe("GSPONSOR");
    // With 2 sponsored subentries, effective reserve = 2 + 1 - 2 = 1 (0.5 XLM).
    expect(state.reserveStroops).toBe(5_000_000n);
    expect(state.spendableStroops).toBe(10_000_000n); // 1.5 - 0.5 = 1 XLM
  });

  it("detects unauthorized trustlines", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
            balance: "0",
            is_authorized: false,
          },
        ],
        subentry_count: 1,
      }),
    );

    const need = describeOnboardingNeed(state, USDC);
    expect(need.kind).toBe("trustline_unauthorized");
  });

  it("detects when trustline is at limit", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
            balance: "100.0000000",
            limit: "100.0000000",
            is_authorized: true,
          },
        ],
        subentry_count: 1,
      }),
    );

    const need = describeOnboardingNeed(state, USDC);
    expect(need.kind).toBe("trustline_at_limit");
  });

  it("subtracts native liabilities from spendable balance", async () => {
    const state = await getAccountState(
      ACCOUNT,
      "https://horizon",
      mockFetch({
        balances: [
          { asset_type: "native", balance: "3.0000000", selling_liabilities: "1.0000000" },
        ],
        subentry_count: 0,
      }),
    );

    expect(state.reserveStroops).toBe(10_000_000n); // 1 XLM
    // 3 - 1 (reserve) - 1 (liability) = 1 XLM spendable
    expect(state.spendableStroops).toBe(10_000_000n);
  });
});
