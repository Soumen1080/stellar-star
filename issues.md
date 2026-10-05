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

---

## 21. [Bug] `usePollBudget` interval continues after unmount, causing duplicate polling loops

### Description
`hooks/usePollBudget.ts` starts a polling interval for wallet or trip balances but does not always cancel it when the component unmounts or when the dependency set changes. In multi-tab or tab-switch scenarios, multiple intervals remain alive, each re-fetching budget state and causing duplicate network calls and stale UI values.

### Affected Files
- `hooks/usePollBudget.ts`
- `components/dashboard/` (budget consumers)

### Recommended Fix
Use a cleanup function that clears the polling timer inside `useEffect`, and guard against overlapping intervals with a cancellation flag or a single `AbortController` per refresh cycle.

---

## 22. [Bug] Inconsistent wallet address normalization lets duplicates slip into member lists

### Description
Member wallet addresses are compared using inconsistent casing and trimming logic. If one user joins with `GABC...` and another with `gabc...`, the system may treat them as distinct members even though Stellar addresses are case-insensitive in canonical form. This can create duplicate members, wrong settlement splits, and lookup failures in invite membership checks.

### Affected Files
- `lib/auth/session.ts`
- `lib/trip/members.ts`
- `components/trips/MemberList.tsx`

### Recommended Fix
Normalize addresses once at the boundary using `publicKey.trim().toUpperCase()` or a canonical Stellar helper before saving, comparing, or indexing member records.

---

## 23. [Performance] Trip and expense list endpoints read full tables without pagination or cursor limits

### Description
API routes that list trips, members, or expenses appear to fetch unbounded result sets without an explicit `limit`, `offset`, or cursor. Large datasets create slow response times, excessive memory use, and poor UX on dashboards with many records. This also amplifies downstream database cost because clients receive entire relation snapshots instead of pages.

### Affected Files
- `app/api/trips/route.ts`
- `app/api/expenses/route.ts`
- `lib/supabase/queries.ts`

### Recommended Fix
Add server-side pagination with `limit`, `cursor`, and a maximum page size; validate client input and return stable ordering by creation timestamp or ID.

---

## 24. [Security] User-controlled route parameters are reflected unsafely in page metadata and error messages

### Description
Some trip or share URLs are built from user-supplied data such as trip names, wallet addresses, or invite tokens and then interpolated into HTML or toast text without escaping. If a malicious trip name contains HTML markup or script-like content, a rendered page or toast can inject markup and produce a stored XSS condition in shared dashboards or error reporting flows.

### Affected Files
- `app/trips/[id]/page.tsx`
- `components/system/Toast.tsx`
- `lib/utils.ts`

### Recommended Fix
Escape all dynamic text before rendering in HTML and apply a safe content policy for server-rendered metadata, including sanitizing trip names and wallet labels before use in page metadata.

---

## 25. [Security] Missing authorization check in invite claim flow allows token replay across different trips

### Description
The invite claim flow verifies token existence but may not ensure that the `selectedMemberId` belongs to the same trip as the invite token or that the claiming wallet is eligible for exactly one invite claim. A malicious user could replay a valid invite token against a different trip or attempt multiple claims before the invite is invalidated, resulting in membership corruption and privilege escalation.

### Affected Files
- `lib/invitations/claim.ts`
- `app/api/invitations/claim/route.ts`
- `app/api/invitations/verify/route.ts`

### Recommended Fix
Perform a single transaction that validates the invite token, matches its trip ID to the selected member record, and enforces one-time claim semantics before updating trip membership.

---

## 26. [Bug] Duplicate settlement intents are created when the same payment is re-synced after a network retry

### Description
The settlement reconciliation flow can create multiple intent rows for the same underlying payment when the client retries the submission or the backend reprocesses a webhook event. Because deduplication is based only on a weak subset of fields, identical payments can appear multiple times in the settlement ledger and cause double-application of settlements.

### Affected Files
- `lib/settlement/intent.ts`
- `app/api/settlement/reconcile/route.ts`
- `hooks/usePayment.ts`

### Recommended Fix
Introduce a deterministic idempotency key such as `txHash + expenseId + memberId + assetCode` and enforce uniqueness at the database level with a unique index and an upsert path.

---

## 27. [Performance] Repeated transaction submissions do not use request deduplication or idempotency keys

