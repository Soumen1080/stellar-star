# StellarStar GitHub Issues Backlog

This document contains 40 production-ready GitHub issues identified across the StellarStar codebase, categorized by area (Security, Bug, Performance, Feature, Accessibility, Architecture). Each issue includes a clear title, problem description, affected files, impact analysis, and recommended fix.

---

## 1. [Bug] `/api/invitations` routes crash in Node.js runtime by invoking client-only `requireAuthenticatedClient`

### Description
The server-side invitation API routes fail with a 500 error when handling requests because they invoke invitation helpers without passing a server Supabase client.

In `app/api/invitations/create/route.ts`, `app/api/invitations/claim/route.ts`, and `app/api/invitations/revoke/route.ts`, the endpoints verify the user's wallet session from the `Authorization: Bearer <token>` header, but then call `createTripInvite(...)`, `claimTripInvite(...)`, or `revokeTripInvite(...)` without supplying a `client` parameter:

```ts
// app/api/invitations/claim/route.ts
const result = await claimTripInvite(
  body.token,
  session.wallet_address,
  body.selectedMemberId,
);
```

In `lib/invitations/claim.ts`, the functions fall back to:
```ts
const db = client ?? requireAuthenticatedClient();
```

`requireAuthenticatedClient()` (from `lib/supabase/client.ts`) accesses `getAccessToken()`, which inspects `window.localStorage`. Because these API routes execute in the Node.js runtime (`export const runtime = "nodejs"`), `window` is `undefined`, causing `getAccessToken()` to return `null` and `requireAuthenticatedClient()` to throw:
`"Your session has expired. Please sign in with your wallet again."`

### Affected Files
- `app/api/invitations/create/route.ts`
- `app/api/invitations/claim/route.ts`
- `app/api/invitations/revoke/route.ts`
- `lib/invitations/claim.ts`

### Recommended Fix
Pass an authenticated server Supabase client created with the verified session token into each helper function:
```ts
const serverClient = createServerClientForToken(token);
const result = await claimTripInvite(
  body.token,
  session.wallet_address,
  body.selectedMemberId,
  serverClient,
);
```

---

## 2. [Security] Unauthenticated invitation link verification is blocked by Postgres RLS on `trip_invites` and `trips`

### Description
Prospective members who receive an invite link (e.g. `/join/[token]`) cannot verify or preview the invitation because queries are executed under the anonymous role and blocked by PostgreSQL Row-Level Security (RLS).

In `app/api/invitations/verify/route.ts`, the route calls `verifyTripInvite(token)`:
```ts
// lib/invitations/claim.ts
export async function verifyTripInvite(token: string, client?: StellarStarClient) {
  const db = client ?? requireSupabaseClient();
  const { data: inviteData } = await db.from("trip_invites").select("*").eq("token_hash", tokenHash).maybeSingle();
  ...
  const { data: tripData } = await db.from("trips").select("id, name, description, members").eq("id", inviteData.trip_id).single();
}
```

However, in `supabase-setup.sql`:
1. The `trip_invites` table RLS policy `trip_invites_select_members` allows `SELECT` only if:
   ```sql
   trip_id IN (SELECT id FROM public.trips WHERE member_wallets @> ARRAY[public.current_wallet()])
   ```
2. The `trips` table RLS policy `trips_select_members` similarly requires `member_wallets @> ARRAY[public.current_wallet()]`.

An unauthenticated visitor visiting the invite URL is not logged in, so `public.current_wallet()` is `null`. Even if logged in, they are not yet a member of the trip. Consequently, RLS blocks both queries and `verifyTripInvite` always throws `"Invalid or unrecognized invitation link."` (404).

### Affected Files
- `app/api/invitations/verify/route.ts`
- `lib/invitations/claim.ts`
- `supabase-setup.sql`

### Recommended Fix
Implement a dedicated Postgres RPC function (`public.verify_trip_invite(p_token_hash text)`) marked `SECURITY DEFINER` that validates the token hash and returns only non-sensitive public metadata (`trip_id`, `trip_name`, `unclaimed_members`), or use `createServiceRoleClient()` strictly within `verifyTripInvite` to look up the invite record by token hash.

---

## 3. [Bug] Stale closure in `useExpenseForm` due to missing `currency` and `toastInfo` in `useCallback` dependency array

### Description
In `hooks/useExpenseForm.ts`, the `handleSubmit` callback omits `currency` and `toastInfo` from its `useCallback` dependency array.

When a user opens the expense creation form, switches the currency dropdown (for example, from `USD` to `XLM` or `INR`), and submits the form, `handleSubmit` references the initial/stale `currency` value captured when the hook was mounted. As a result, the created expense is saved with the wrong currency.

