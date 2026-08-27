/**
 * Sponsorship accounting: the cap, exhaustion, and revocation.
 *
 * Sponsorship locks the sponsor's XLM durably rather than spending it, so the
 * cap is what stands between the app and a scripted drain. These tests are
 * about that boundary holding.
 */

import {
  getCapacity,
  getSponsorship,
  listReclaimable,
  markRevoked,
  releaseFailedReservation,
  reserveCapacity,
  resetMemoryLedger,
  touchActivity,
  SPONSORSHIP_CAP_STROOPS,
  SPONSORSHIP_IDLE_RECLAIM_MS,
  SPONSORSHIP_PER_ACCOUNT_STROOPS,
} from "@/lib/onboarding/sponsorshipLedger";

const INVITER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function account(n: number): string {
  return `GACCOUNT${String(n).padStart(46, "0")}`;
}

beforeEach(() => {
  resetMemoryLedger();
});

describe("capacity accounting", () => {
  it("starts with nothing committed", async () => {
    const capacity = await getCapacity();

    expect(capacity.committedStroops).toBe(0n);
    expect(capacity.exhausted).toBe(false);
  });

  it("commits one account's reserve per sponsorship", async () => {
    await reserveCapacity(account(1), INVITER);
    await reserveCapacity(account(2), INVITER);

    const capacity = await getCapacity();

    expect(capacity.activeCount).toBe(2);
    expect(capacity.committedStroops).toBe(SPONSORSHIP_PER_ACCOUNT_STROOPS * 2n);
  });

  it("is idempotent for an account already sponsored", async () => {
    // Otherwise a retry would lock a second reserve for one account.
    const first = await reserveCapacity(account(1), INVITER);
    const second = await reserveCapacity(account(1), INVITER);

    expect(second?.createdAt).toBe(first?.createdAt);
    expect((await getCapacity()).committedStroops).toBe(SPONSORSHIP_PER_ACCOUNT_STROOPS);
  });
});

describe("the sponsor-exhausted case", () => {
  /** Fills the cap to within less than one account's headroom. */
  async function fillToCapacity() {
    const slots = Number(SPONSORSHIP_CAP_STROOPS / SPONSORSHIP_PER_ACCOUNT_STROOPS);
    for (let i = 0; i < slots; i += 1) {
      await reserveCapacity(account(i), INVITER);
    }
    return slots;
  }

  it("refuses a sponsorship once the cap has no room", async () => {
    // Invariant 2: total exposure is bounded, not merely per-account.
    const slots = await fillToCapacity();

    const overflow = await reserveCapacity(account(slots + 1), INVITER);

    expect(overflow).toBeNull();
  });

  it("reports exhaustion rather than silently overspending", async () => {
    await fillToCapacity();

    const capacity = await getCapacity();

    expect(capacity.exhausted).toBe(true);
    expect(capacity.availableStroops).toBeLessThan(SPONSORSHIP_PER_ACCOUNT_STROOPS);
  });

  it("never commits beyond the cap", async () => {
    const slots = await fillToCapacity();
    for (let i = 0; i < 10; i += 1) {
      await reserveCapacity(account(slots + i + 1), INVITER);
    }

    expect((await getCapacity()).committedStroops).toBeLessThanOrEqual(
      SPONSORSHIP_CAP_STROOPS,
    );
  });

  it("frees headroom when a sponsorship is revoked", async () => {
    const slots = await fillToCapacity();
    expect((await getCapacity()).exhausted).toBe(true);

    await markRevoked(account(0));

    expect((await getCapacity()).exhausted).toBe(false);
    expect(await reserveCapacity(account(slots + 1), INVITER)).not.toBeNull();
  });
});

describe("failed reservations", () => {
  it("releases capacity when the transaction never landed", async () => {
    // The reservation is pessimistic; without cleanup the cap slowly fills
    // with sponsorships that were never created.
    await reserveCapacity(account(1), INVITER);
    expect((await getCapacity()).committedStroops).toBe(SPONSORSHIP_PER_ACCOUNT_STROOPS);

    await releaseFailedReservation(account(1));

    expect((await getCapacity()).committedStroops).toBe(0n);
  });
});

describe("reclamation", () => {
  const now = 1_700_000_000_000;

  it("does not offer active sponsorships for reclamation", async () => {
    await reserveCapacity(account(1), INVITER, now);

    expect(await listReclaimable(now + 1_000)).toHaveLength(0);
  });

  it("offers sponsorships idle past the window", async () => {
    await reserveCapacity(account(1), INVITER, now);

    const later = now + SPONSORSHIP_IDLE_RECLAIM_MS + 1;

    expect(await listReclaimable(later)).toHaveLength(1);
    expect((await getCapacity(later)).reclaimableCount).toBe(1);
  });

  it("activity defers reclamation", async () => {
    // A user who is still using the app must not have their account released
    // out from under them.
    await reserveCapacity(account(1), INVITER, now);
    const later = now + SPONSORSHIP_IDLE_RECLAIM_MS + 1;

    await touchActivity(account(1), later);

    expect(await listReclaimable(later + 1_000)).toHaveLength(0);
  });
});

describe("revocation record", () => {
  it("marks the sponsorship revoked without deleting its history", async () => {
    await reserveCapacity(account(1), INVITER);
    await markRevoked(account(1));

    const record = await getSponsorship(account(1));

    expect(record?.status).toBe("revoked");
    expect(record?.revokedAt).not.toBeNull();
  });
});