### Description
`submitSignedTransaction` and related payment routes can be called multiple times for the same signed XDR. Without an idempotency key or deduplication cache, retries create duplicate transactions or double-accounting in settlement flows. This is especially harmful on flaky mobile connections or when users tap the submit button repeatedly.

### Affected Files
- `lib/stellar/submitTransaction.ts`
- `app/api/settlement/submit/route.ts`
- `hooks/usePayment.ts`

### Recommended Fix
Add a client-generated idempotency token and persist it in the settlement record so repeated requests with the same token are ignored or deduplicated instead of resubmitted.

---

## 28. [Bug] Expense updates can leave optimistic state stale after a failed mutation

### Description
`context/ExpenseContext.tsx` performs optimistic updates to local expense state, but if the server mutation fails, there is no rollback path. The UI continues to show updated local values while the backend keeps the original state, leading to inconsistent totals and confusion for users editing expenses across multiple tabs.

### Affected Files
- `context/ExpenseContext.tsx`
- `lib/expense/update.ts`
- `hooks/useExpenseForm.ts`

### Recommended Fix
Wrap optimistic mutations in a rollback mechanism that restores the previous state from a snapshot when the server call rejects, and surface the error in a user-visible toast.

---

## 29. [Bug] Amount validation accepts `NaN`, negative values, and zero-value edge cases

### Description
The expense and payment forms validate a subset of numeric values but do not consistently reject `NaN`, negative totals, or zero-amount edge cases where the business rule prohibits them. These invalid values propagate into settlement calculations and can corrupt trip balances or allow zero-value split entries.

### Affected Files
- `hooks/useExpenseForm.ts`
- `hooks/usePayment.ts`
- `lib/expense/validation.ts`

### Recommended Fix
Use a shared numeric validator that accepts only finite positive numbers greater than zero for settlement-critical forms and returns a clear user-facing error for invalid values.

---

## 30. [Performance] Contract event polling is unbounded and causes excessive CPU usage during idle periods

### Description
The app polls for contract events or transaction status updates on a fixed interval without backoff, deduplication, or pause logic when the trip is not active. Idle trip pages continue to burn CPU time and network bandwidth, especially when many users are open on the same dashboard or when event watchers are reinitialized frequently.

### Affected Files
- `hooks/useContractEvents.ts`
- `lib/stellar/contract.ts`
- `context/TripContext.tsx`

### Recommended Fix
Add exponential backoff for repeated retries, pause polling when the tab is hidden, and cancel stale polls before launching a new watcher for the same trip or account.

---

## 31. [Bug] `formatMoney` rounding differs across currencies and creates split mismatches

### Description
Currency formatting functions appear to round amounts at different precision thresholds depending on locale and asset code. A split that totals `100.00 USD` may display as `99.99 USD` in one component and `100.01 USD` in another, creating discrepancies between the amounts shown to users and the actual settlement ledger values.

### Affected Files
- `lib/utils.ts`
- `components/ui/AmountInput.tsx`
- `hooks/useExpenseForm.ts`

### Recommended Fix
Centralize currency precision logic so all components use the same rounding mode, display decimals, and settlement precision rules for each asset.

---

## 32. [Bug] Trustline setup race condition permits duplicate asset registration for the same wallet

### Description
When multiple pending transactions attempt to create or update a trustline for the same asset, there is a race between checking whether the trustline exists and creating it. This creates duplicate trustline attempts or conflicting state that is not handled cleanly when the wallet or Horizon responds with intermittent errors.

### Affected Files
- `hooks/useTrustline.ts`
- `lib/stellar/trustline.ts`
- `lib/settlement/intent.ts`

### Recommended Fix
Add a transaction-state guard and server-side idempotent trustline creation flow so repeated registration attempts for the same asset result in the same final state instead of conflicting writes.

---

## 33. [Security] API routes rely on bearer checks but do not verify wallet-origin or session binding

### Description
Protected routes validate a bearer token or wallet session but do not always confirm that the wallet address associated with the session matches the expected request origin or that the session is bound to a trusted client. This leaves room for token reuse across different browser sessions or malicious clients that obtain a leaked token.

### Affected Files
- `app/api/auth/verify/route.ts`
- `lib/supabase/serverAuth.ts`
- `lib/supabase/session.ts`

### Recommended Fix
Bind session tokens to device or wallet metadata when possible and verify the claim against the current request context before accepting privileged actions.

