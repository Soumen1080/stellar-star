/**
 * Test-only wallet seam for Playwright end-to-end runs.
 *
 * This module is the SINGLE source of truth for the E2E wallet bypass. The
 * guard below is written against `process.env.NEXT_PUBLIC_E2E_TEST_MODE`
 * directly (not a module-level const) so that Next.js inlines the literal at
 * build time and the production minifier can delete the unreachable branch —
 * including the `window.__E2E_WALLET__` reference — from the shipped bundle.
 * The result is verified by scripts/verify-no-e2e-bypass.mjs, which builds a
 * clean (flag-less) production bundle and asserts the injected-wallet string
 * is absent.
 *
 * Why a build-time flag and not a runtime `window.__E2E_WALLET__` check:
 *   A runtime-only check is reachable by ANY script on the page (an XSS
 *   payload, a malicious extension, a compromised dependency) and therefore
 *   ships a UI-state impersonation primitive to production. Gating on the
 *   inlined build flag means the seam simply does not exist in a real
 *   deployment; it only exists in builds created deliberately for testing.
 *
 * Running the E2E suite against a production-mode build:
 *   Build WITH the flag set:
 *     NEXT_PUBLIC_E2E_TEST_MODE=true next build && next start
 *   A bundle built this way is a TEST ARTIFACT and MUST NOT be deployed: in it,
 *   any script that sets `window.__E2E_WALLET__` can impersonate a wallet in
 *   the UI. The deploy pipeline must build without the flag.
 */
export interface E2EWallet {
  address: string;
  signXDR: (xdr: string) => Promise<string>;
}

/**
 * Returns the injected test wallet, or null when not in E2E test mode.
 *
 * The first guard is a literal comparison after Next inlines the env var, so
 * in a real (flag-less) build it compiles to `if (undefined !== "true") return
 * null;` and the remaining code — which reads `window.__E2E_WALLET__` — is
 * dead-code-eliminated. The injection itself is performed by the `mockWallet()`
 * helper in e2e/helpers.ts via `page.addInitScript`, which runs before any
 * application code on every navigation.
 */
export function getE2eTestWallet(): E2EWallet | null {
  if (process.env.NEXT_PUBLIC_E2E_TEST_MODE !== "true") return null;
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { __E2E_WALLET__?: E2EWallet }).__E2E_WALLET__ ?? null
  );
}
