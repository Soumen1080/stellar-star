/**
 * e2e/live-network.spec.ts
 *
 * Live-network Playwright tests that exercise real Stellar Testnet.
 *
 * These tests are in the `live` Playwright project and run on a nightly
 * schedule (not on every PR). They verify that:
 *
 *  1. Horizon testnet is reachable (infrastructure check)
 *  2. Provisioned accounts are funded and exist (fixture health check)
 *  3. A real XLM payment can be submitted to Horizon and confirmed
 *  4. A submitted transaction is retrievable and has correct fields
 *  5. A SEP-0007 QR URI round-trips correctly (all fields parse back out)
 *
 * IMPORTANT: All tests in this file are tagged with @live and are fully
 * independent — each test uses its own ephemeral accounts so no shared
 * mutable state exists between runs.
 *
 * Graceful degradation:
 *  - If TESTNET_PAYER_SECRET is not set and no fixture file exists, all
 *    tests are skipped with an informative message (CI does not fail).
 *  - If a TestnetResetError is detected, tests are skipped with a message
 *    pointing to docs/testnet-reset-recovery.md.
 *
 * @see docs/testnet-reset-recovery.md for recovery procedures.
 */

import { expect } from "@playwright/test";
import { test } from "./fixtures/network";
import { withRetry } from "./helpers";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { buildQRPaymentURI } from "@/lib/qr/generator";

const HORIZON = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
// Budget: 90s per test (configured in playwright.config.ts for the live project)

// ── 1. Horizon connectivity ────────────────────────────────────────────────────