### Affected Files
- `hooks/useExpenseForm.ts`

### Recommended Fix
Include `currency` and `toastInfo` in the `useCallback` dependency array for `handleSubmit` in `hooks/useExpenseForm.ts`:
```ts
    [
      addExpense,
      currency,
      description,
      members,
      onSuccess,
      paidByMemberId,
      splitMode,
      title,
      toastError,
      toastInfo,
      toastSuccess,
      totalAmount,
      validate,
    ],
```

---

## 4. [Bug] Stale locale formatting in `usePayment` and `useNetPayment` hooks

### Description
In both `hooks/usePayment.ts` and `hooks/useNetPayment.ts`, the `depositToPool` function formats user notifications using the active user `locale`:
```ts
const { formatted } = formatMoney(amountXlm, "XLM", locale);
toastSuccess("Deposit successful", `Deposited ${formatted} into pool.`);
```
However, `locale` is omitted from the dependency array of `depositToPool`:
```ts
[publicKey, loadPoolBalance, toastError, toastSuccess]
```
If the user switches their preferred locale or language, `depositToPool` remains bound to the stale locale.

### Affected Files
- `hooks/usePayment.ts`
- `hooks/useNetPayment.ts`

### Recommended Fix
Add `locale` to the dependency array of `depositToPool` in both `hooks/usePayment.ts` and `hooks/useNetPayment.ts`.

---

## 5. [Bug] `InviteMemberModal` selection desynchronization with `unclaimedMembers`

### Description
In `components/trips/InviteMemberModal.tsx`, `useEffect` resets state and selects the first unclaimed member:
```ts
const unclaimedMembers = (trip.members || []).filter(
  (m) => !m.walletAddress || m.walletAddress.trim() === "",
);

useEffect(() => {
  if (isOpen) {
    setGeneratedUrl("");
    setCopied(false);
    setShowQR(false);
    if (unclaimedMembers.length > 0) {
      setSelectedMemberId(unclaimedMembers[0].id);
    } else {
      setSelectedMemberId("");
    }
  }
}, [isOpen, trip.members]);
```

The dependency array specifies `trip.members` instead of `unclaimedMembers`. If another member claims a slot in real time via Supabase Realtime while the modal is open, or if members are modified without altering the array reference, `selectedMemberId` points to a member that is already claimed or invalid.

### Affected Files
- `components/trips/InviteMemberModal.tsx`

### Recommended Fix
Include `unclaimedMembers` in the `useEffect` dependencies, or memoize `unclaimedMembers` with `useMemo` based on `trip.members` and include it in the hook dependency array.

---

## 6. [Security] Unbounded public `/api/error-report` endpoint vulnerable to log injection and webhook abuse

### Description
The error reporting sink at `app/api/error-report/route.ts` is an unauthenticated POST route intended to ingest client money-path failures.

However:
1. It has no rate limiting (neither per-IP nor per-wallet).
2. It has no request body size limit, allowing arbitrarily large payloads.
3. If `process.env.ERROR_REPORTING_WEBHOOK` is configured, it forwards incoming payloads with an unbounded `fetch()` call lacking an `AbortSignal.timeout(...)`.

A malicious client could spam this endpoint to flood server stdout logs, trigger memory exhaustion, or abuse upstream incident webhooks (e.g. Discord or Slack).

### Affected Files
- `app/api/error-report/route.ts`

### Recommended Fix
1. Add IP rate limiting using `checkRateLimit` (e.g., max 10 reports per minute per IP).
2. Enforce max character lengths on incoming `message`, `stack`, and `context`.
3. Add a timeout to the webhook fetch call using `AbortSignal.timeout(5000)`.

---

## 7. [Performance] `/api/fx/rate` lacks currency whitelist and rate limiting, allowing cache-busting DoS on FX providers

### Description
In `app/api/fx/rate/route.ts`, query parameters `from` and `to` are validated using a generic regular expression:
```ts
function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z]{2,6}$/.test(code);
}
```

There is no whitelist of supported fiat or crypto currencies (e.g., `USD`, `EUR`, `GBP`, `XLM`, `USDC`, `INR`), and no rate limiting per client IP. An attacker or malfunctioning client making repeated requests with random permutations (e.g. `?from=AAAA&to=BBBB`) will miss the in-memory cache every time. This forces `RateService` to make upstream requests to CoinGecko and ExchangeRate-API, rapidly depleting upstream API quotas and tripping circuit breakers for all users.

### Affected Files
- `app/api/fx/rate/route.ts`
- `lib/fx/rateService.ts`

