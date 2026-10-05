/** @jest-environment jsdom */

import {
  invalidateQueryCaches,
  subscribeToQueryInvalidation,
  walletCollectionCacheKey,
} from "@/lib/supabase/cacheInvalidation";
import { cacheDomainsForMutation } from "@/lib/supabase/queries";

describe("wallet-scoped query cache invalidation", () => {
  const WALLET = "GAALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const OTHER_WALLET = "GBOBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    localStorage.clear();
  });

  it("notifies only matching wallet and domain subscribers", () => {
    const matching = jest.fn();
    const otherDomain = jest.fn();
    const otherWallet = jest.fn();
    const unsubscribe = [
      subscribeToQueryInvalidation(WALLET, "trips", matching),
      subscribeToQueryInvalidation(WALLET, "expenses", otherDomain),
      subscribeToQueryInvalidation(OTHER_WALLET, "trips", otherWallet),
    ];

    invalidateQueryCaches({
      wallet: WALLET,
      domains: ["trips"],
      tripId: "trip-1",
    });

    expect(matching).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet: WALLET,
        domains: ["trips"],
        tripId: "trip-1",
      }),
    );
    expect(otherDomain).not.toHaveBeenCalled();
    expect(otherWallet).not.toHaveBeenCalled();

    unsubscribe.forEach((stop) => stop());
  });

  it("routes each mutation to every dependent collection", () => {
    expect(cacheDomainsForMutation("trip_write")).toEqual(["trips"]);
    expect(cacheDomainsForMutation("trip_members_write")).toEqual(["trips", "expenses"]);
    expect(cacheDomainsForMutation("trip_expense_link")).toEqual(["trips", "expenses"]);
    expect(cacheDomainsForMutation("expense_write")).toEqual(["trips", "expenses"]);
  });

  it("uses the same wallet-scoped collection keys as persisted caches", () => {
    expect(walletCollectionCacheKey("trips", WALLET)).toBe(`StellarStar:trips:${WALLET}`);
    expect(walletCollectionCacheKey("expenses", WALLET)).toBe(`StellarStar:expenses:${WALLET}`);
  });
});
