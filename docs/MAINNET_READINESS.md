# Mainnet Readiness

This document is the operational gate for taking Stellar-star from "testnet demo"
to "handles real money". It is the deliverable for issue #60. Each checklist
item maps to one of the five invariants below, and the whole thing is backed by
code in `lib/utils/constants.ts`, `lib/stellar/fees.ts`,
`lib/observability/reportError.ts`, `context/WalletContext.tsx`, and the payment
hooks.

## Invariants

1. **Network configuration is internally consistent by construction, or the app
   refuses to start with a specific, actionable message.**
2. **A wallet on a different network than the app is detected and blocked from
   signing, with a clear explanation.**
3. **No user-facing string hardcodes a network name.**
4. **Fee strategy adapts to observed network conditions rather than a fixed
   constant.**
5. **A failed money-path operation produces a diagnosable record somewhere a
   maintainer will actually see it.**

## Checklist

### Configuration correctness (invariant 1)

- [ ] `NEXT_PUBLIC_STELLAR_NETWORK` is the single source of truth for which
      network the app targets. `NETWORK_PASSPHRASE`, `HORIZON_URL`,
      `SOROBAN_RPC_URL`, and `STELLAR_EXPLORER` are **derived** from it when their
      env var is unset (`lib/utils/constants.ts`). Do not hand-set all four.
- [ ] Any endpoint you *do* set explicitly must target the same network as
      `STELLAR_NETWORK`. `getNetworkConfigErrors()` classifies each URL by host
      and rejects cross-network or wrong-network overrides.
- [ ] `ConfigProvider` renders a full-screen diagnostic (not a blank crash) when
      `getNetworkConfigErrors()` is non-empty, naming the exact env var and the
      fix. Verify by temporarily setting `STELLAR_NETWORK=PUBLIC` with
      `NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org` and loading
      the app — you should see the block screen, never the dashboard.
- [ ] A startup script (CI / deploy) calls `assertValidNetworkConfig()` so a bad
      deploy fails loudly before traffic, not after a user loses funds.

### Wallet / app network mismatch (invariant 2)

- [ ] `WalletContext` exposes `appNetwork` and `networkMismatch`. `networkMismatch`
      is true whenever a connected wallet reports a network different from
      `appNetwork`.
- [ ] `WalletContext` re-reads the wallet's network on an interval, so a
      mid-session switch in Freighter is caught before the next signing.
- [ ] `usePayment.payShare` and `useNetPayment.payNetSettlement` **block** with a
      `blocked` state and an explanatory toast when `network !== STELLAR_NETWORK`,
      and never call `signXDR`.
- [ ] `NetworkMismatchBanner` shows a persistent, prominent explanation whenever
      a mismatch is active.

### No hardcoded network names (invariant 3)

- [ ] Every user-facing mention of a network goes through `NETWORK_LABEL`,
      `NETWORK_DISPLAY_NAME`, or `networkLabel(walletNetwork)`. Grep the repo for
      the literals `Testnet` / `Mainnet` and confirm none remain in
      user-visible copy (marketing fallback strings are acceptable only when
      derived from the above).
- [ ] `ReceiptModal` no longer claims "Stellar Testnet" — it uses
      `NETWORK_DISPLAY_NAME`, so a mainnet receipt is truthful.

### Adaptive fees (invariant 4)

- [ ] `buildPaymentTransaction` / `buildPathPaymentTransaction` set the
      transaction fee from `getSuggestedBaseFee()` (median accepted fee from
      Horizon `/fee_stats` plus the ledger base fee), not the old `TX_BASE_FEE`
      constant.
- [ ] `lib/stellar/contract.ts` uses the same adaptive fee for Soroban
      submissions, falling back to `SOROBAN_BASE_FEE` only when `/fee_stats` is
      unreachable.
- [ ] On a deliberately congested network, a payment still submits (no
      `tx_insufficient_fee`); verify in a load test or by mocking a high
      `p50_accepted_fee`.

### Observability of money-path failures (invariant 5)

- [ ] Every failure in the payment hooks (`payment.failed`,
      `payment.onchain-proof-failed`, `payment.blocked-network-mismatch`) and in
      `contract.ts` routes through `reportError`.
- [ ] `reportError` POSTs a structured payload to `/api/error-report`, which logs
      it server-side in a stable `[StellarStar:client-error]` shape. Confirm a
      test failure shows up in the server logs, not only the browser console.
- [ ] If `ERROR_REPORTING_WEBHOOK` is set, the same payload is forwarded so a
      mainnet failure produces an alert, not just a log line.
- [ ] A vendor (Sentry/Datadog/…) can be wired via `setErrorReporter` without
      touching any call site.

### Mainnet risk profile (beyond the code invariants)

- [ ] **Reserve requirements:** confirm the funding wallet holds the base
      reserve + per-entry reserves for every account it creates, denominated in
      *real* XLM. Testnet faucets are gone; underfunding is now a hard failure.
- [ ] **No faucet:** there is no way to recover test funds. Document the
      operational "oh no" runbook (how to flag, freeze, communicate) before
      launch.
- [ ] **Surge rehearsal:** run the adaptive-fee path against a congested network
      at least once.
- [ ] **Deploy workflow:** a reviewed, reproducible deploy (not `npm run build`
      on a laptop) with the config validation step above as a gate.
- [ ] **Alerting:** the error-report sink feeds an on-call channel.

## Design note

The temptation, when "mainnet support" is requested, is to flip a flag and ship.
That is exactly the failure mode here: `TX_BASE_FEE`, the testnet-default URLs,
and the silent wallet-network read were each individually harmless on testnet and
collectively catastrophic on mainnet — they fail by *signing the wrong thing*
rather than by throwing.

So the design principle is **make the unsafe state impossible to reach, and make
the merely-misconfigured state impossible to ignore**:

- **Derive what can be derived.** The network is one variable
  (`STELLAR_NETWORK`). Everything that depends on it is computed from it, so the
  default is always consistent. This removes the "set PUBLIC and forget one URL"
  footgun at the source.
- **Validate what cannot be derived.** Explicit overrides exist for operators
  with custom infrastructure, but they are classified by host and rejected when
  they point at the wrong network. The rejection is a startup screen with the
  exact env var and fix — not a runtime surprise at signing time.
- **Detect, don't assume.** The wallet's network is re-checked live, because a
  user can switch Freighter networks without the app noticing. Detection turns
  into a hard *block* at the money path plus a persistent banner — the user is
  stopped before they can sign, and told why.
- **Pay the network's price.** Fees are read from observed conditions, because
  the constant that's fine on a quiet testnet is the thing that gets rejected
  (and blamed on the user) under surge.
- **Errors must land somewhere.** `console.error` is where blame goes to die.
  Every money-path failure is structured and shipped to a server-side sink the
  maintainer controls, with a vendor seam for whatever monitoring stack they
  already run.

The vendor, the exact fee curve, and the block-vs-warn decision were all left
**unspecified on purpose**: the seam (derived config, validation, mismatch
block, adaptive fee, pluggable reporter) is what makes those choices safe to
change later without re-architecting.
