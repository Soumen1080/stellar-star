/**
 * Abuse resistance: creating N accounts must cost an attacker something that
 * scales with N.
 *
 * The threat: sponsorship locks the sponsor's XLM durably, so scripted account
 * creation drains capacity for free. Every check here attaches to the *inviter*
 * rather than the invitee, because invitee addresses are free to generate and
 * are therefore worthless as a rate-limiting key.
 */

import {
  checkEligibility,
  recordInvite,
  releaseInvite,
  resetMemoryInvites,
  INVITE_COOLDOWN_MS,
  MAX_SPONSORSHIPS_PER_INVITER,
} from "@/lib/onboarding/abuseResistance";

const FUNDED_INVITER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function invitee(n: number): string {
  return `GINVITEE${String(n).padStart(46, "0")}`;
}

/** Horizon responses keyed by account, so the inviter's funding can vary. */
function mockHorizon(accounts: Record<string, unknown>) {
  global.fetch = jest.fn(async (url: string) => {
    const match = Object.keys(accounts).find((key) => String(url).includes(key));
    if (!match) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => accounts[match] };
  }) as unknown as typeof fetch;
}

/** A well-funded account: 100 XLM, nothing locked beyond the base reserve. */
const WELL_FUNDED = {
  balances: [{ asset_type: "native", balance: "100.0000000" }],
  subentry_count: 0,
};

const originalFetch = global.fetch;

beforeEach(() => {
  resetMemoryInvites();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("cost 1 — the inviter must be an established account", () => {
  it("refuses an inviter with no account", async () => {
    // This is what stops the attack bootstrapping itself: you cannot use
    // sponsored accounts to sponsor more accounts.
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await checkEligibility(FUNDED_INVITER, invitee(1));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("inviter_unfunded");
  });

  it("refuses an inviter whose balance is all locked in reserve", async () => {
    mockHorizon({
      [FUNDED_INVITER]: {
        balances: [{ asset_type: "native", balance: "1.0000000" }],
        subentry_count: 0,
      },
    });

    const result = await checkEligibility(FUNDED_INVITER, invitee(1));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("inviter_below_threshold");
  });

  it("allows a funded inviter", async () => {
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });

    expect((await checkEligibility(FUNDED_INVITER, invitee(1))).allowed).toBe(true);
  });
});

describe("cost 2 — a per-inviter quota", () => {
  it("stops an inviter past their quota", async () => {
    // N accounts therefore needs N/quota distinct funded inviters, so the
    // attacker's cost grows linearly rather than amortising to nothing.
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });

    const base = 1_000_000;
    for (let i = 0; i < MAX_SPONSORSHIPS_PER_INVITER; i += 1) {
      // Spaced past the cooldown so the quota is what bites, not the timer.
      await recordInvite(FUNDED_INVITER, invitee(i), base + i * INVITE_COOLDOWN_MS * 2);
    }

    const result = await checkEligibility(
      FUNDED_INVITER,
      invitee(999),
      base + MAX_SPONSORSHIPS_PER_INVITER * INVITE_COOLDOWN_MS * 2,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("inviter_quota_exceeded");
  });

  it("frees a quota slot when a sponsorship is revoked", async () => {
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });

    const base = 1_000_000;
    for (let i = 0; i < MAX_SPONSORSHIPS_PER_INVITER; i += 1) {
      await recordInvite(FUNDED_INVITER, invitee(i), base + i * INVITE_COOLDOWN_MS * 2);
    }

    await releaseInvite(FUNDED_INVITER, invitee(0));

    const result = await checkEligibility(
      FUNDED_INVITER,
      invitee(999),
      base + MAX_SPONSORSHIPS_PER_INVITER * INVITE_COOLDOWN_MS * 2,
    );

    expect(result.allowed).toBe(true);
  });

  it("refuses to sponsor the same account twice", async () => {
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });
    await recordInvite(FUNDED_INVITER, invitee(1), 1_000_000);

    const result = await checkEligibility(FUNDED_INVITER, invitee(1), 1_000_000);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("already_sponsored");
  });
});

describe("cost 3 — a cooldown", () => {
  it("rate-limits consecutive invites from one wallet", async () => {
    // Converts a scripted burst into a drip that monitoring can catch.
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });
    await recordInvite(FUNDED_INVITER, invitee(1), 1_000_000);

    const result = await checkEligibility(FUNDED_INVITER, invitee(2), 1_000_100);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("inviter_cooldown");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows the next invite once the cooldown has elapsed", async () => {
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });
    await recordInvite(FUNDED_INVITER, invitee(1), 1_000_000);

    const result = await checkEligibility(
      FUNDED_INVITER,
      invitee(2),
      1_000_000 + INVITE_COOLDOWN_MS + 1,
    );

    expect(result.allowed).toBe(true);
  });
});

describe("the combined cost", () => {
  it("bounds one wallet's total drain regardless of how many it tries", async () => {
    // The property that matters: a single funded identity cannot exceed its
    // quota no matter how many invitee addresses it generates, and invitee
    // addresses are the only thing that is free.
    mockHorizon({ [FUNDED_INVITER]: WELL_FUNDED });

    let granted = 0;
    let clock = 1_000_000;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await checkEligibility(FUNDED_INVITER, invitee(attempt), clock);
      if (result.allowed) {
        await recordInvite(FUNDED_INVITER, invitee(attempt), clock);
        granted += 1;
      }
      clock += INVITE_COOLDOWN_MS * 2;
    }

    expect(granted).toBe(MAX_SPONSORSHIPS_PER_INVITER);
  });
});
