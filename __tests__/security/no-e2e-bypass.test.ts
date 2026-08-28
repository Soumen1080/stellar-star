import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Security test: a real (flag-less) production build must NOT contain the E2E
 * wallet bypass. Delegates to scripts/verify-no-e2e-bypass.mjs, which performs a
 * clean production build and greps the emitted bundle for the injected-wallet
 * marker. This is the automated guard for the invariant "no production build
 * contains a code path that bypasses real wallet signing".
 */
test(
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