---

## 34. [Security] Error payloads and debug logs may leak wallet addresses, memo data, or settlement details

### Description
The application captures runtime errors and forwards them to log sinks, but some payload fields are not sanitized before logging. Wallet addresses, memo strings, raw transaction hashes, and settlement metadata may end up in public console output or incident reports, creating privacy and compliance risks.

### Affected Files
- `lib/observability/reportError.ts`
- `app/api/error-report/route.ts`
- `context/AuthContext.tsx`

### Recommended Fix
Redact or hash wallet addresses, strip memo text, and provide a structured log schema that excludes raw settlement details unless explicitly allowed in a secure environment.

---

## 35. [Bug] Realtime subscriptions leak when components unmount or route changes quickly

### Description
Supabase Realtime subscriptions are created in several contexts without a consistent unsubscribe path. On route transitions, modal close events, or rapid trip switching, subscribers remain active and continue to emit stale updates, causing duplicate renders and memory growth in the browser.

### Affected Files
- `context/TripContext.tsx`
- `context/ExpenseContext.tsx`
- `context/WalletContext.tsx`

### Recommended Fix
Track each subscription in a cleanup lifecycle, unsubscribe on unmount, and guard against duplicate subscription registration for the same trip or wallet.

---

## 36. [Bug] SSR hydration mismatch occurs when locale/timezone formatting differs between server and client

### Description
Some formatted amounts, dates, and wallet labels are rendered on the server using one locale and then on the client using another. This creates hydration mismatch warnings and can temporarily show stale or shifted values after the first user interaction, especially when the locale or timezone differs from the server environment.

### Affected Files
- `context/LocaleContext.tsx`
- `app/layout.tsx`
- `lib/utils.ts`

### Recommended Fix
Use a stable locale source for server and client rendering or defer locale-sensitive output until after hydration, and freeze timestamps when necessary to avoid mismatch warnings.

---

## 37. [Performance] Cache invalidation is incomplete after trip member or expense mutation

### Description
The app invalidates cache entries after some writes, but not all dependent records. For example, after a member is added to a trip or an expense is edited, stale list data remains in memory for a subset of views. Users may see inconsistent trip totals until a hard refresh or a full page reload occurs.

### Affected Files
- `context/TripContext.tsx`
- `context/ExpenseContext.tsx`
- `lib/supabase/queries.ts`

### Recommended Fix
Use a centralized cache invalidation strategy keyed by trip and wallet identity, and invalidate all dependent queries on write operations rather than only the direct record entry.

---

## 38. [Bug] Cross-asset settlement logic mixes display precision with contract precision

### Description
The app stores and displays amounts using a mix of human-readable decimals and stroops or integer units, but does not consistently convert when preparing settlement instructions. This creates rounding drift in multi-asset settlements and can cause slight mismatch errors when the final amounts are converted back into the ledger view.

### Affected Files
- `lib/settlement/settle.ts`
- `lib/fx/rateService.ts`
- `hooks/useNetPayment.ts`

### Recommended Fix
Introduce a single asset conversion layer with explicit precision rules for native XLM, USDC, and fiat values so all calculations use the same units before display or ledger submission.

---

## 39. [UX] Search and filter inputs update on every keystroke without debouncing

### Description
Search bars and filter fields are triggered on each keystroke, causing expensive list queries and unnecessary rerenders. On larger trip or expense lists, this can create noticeable lag, network thrash, and poor perceived performance especially on mobile devices.

### Affected Files
- `components/trips/TripSearch.tsx`
- `components/expenses/ExpenseFilters.tsx`
- `hooks/useTrip.ts`

### Recommended Fix
Debounce user input with a modest delay and only send queries after the user pauses typing, while keeping the immediate local filtering fallback for low-latency interactions.

---

## 40. [Database] Missing composite indexes on common trip and expense queries slow down dashboards

### Description
Common queries such as filtering expenses by `trip_id` and `created_at`, listing members by `trip_id` with status, or loading settlement intents by `wallet_address` and `status` are missing composite index coverage. This becomes extremely visible when trip membership grows and dashboards begin to time out or block on repeated queries.

### Affected Files
- `supabase-setup.sql`
- `migrations/`
- `lib/supabase/queries.ts`

### Recommended Fix
Add composite indexes for the most common query patterns and verify query plans with benchmark tests or database analyzer output before shipping to production.

---