test("Horizon testnet is reachable", async ({ horizonUrl }) => {
  const res = await withRetry(() =>
    fetch(`${horizonUrl}/`, { signal: AbortSignal.timeout(15_000) })
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  // Horizon root always has network_passphrase
  expect(typeof body.network_passphrase).toBe("string");
  expect(body.network_passphrase).toContain("Test SDF Network");
});

// ── 2. Account funding verification ───────────────────────────────────────────

test("payer account exists with positive XLM balance", async ({ payerKeypair, horizonUrl }) => {
  const res = await withRetry(() =>
    fetch(`${horizonUrl}/accounts/${payerKeypair.publicKey()}`, {
      signal: AbortSignal.timeout(15_000),
    })
  );
  expect(res.status).toBe(200);

  const account = await res.json();
  const xlmBalance = account.balances?.find(
    (b: { asset_type: string }) => b.asset_type === "native"
  );
  expect(xlmBalance).toBeDefined();
  expect(parseFloat(xlmBalance.balance)).toBeGreaterThan(0);
});

// ── 3. Real XLM payment submission to Horizon ─────────────────────────────────

test(
  "submits a real XLM payment to Horizon and gets SUCCESS",
  async ({ payerKeypair, recipientKeypair, horizonUrl }) => {
    // Each test run uses fresh ephemeral accounts (provisioned by fixtures).
    // Load the payer account to get sequence number.
    const accountRes = await withRetry(() =>
      fetch(`${horizonUrl}/accounts/${payerKeypair.publicKey()}`, {
        signal: AbortSignal.timeout(15_000),
      })
    );
    expect(accountRes.status).toBe(200);
    const accountData = await accountRes.json();

    // Build a minimal payment transaction: 1 XLM payer → recipient
    const fee = await withRetry(async () => {
      const r = await fetch(`${horizonUrl}/fee_stats`, { signal: AbortSignal.timeout(10_000) });
      const stats = await r.json();
      return String(Number(stats.fee_charged?.p50 ?? 100));
    });

    const tx = new TransactionBuilder(
      new Account(payerKeypair.publicKey(), accountData.sequence),
      {
        fee,
        networkPassphrase: PASSPHRASE,
      }
    )
      .addOperation(
        Operation.payment({
          destination: recipientKeypair.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(payerKeypair);
    const xdr = tx.toXDR();

    // Submit to Horizon with retry for transient 5xx
    const submitRes = await withRetry(async () => {
      const r = await fetch(`${horizonUrl}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(xdr)}`,
        signal: AbortSignal.timeout(30_000),
      });

      // 4xx means our transaction is bad (assertion failure, don't retry)
      if (r.status >= 400 && r.status < 500) {
        const body = await r.json().catch(() => ({}));
        const detail = body?.extras?.result_codes ?? JSON.stringify(body);
        throw new Error(`HTTP ${r.status} submitting transaction: ${JSON.stringify(detail)}`);
      }
      return r;
    });

    expect(submitRes.status).toBe(200);
    const result = await submitRes.json();
    expect(result.successful).toBe(true);
    expect(typeof result.hash).toBe("string");
    expect(result.hash.length).toBe(64);

    // Store hash on test info for traceability in CI artifacts
    console.log(`[live] Submitted transaction hash: ${result.hash}`);
    console.log(`[live] Stellar Expert: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
  }
);

// ── 4. Transaction retrievability ─────────────────────────────────────────────

test(
  "a submitted transaction is retrievable from Horizon with correct fields",
  async ({ payerKeypair, recipientKeypair, horizonUrl }) => {
    // Fund a fresh ephemeral pair for this test
    const ephemeralPayer = Keypair.random();
    const ephemeralRecipient = Keypair.random();

    // Fund via Friendbot
    await withRetry(async () => {
      const r = await fetch(`https://friendbot.stellar.org?addr=${ephemeralPayer.publicKey()}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok && r.status !== 400) throw new Error(`Friendbot HTTP ${r.status}`);
    });

    // Wait for account to appear
    let accountData: Record<string, string> | null = null;
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${horizonUrl}/accounts/${ephemeralPayer.publicKey()}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) { accountData = await r.json(); break; }
      await new Promise((res) => setTimeout(res, 2_000));
    }
    expect(accountData).not.toBeNull();

    const fee = "100";
    const tx = new TransactionBuilder(
      new Account(ephemeralPayer.publicKey(), (accountData as Record<string, string>).sequence),
      { fee, networkPassphrase: PASSPHRASE }
    )
      .addOperation(
        Operation.payment({
          destination: recipientKeypair.publicKey(),
          asset: Asset.native(),
          amount: "0.5",
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(ephemeralPayer);

    const submitRes = await withRetry(async () => {
      const r = await fetch(`${horizonUrl}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(tx.toXDR())}`,
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status >= 400 && r.status < 500) {
        const body = await r.json().catch(() => ({}));
        throw new Error(`HTTP ${r.status}: ${JSON.stringify(body?.extras?.result_codes)}`);
      }
      return r;
    });
    expect(submitRes.status).toBe(200);
    const submitted = await submitRes.json();
    expect(submitted.successful).toBe(true);

    const txHash: string = submitted.hash;

    // Now retrieve and verify
    const fetchRes = await withRetry(() =>
      fetch(`${horizonUrl}/transactions/${txHash}`, { signal: AbortSignal.timeout(15_000) })
    );
    expect(fetchRes.status).toBe(200);

    const fetched = await fetchRes.json();
    expect(fetched.hash).toBe(txHash);
    expect(fetched.successful).toBe(true);
    expect(fetched.source_account).toBe(ephemeralPayer.publicKey());
    expect(typeof fetched.ledger).toBe("number");
    expect(fetched.ledger).toBeGreaterThan(0);

    console.log(`[live] Verified tx ${txHash} on ledger ${fetched.ledger}`);
  }
);

// ── 5. SEP-0007 QR URI round-trip ─────────────────────────────────────────────

test(
  "SEP-0007 QR URI parses correctly and all required fields round-trip",
  async ({ recipientKeypair }) => {
    const amount = "25.5";
    const memo = "Trip split";

    // Generate SEP-0007 URI using the same helper the app uses
    const uri = buildQRPaymentURI({
      destination: recipientKeypair.publicKey(),
      amount,
      memo,
    });

    // Parse the URI and verify round-trip
    expect(uri).toMatch(/^web\+stellar:pay\?/);

    const queryStart = uri.indexOf("?");
    const params = new URLSearchParams(uri.slice(queryStart + 1));

    expect(params.get("destination")).toBe(recipientKeypair.publicKey());
    expect(params.get("amount")).toBe(amount);
    expect(params.get("memo")).toBe(memo);
    expect(params.get("memo_type")).toBe("MEMO_TEXT");

    // Destination must be a valid 56-char G... Stellar address
    const dest = params.get("destination") ?? "";
    expect(dest).toMatch(/^G[A-Z0-9]{55}$/);

    // Amount must be parseable as a positive float
    const parsedAmount = parseFloat(params.get("amount") ?? "");
    expect(parsedAmount).toBeGreaterThan(0);

    console.log(`[live] QR URI verified: ${uri.slice(0, 80)}…`);
  }
);
