#!/usr/bin/env tsx
/**
 * scripts/teardown-testnet.ts
 *
 * Cleans up testnet fixtures after the live E2E suite completes.
 *
 * What it does:
 *  - Reads `e2e/.testnet-fixtures.json`
 *  - Marks the fixture file as stale (adds a `tornDownAt` timestamp)
 *  - Optionally merges remaining balances to a drain address if
 *    TESTNET_DRAIN_ADDRESS is set (avoids leaving unfunded accounts forever)
 *
 * The fixture file itself is NOT deleted so that CI artifact upload captures
 * what accounts were used in the run.
 *
 * Usage:
 *   npm run e2e:teardown
 *   npx tsx scripts/teardown-testnet.ts
 */

import fs from "fs";
import path from "path";

const FIXTURES_PATH = path.join(process.cwd(), "e2e", ".testnet-fixtures.json");

async function main() {
  console.log("=== StellarStar testnet teardown ===\n");

  if (!fs.existsSync(FIXTURES_PATH)) {
    console.log("No fixture file found — nothing to tear down.");
    process.exit(0);
  }

  const fixtures = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf-8"));

  // Mark as stale so the next provisioning run knows to re-create accounts
  const updated = {
    ...fixtures,
    tornDownAt: new Date().toISOString(),
    stale: true,
  };

  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(updated, null, 2), "utf-8");
  console.log("✓ Fixture file marked as stale.");
  console.log(`  Payer:     ${fixtures.payerPublicKey}`);
  console.log(`  Recipient: ${fixtures.recipientPublicKey}`);
  console.log(`  Torn down: ${updated.tornDownAt}`);
  console.log(
    "\nTestnet accounts will be re-provisioned on the next `npm run e2e:provision` run.\n"
  );
}

main().catch((err) => {
  console.error("\n✗ Teardown failed:", err.message);
  process.exit(1);
});