### Recommended Fix
1. Define a strict whitelist of supported currency codes (`SUPPORTED_CURRENCIES`).
2. Add rate limiting (e.g. 60 requests per minute per IP) using `checkRateLimit`.
3. Reject unsupported currencies with HTTP 400 before querying upstream providers.

---

## 8. [Bug] `lib/stellar/contract.ts` `loadAccount` throws `ReferenceError: fetch is not defined` in Node/Jest environments

### Description
In `lib/stellar/contract.ts`, the `loadAccount` helper calls global `fetch` directly with custom cache headers:
```ts
async function loadAccount(publicKey: string, fallbackSequence?: string): Promise<Account> {
  const res = await fetch(
    `${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
  );
  ...
}
```

When invoked inside Node.js test environments or server contexts that do not polyfill global `fetch` on older Node versions or custom Jest jsdom runners, tests throw:
`ReferenceError: fetch is not defined at loadAccount (lib/stellar/contract.ts:116:15)`

In addition, direct fetch bypasses the retry and timeout logic provided by the Stellar SDK `Server` instance.

### Affected Files
- `lib/stellar/contract.ts`

### Recommended Fix
Use the initialized `server.loadAccount(publicKey)` from `lib/stellar/client.ts` or wrap `fetch` with an environment-safe check and proper error handling.

---

## 9. [Bug] Multi-operation transaction failures display misleading generic error in `submitSignedTransaction`

### Description
In `lib/stellar/submitTransaction.ts`, error handling parses Horizon error responses by checking only the first operation:
```ts
if (extras?.result_codes) {
  const { transaction, operations } = extras.result_codes;
  const opCode = operations?.[0];
  if (opCode && opCode !== "op_success") throw new Error(friendlyOpError(opCode));
  if (transaction === "tx_bad_seq") throw new Error("Transaction sequence mismatch. Please try again.");
  if (transaction === "tx_insufficient_fee") throw new Error("Transaction fee too low. Please try again.");
  if (transaction !== "tx_success") throw new Error(`Transaction failed: ${transaction}`);
}
```

If a transaction contains multiple operations (for instance, a fee payment or trustline setup followed by a payment) and operation 0 succeeds while operation 1 fails, `opCode` is `"op_success"`. The check passes, and the function falls through to throw:
`Transaction failed: tx_failed`
The user is left with a generic error instead of learning that operation 1 failed (e.g. `op_underfunded` or `op_no_destination`).

### Affected Files
- `lib/stellar/submitTransaction.ts`

### Recommended Fix
Find the first non-successful operation code in `operations`:
```ts
const failedOp = operations?.find((op) => op !== "op_success");
if (failedOp) throw new Error(friendlyOpError(failedOp));
```

---

## 10. [Refactor] Client bundle imports Node.js `crypto` module via `lib/invitations/tokens.ts` re-export

### Description
`lib/invitations/tokens.ts` imports Node's built-in `crypto` module:
```ts
import crypto from "crypto";
```
This file is re-exported by `lib/supabase/queries.ts`:
```ts
export { generateInviteToken, hashToken, buildInviteUrl } from "@/lib/invitations/tokens";
```

Because `queries.ts` is imported widely across client React components and contexts (`TripContext`, `AuthContext`), Node's `crypto` module is dragged into the client Webpack bundle, causing build warnings and potential browser runtime incompatibilities.

### Affected Files
- `lib/invitations/tokens.ts`
- `lib/supabase/queries.ts`

### Recommended Fix
Separate browser-safe token generation (using `window.crypto.getRandomValues` and Web Crypto `crypto.subtle.digest`) from server-only token hashing, or avoid re-exporting `tokens.ts` from client-facing `queries.ts`.

---

## 11. [Feature] Implement silent session renewal / refresh token mechanism for wallet sessions

### Description
Wallet JWT session tokens issued by `/api/auth/verify` have a fixed lifetime of 24 hours (`SESSION_TTL_SECONDS = 24 * 60 * 60`).

In `lib/supabase/session.ts`, when `exp` passes:
```ts
if (current && isExpired(current.claims)) {
  clearSession();
  return null;
}
```
Any subsequent request fails immediately with `"Your session has expired. Please sign in with your wallet again."`. There is no silent renewal endpoint, sliding window, or refresh mechanism. If a user is in the middle of splitting a trip or executing a transaction after 24 hours, their session is abruptly terminated without an opportunity to seamlessly re-authenticate.

### Affected Files
- `lib/supabase/serverAuth.ts`
- `lib/supabase/session.ts`
- `context/AuthContext.tsx`

### Recommended Fix
Add a session refresh endpoint (`POST /api/auth/refresh`) that validates an unexpired session token and issues an extended session token if requested within an expiry skew window (e.g. within 1 hour of expiration).

---

## 12. [Bug] Potential over-allocation race condition in in-memory `attestationLedger`

### Description
When running locally or on deployments without Supabase service credentials, `lib/settlement/attestationLedger.ts` uses an in-memory `Map` (`memoryLedger`).

The check for remaining capacity and the commit are separated into two functions:
1. `inspectAllocation(txHash, expenseId, member)`
2. `commitAttestation(entry)`

In `app/api/settlement/attest/route.ts`:
```ts
const allocation = await inspectAllocation(normalisedTxHash, expenseId, member);
const remaining = payment.amountStroops - allocation.allocatedStroops;
if (claimedAmount > remaining) return jsonError(...);
...
await commitAttestation(...);
```

Two concurrent requests for two different expenses against the same payment transaction can both run `inspectAllocation` before either has called `commitAttestation`. Both requests see the full transaction amount available and succeed, causing total attested claims to exceed the underlying transaction amount.

### Affected Files
- `lib/settlement/attestationLedger.ts`
- `app/api/settlement/attest/route.ts`

### Recommended Fix
Implement an atomic `allocateAndCommit` method or a mutex/lock around memory ledger allocations so that verification and commitment happen atomically.

---

## 13. [Performance] Excessive component re-rendering triggered by unstable `updateExpense` in `ExpenseContext`

### Description
In `context/ExpenseContext.tsx`, `updateExpense` is defined as:
```ts
const updateExpense = useCallback(
  async (id: string, updates: Partial<Expense>) => {
    const baseExpense = expenses.find((e) => e.id === id);
    const saved = await updateExpenseRow(id, updates, baseExpense);
    mutate((previous) => previous.map((e) => (e.id === id ? saved : e)));
  },
  [expenses, mutate]
);
```

Because `expenses` is included in the dependency array, `updateExpense` creates a new function reference every time any expense in the collection is added, updated, or removed. This cascades into `useMemo` for `ExpenseContextType`, causing all consuming components (e.g. `ExpenseList`, `ExpenseRow`, `TripDetailHeader`) to re-render needlessly.

### Affected Files
- `context/ExpenseContext.tsx`

### Recommended Fix
Use a functional state lookup or an `expensesRef` to locate `baseExpense` inside `updateExpense`, removing `expenses` from the dependency array.

---

## 14. [Feature] Expand SEP-0007 QR payment generator to support non-native assets and validate destination

### Description
In `lib/qr/generator.ts`, `buildQRPaymentURI` currently assumes all payments are native XLM:
```ts
export function buildQRPaymentURI({ destination, amount, memo }: QRPaymentData): string {
  const params = new URLSearchParams({
    destination,
    amount,
  });
  if (memo) {
    const finalMemo = trimToMemoBytes(memo, 28);
    params.set("memo", finalMemo);
    params.set("memo_type", "MEMO_TEXT");
  }
  return `web+stellar:pay?${params.toString()}`;
}
```

1. `destination` is not validated as a valid Stellar public key (`StrKey.isValidEd25519PublicKey`), allowing malformed QR codes.
2. The SEP-0007 standard supports non-native assets via `asset_code` and `asset_issuer` query parameters. The current implementation cannot generate QR codes for USDC or other anchored settlement tokens.

### Affected Files
- `lib/qr/generator.ts`

### Recommended Fix
1. Validate `destination` using `StrKey.isValidEd25519PublicKey(destination)`.
2. Add optional `assetCode` and `assetIssuer` properties to `QRPaymentData` and append `asset_code` and `asset_issuer` to query parameters when present.

---

## 15. [UX] Background settlement reconciliation prompts unexpected wallet signature dialogs

### Description
When `reconcilePendingIntentsForWallet` runs on page load to detect unconfirmed payments, it calls `reconcileSettlementIntent`:
```ts
// lib/settlement/reconcile.ts
if (CONTRACT_ID && !onChain && intent.tripId) {
  const contractRes = await recordPaymentOnChain({ ... });
}
```

`recordPaymentOnChain` prompts Freighter/wallet extension to sign a Soroban contract transaction via `signXDR`. If a user previously paid on Horizon but closed their browser before the Soroban write, reloading the page triggers an unsolicited Freighter wallet popup with no explanatory context in the UI.

### Affected Files
- `lib/settlement/reconcile.ts`
- `hooks/usePayment.ts`

### Recommended Fix
Reconciliation should differentiate between read-only status checks and active transaction submissions. If a transaction requires user signing, flag the intent as `NEEDS_ON_CHAIN_SIGNATURE` and show a "Complete On-Chain Record" banner in the UI rather than automatically opening the wallet extension.

---

## 16. [Security] Address critical and high-severity npm audit vulnerabilities in project dependencies

### Description
Running `npm audit` reveals 15 vulnerabilities (1 critical, 11 high, 1 moderate, 2 low):
- **Next.js** (<= 15.5.15): Multiple high and critical vulnerabilities regarding App Router SSRF, cache poisoning, and denial of service via connection exhaustion (GHSA-8h8q-6873-q5fj, GHSA-26hh-7cqf-hhc6, GHSA-3g8h-86w9-wvmq).
- **PostCSS** (<= 8.5.22): Arbitrary file read and XSS via unescaped output (GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q).
- **toml**: Uncontrolled recursion and prototype pollution (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j).
- **ws**: Memory exhaustion DoS and uninitialized memory disclosure (GHSA-96hv-2xvq-fx4p).

### Affected Files
- `package.json`
- `package-lock.json`

### Recommended Fix
Upgrade `next`, `postcss`, and relevant devDependencies to patched versions, and execute `npm audit fix`.

---

## 17. [Database] Schema discrepancies between `supabase-setup.sql` and `migrations/` files

### Description
There is schema drift between `supabase-setup.sql` (the one-shot setup script) and `migrations/0003_reconcile_drifted_schema.sql`.

Specifically:
- Parameter names and defaults in `claim_trip_invite` and `record_auth_challenge`.
- RLS policy naming and trigger definitions on `trip_invites`.

A developer setting up a new local Supabase database using `supabase-setup.sql` ends up with a database state that triggers warnings when running `npm run db:status` or `npm run db:migrate`.

### Affected Files
- `supabase-setup.sql`
- `migrations/0003_reconcile_drifted_schema.sql`
- `scripts/migrate.mjs`

### Recommended Fix
Align `supabase-setup.sql` with the latest migration files and verify that `npm run db:status` reports a clean synchronization status.

---

## 18. [A11y] Add focus trap and ARIA accessibility attributes to modals and interactive dialogs

### Description
Modal dialogs across the application (e.g. `components/trips/InviteMemberModal.tsx`) do not meet WCAG 2.1 Level AA accessibility standards:
1. Missing `aria-modal="true"` and `role="dialog"`.
2. Missing `aria-labelledby` linking to the modal title.
3. No focus trapping (`Tab` cycles through elements outside the modal behind the overlay).
4. No listener for the `Escape` key to close the modal.

### Affected Files
- `components/trips/InviteMemberModal.tsx`
- `components/trips/` (modals)
- `components/expenses/` (modals)

### Recommended Fix
Refactor custom modal implementations to use `@radix-ui/react-dialog` (which is already installed in `package.json`) to gain built-in focus trapping, screen-reader ARIA labeling, and keyboard navigation.

---

## 19. [UI/UX] Mobile viewport layout overflow on 56-character Stellar public keys and tables

### Description
On small viewports (< 640px), tables and summary lists (such as `components/dashboard/RecentExpenseRow.tsx` and `components/trips/SettlementSummary.tsx`) display full 56-character Stellar public addresses (`G...`).

This causes:
- Horizontal scrolling on mobile screens.
- Misaligned flex rows and broken grid layouts.
- Inconsistent address truncation across different screens.

### Affected Files
- `components/dashboard/RecentExpenseRow.tsx`
- `components/trips/SettlementSummary.tsx`
- `components/trips/TripCard.tsx`

### Recommended Fix
Create a reusable `<WalletAddressBadge address={...} truncateLength={4} copyable />` component that standardizes address presentation (e.g. `GBBD...4MNO`) with a 1-tap copy button and tooltip.

---

## 20. [Observability] Add distributed correlation IDs (`x-request-id`) across client, API routes, and Horizon calls

### Description
Currently, when a money-path operation fails (such as an attestation failure at `/api/settlement/attest` or Horizon transaction submission error), logs are captured independently in browser `console.error`, server logs via `/api/error-report`, and Horizon error codes.

There is no unifying trace identifier or correlation ID (`x-request-id`) generated on the client and propagated through API request headers, error reports, and database intent records. Diagnosing production issues requires manual timestamp correlation.

### Affected Files
- `lib/observability/reportError.ts`
- `lib/settlement/intent.ts`
- `app/api/settlement/attest/route.ts`
- `app/api/error-report/route.ts`

### Recommended Fix
Generate an `X-Request-Id` UUID on each settlement interaction. Propagate this header through API route calls, attach it to `SettlementIntentRow` and `reportError` payloads, and include it in structured server log output.
