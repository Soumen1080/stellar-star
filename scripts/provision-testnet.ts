#!/usr/bin/env tsx
/**
 * scripts/provision-testnet.ts
 *
 * Provisions two fresh Stellar testnet accounts (payer + recipient) and writes
 * their secrets to `e2e/.testnet-fixtures.json` (gitignored).
 *
 * Behaviour:
 *  - Idempotent: if the fixture file already exists and both accounts are live,
 *    it exits without re-provisioning.
 *  - Generates fresh Keypairs → funds via Friendbot → verifies account exists.
 *  - Retries Friendbot requests up to 5 times with exponential back-off to
 *    handle rate-limiting.
 *
 * Usage:
 *   npm run e2e:provision
 *   npx tsx scripts/provision-testnet.ts
 *
 * Required: Node >= 20 (native fetch), tsx
 */

import fs from "fs";
import path from "path";
import { Keypair } from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const FIXTURES_PATH = path.join(process.cwd(), "e2e", ".testnet-fixtures.json");

// ── Retry helper ───────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  maxAttempts = 5
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
      if (res.ok || res.status < 500) return res; // Don't retry 4xx — that's real
      lastErr = new Error(`HTTP ${res.status} from ${url}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxAttempts) {
      const delay = 1_000 * Math.pow(2, attempt - 1);
      console.warn(`  [retry ${attempt}/${maxAttempts}] ${String(lastErr)} — waiting ${delay}ms…`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Core ───────────────────────────────────────────────────────────────────────

async function isAccountLive(publicKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const acct = await res.json();
    return Number(acct.sequence) >= 0; // account exists (even new accounts have seq 0 briefly)
  } catch {
    return false;
  }
}

async function fundAccount(keypair: Keypair): Promise<void> {
  console.log(`  Funding ${keypair.publicKey()} via Friendbot…`);
  const res = await fetchWithRetry(`${FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 with "createAccountAlreadyExist" means the account already exists — that's fine
    if (res.status === 400 && body.includes("createAccountAlreadyExist")) {
      console.log(`  Account ${keypair.publicKey()} already exists — skipping Friendbot.`);
      return;
    }
    throw new Error(`Friendbot failed (HTTP ${res.status}): ${body}`);
  }
  console.log(`  ✓ Funded ${keypair.publicKey()}`);
}

async function waitForAccount(publicKey: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAccountLive(publicKey)) return;
    await sleep(2_000);
  }
  throw new Error(`Account ${publicKey} still not live after ${timeoutMs}ms`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== StellarStar testnet provisioning ===\n");

  // Check if existing fixtures are still valid
  if (fs.existsSync(FIXTURES_PATH)) {
    console.log("Found existing fixture file — checking if accounts are still live…");
    const existing = JSON.parse(fs.readFileSync(FIXTURES_PATH, "utf-8"));
    const payerKp = Keypair.fromSecret(existing.payerSecret);
    const recipKp = Keypair.fromSecret(existing.recipientSecret);
    const [payerLive, recipLive] = await Promise.all([
      isAccountLive(payerKp.publicKey()),
      isAccountLive(recipKp.publicKey()),
    ]);
    if (payerLive && recipLive) {
      console.log("✓ Both accounts are live. Nothing to do.\n");
      console.log(`  Payer:     ${payerKp.publicKey()}`);
      console.log(`  Recipient: ${recipKp.publicKey()}`);
      process.exit(0);
    }
    console.log("One or more accounts are stale — re-provisioning…\n");
  }

  // Generate fresh keypairs
  const payerKeypair = Keypair.random();
  const recipientKeypair = Keypair.random();

  console.log("Generated keypairs:");
  console.log(`  Payer:     ${payerKeypair.publicKey()}`);
  console.log(`  Recipient: ${recipientKeypair.publicKey()}\n`);

  // Fund both via Friendbot (sequential to avoid rate-limits)
  console.log("Funding via Friendbot:");
  await fundAccount(payerKeypair);
  // Small delay between Friendbot calls to avoid rate-limiting
  await sleep(2_000);
  await fundAccount(recipientKeypair);

  // Wait for accounts to appear on Horizon
  console.log("\nWaiting for accounts to appear on Horizon…");
  await Promise.all([
    waitForAccount(payerKeypair.publicKey()),
    waitForAccount(recipientKeypair.publicKey()),
  ]);
  console.log("✓ Both accounts confirmed on Horizon.\n");

  // Write fixture file
  const fixtures = {
    payerSecret: payerKeypair.secret(),
    recipientSecret: recipientKeypair.secret(),
    payerPublicKey: payerKeypair.publicKey(),
    recipientPublicKey: recipientKeypair.publicKey(),
    provisionedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(FIXTURES_PATH), { recursive: true });
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2), "utf-8");

  console.log(`✓ Fixture file written to: ${FIXTURES_PATH}`);
  console.log("\nRun `npm run test:e2e:live` to execute the live-network suite.\n");
}

main().catch((err) => {
  console.error("\n✗ Provisioning failed:", err.message);
  process.exit(1);
});
