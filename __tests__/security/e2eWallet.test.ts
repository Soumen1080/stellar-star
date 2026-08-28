import { getE2eTestWallet } from "@/lib/stellar/e2eWallet";

/**
 * The seam must be inert unless the build was created with
 * NEXT_PUBLIC_E2E_TEST_MODE=true. In the unit test environment that flag is
 * never set, so getE2eTestWallet() must always return null — i.e. it must
 * never consult an attacker-injected window.__E2E_WALLET__.
 */
test("getE2eTestWallet returns null in a flag-less (production) environment", () => {
  expect(process.env.NEXT_PUBLIC_E2E_TEST_MODE).not.toBe("true");
  expect(getE2eTestWallet()).toBeNull();
});

test("getE2eTestWallet does not read window.__E2E_WALLET__ when the flag is unset", () => {
  const before = (globalThis as Record<string, unknown>).__E2E_WALLET__;
  (globalThis as Record<string, unknown>).__E2E_WALLET__ = {
    address: "GATTACKER",
    signXDR: async () => "SIGNED",
  };
  try {
    expect(getE2eTestWallet()).toBeNull();
  } finally {
    (globalThis as Record<string, unknown>).__E2E_WALLET__ = before;
  }
});
