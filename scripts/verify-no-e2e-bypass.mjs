/**
 * Security gate: assert the E2E wallet bypass does NOT ship in a real
 * (flag-less) production build.
 *
 * It builds a clean production bundle with NEXT_PUBLIC_E2E_TEST_MODE UNSET and
 * then scans the emitted client/server chunks for the runtime-injected wallet
 * marker. If the marker is present, the seam survived dead-code elimination and
 * a UI-state impersonation primitive would ship to users — the process fails.
 *
 * The build uses STELLARSTAR_SECURITY_SCAN=1 only to skip the unrelated
 * type/lint pre-flight (the app has a pre-existing, out-of-scope type error in
 * lib/onboarding/abuseResistance.ts). That flag does NOT change the emitted
 * client code: it is still minified, NEXT_PUBLIC-inlined production output, so
 * the scan is representative of a real deployment artifact.
 *
 * Run directly:  node scripts/verify-no-e2e-bypass.mjs
 * Run in suite:  npm test  (see __tests__/security/no-e2e-bypass.test.ts)
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Substrings that must NEVER appear in a real production bundle. The injected
// object name is the load-bearing signal: it is the only thing the seam reads
// to impersonate a wallet. The legacy function name is a regression guard.
const FORBIDDEN = ["__E2E_WALLET__", "e2eTestWallet"];

function build() {
  const env = { ...process.env, STELLARSTAR_SECURITY_SCAN: "1" };
  // Critically: ensure the flag is absent so the seam is eliminated.
  delete env.NEXT_PUBLIC_E2E_TEST_MODE;
  env.NEXT_TELEMETRY_DISABLED = "1";

  const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
  const res = spawnSync(process.execPath, [nextBin, "build"], {
    cwd: root,
    env,
    stdio: "inherit",
    timeout: 1000 * 60 * 9,
  });
  return res.status ?? 1;
}

console.log("Building a clean production bundle (NEXT_PUBLIC_E2E_TEST_MODE unset)…");
if (build() !== 0) {
  console.error("Production build failed; cannot verify the bundle.");
  process.exit(1);
}

const targets = [
  join(root, ".next", "static"),
  join(root, ".next", "server"),
];

const hits = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(js|mjs|cjs|json)$/.test(p)) continue;
    let content;
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const marker of FORBIDDEN) {
      if (content.includes(marker)) hits.push({ file: p, marker });
    }
  }
}

for (const t of targets) walk(t);

if (hits.length > 0) {
  console.error(
    "\nFAIL: E2E wallet bypass is present in the production build:",
  );
  for (const h of hits) {
    console.error(`  - ${h.marker} found in ${h.file}`);
  }
  console.error(
    "\nThe seam must be gated behind NEXT_PUBLIC_E2E_TEST_MODE and removed by " +
      "the production minifier. Do not ship a build with the flag set.",
  );
  process.exit(1);
}

console.log(
  "\nPASS: no E2E wallet bypass (__E2E_WALLET__ / e2eTestWallet) present in " +
    "the production build.",
);
process.exit(0);
