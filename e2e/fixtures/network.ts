/**
 * e2e/fixtures/network.ts
 *
 * Playwright fixtures extension for live-network tests.
 *
 * Usage in a spec file:
 *   import { test, expect } from "../fixtures/network";
 *
 * Fixtures provided:
 *   - payerKeypair    : Keypair  — funded testnet account (payer)
 *   - recipientKeypair: Keypair  — funded testnet account (recipient)
 *   - horizonUrl      : string   — Horizon base URL for the testnet
 *
 * Graceful degradation:
 *   If the fixture file is absent (infrastructure not provisioned) or the
 *   required secret env var is unset, every live test is skipped with a clear
 *   message — the suite does NOT fail the build for infrastructure reasons.
 *
 * Testnet reset detection:
 *   If an account's sequence number is 0, the testnet was reset and the
 *   account no longer exists. This emits a TestnetResetError with an
 *   actionable message pointing to the recovery runbook.
 */

import { test as base, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import fs from "fs";
import path from "path";

// ── Constants ──────────────────────────────────────────────────────────────────

export const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const FIXTURES_PATH = path.join(__dirname, "..", ".testnet-fixtures.json");
const RECOVERY_RUNBOOK = "docs/testnet-reset-recovery.md";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TestnetFixtures {
  payerKeypair: Keypair;
  recipientKeypair: Keypair;
  horizonUrl: string;
}

/** Thrown when Horizon indicates an account no longer exists (testnet reset). */
export class TestnetResetError extends Error {
  constructor(publicKey: string) {
    super(
      `[TestnetResetError] Account ${publicKey} has sequence 0 or does not exist on testnet. ` +
        `The testnet was likely reset. Run \`npm run e2e:provision\` to re-provision fixtures, ` +
        `then trigger the live suite again. See ${RECOVERY_RUNBOOK} for full instructions.`
    );
    this.name = "TestnetResetError";
  }
}

/** Thrown when infrastructure is unavailable (network, Friendbot rate limit, etc). */
export class InfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`[InfrastructureError] ${message}`);
    this.name = "InfrastructureError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Load fixture file written by `scripts/provision-testnet.ts`.
 * Returns null when the file is absent (infrastructure not provisioned).
 */
function loadFixtureFile(): { payerSecret: string; recipientSecret: string } | null {
  if (!fs.existsSync(FIXTURES_PATH)) return null;
  try {
    const raw = fs.readFileSync(FIXTURES_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Verify that an account exists and has a non-zero sequence number on Horizon.
 * Throws TestnetResetError if the account is gone (testnet reset detected).
 * Throws InfrastructureError for connectivity issues.
 */
export async function assertAccountLive(publicKey: string): Promise<void> {
  const url = `${TESTNET_HORIZON_URL}/accounts/${publicKey}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new InfrastructureError(
      `Could not reach Horizon at ${TESTNET_HORIZON_URL}: ${String(err)}`,
      err
    );
  }

  if (res.status === 404) {
    throw new TestnetResetError(publicKey);
  }
  if (!res.ok) {
    throw new InfrastructureError(
      `Horizon returned HTTP ${res.status} for account ${publicKey}`
    );
  }

  const account = await res.json();
  const sequence = Number(account.sequence);
  if (sequence === 0) {
    throw new TestnetResetError(publicKey);
  }
}

// ── Fixture extension ──────────────────────────────────────────────────────────

export const test = base.extend<TestnetFixtures>({
  // eslint-disable-next-line no-empty-pattern
  payerKeypair: async ({}, use, testInfo) => {
    const file = loadFixtureFile();
    const envSecret = process.env.TESTNET_PAYER_SECRET;

    // Prefer env var (CI), fall back to fixture file (local dev)
    const secret = envSecret ?? file?.payerSecret;

    if (!secret) {
      testInfo.skip(
        true,
        "Live testnet fixture not provisioned. Run `npm run e2e:provision` or set TESTNET_PAYER_SECRET."
      );
      return;
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      testInfo.skip(true, "TESTNET_PAYER_SECRET is set but is not a valid Stellar secret key.");
      return;
    }

    // Verify account is live before test runs
    try {
      await assertAccountLive(keypair.publicKey());
    } catch (err) {
      if (err instanceof TestnetResetError) {
        // Mark as failed with a clear infrastructure annotation, not a test failure
        console.error(`\n::error::${err.message}\n`);
        testInfo.skip(true, err.message);
        return;
      }
      if (err instanceof InfrastructureError) {
        console.warn(`\n::warning::${err.message} — skipping live test.\n`);
        testInfo.skip(true, err.message);
        return;
      }
      throw err;
    }

    await use(keypair);
  },

  // eslint-disable-next-line no-empty-pattern
  recipientKeypair: async ({}, use, testInfo) => {
    const file = loadFixtureFile();
    const envSecret = process.env.TESTNET_RECIPIENT_SECRET;
    const secret = envSecret ?? file?.recipientSecret;

    if (!secret) {
      testInfo.skip(
        true,
        "Live testnet fixture not provisioned. Run `npm run e2e:provision` or set TESTNET_RECIPIENT_SECRET."
      );
      return;
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      testInfo.skip(true, "TESTNET_RECIPIENT_SECRET is not a valid Stellar secret key.");
      return;
    }

    await use(keypair);
  },

  // eslint-disable-next-line no-empty-pattern
  horizonUrl: async ({}, use) => {
    await use(TESTNET_HORIZON_URL);
  },
});

export { expect };
