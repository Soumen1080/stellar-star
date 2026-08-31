import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Security test: a real (flag-less) production build must NOT contain the E2E
 * wallet bypass. Delegates to scripts/verify-no-e2e-bypass.mjs, which performs a
 * clean production build and greps the emitted bundle for the injected-wallet
 * marker. This is the automated guard for the invariant "no production build
 * contains a code path that bypasses real wallet signing".
 *
 * Why this is opt-in rather than part of the default `npm test`:
 *   It performs a full production build (minutes, not milliseconds), which is
 *   the wrong shape for a unit suite developers run on every change. In CI the
 *   check runs unconditionally as its own job (`security-build-gate` in
 *   .github/workflows/ci.yml), so the gate is always enforced on every PR — it
 *   is simply enforced there instead of here.
 *
 * Run it locally with either:
 *   npm run test:security-build          (the script directly)
 *   RUN_SECURITY_BUILD=1 npm test        (through jest)
 */
const shouldRun =
  process.env.RUN_SECURITY_BUILD === "1" || process.env.CI_SECURITY_GATE === "1";

// eslint-disable-next-line jest/no-disabled-tests
(shouldRun ? test : test.skip)(
  "production build contains no E2E wallet bypass",
  () => {
    const script = join(
      __dirname,
      "..",
      "..",
      "scripts",
      "verify-no-e2e-bypass.mjs",
    );
    const out = execFileSync("node", [script], {
      encoding: "utf8",
      timeout: 1000 * 60 * 10,
    });
    expect(out).toMatch(/PASS/);
  },
  1000 * 60 * 10,
);
