# Open Source Contribution Issues

These issues are written for GitHub issue creation and start from issue count 2 as requested. They are based on the current Stellar-star platform codebase. Validation checked locally: TypeScript passes, Jest passes, lint passes, and production build passes.

## Issue #2: Repair corrupted Unicode text in documentation and UI copy

**Directory:** `README.md`, `docs/`, `app/`, `components/`, `scripts/`
**Repo Avatar** [Soumen1080/stellar-star](https://github.com/Soumen1080/stellar-star)
**Type:** Bug, documentation

**Description:** Several files contain mojibake/corrupted UTF-8 text where dashes, check marks, arrows, and ellipses render as broken character sequences. Some of this appears in README content, comments, button labels, placeholders, toast messages, and script output. This makes the project look broken on GitHub and can also leak into visible UI text.

**Expected outcome:** All documentation and user-facing text should render as clean English text with correct punctuation and symbols.

**Acceptance criteria:**
- README and docs render correctly on GitHub.
- App labels, placeholders, toasts, and payment status text no longer show corrupted characters.
- A contributor can run `npm.cmd test -- --runInBand` and `npm.cmd run build` successfully after the cleanup.

## Issue #3: Add the missing `.env.local.example` file

**Directory:** Project root, `README.md`, `docs/`

**Type:** Developer experience

**Description:** The README tells users to copy `.env.local.example` into `.env.local`, but the repository does not currently include `.env.local.example`. New contributors must manually infer required environment variables from README and docs, which slows setup and increases configuration mistakes.

**Expected outcome:** The repository should include a safe example environment file with placeholders for all required public variables.

**Acceptance criteria:**
- Add `.env.local.example` with Stellar, Soroban, Supabase, and app metadata keys.
- Ensure the file contains no real private credentials.
- Update README setup instructions if any variable names change.

## Issue #4: Add the missing Open Graph image referenced in metadata

**Directory:** `app/`, `public/`

**Type:** Bug, SEO

**Description:** `app/layout.tsx` references `/og-image.png` for Open Graph and Twitter previews, but the file is not present in `public/`. Shared links may show a broken preview image or fall back to generic metadata.

**Expected outcome:** Social previews should show a valid Stellar-star branded image.

**Acceptance criteria:**
- Add `public/og-image.png` at 1200x630.
- Confirm `app/layout.tsx` metadata points to the correct asset.
- Verify the production build still passes.

## Issue #5: Align project branding and live URLs across the repository

**Directory:** `README.md`, `docs/`, `app/`, `package.json`

**Type:** Documentation, product polish

**Description:** The repository uses multiple names and URLs: `Stellar-star`, `SettleX`, package name `settlex`, a README demo URL, a different deployment proof URL, and an old fallback URL in `app/layout.tsx`. This can confuse contributors, users, and reviewers about the canonical project identity and deployment.

**Expected outcome:** The project should use one canonical name and one canonical production/demo URL everywhere.

**Acceptance criteria:**
- Pick the canonical product name and demo URL.
- Update README, docs, metadata, package name if desired, and release checklist references.
- Ensure no old deployment URL remains unless it is intentionally documented as historical proof.

## Issue #6: Migrate away from deprecated `next lint`

**Directory:** `package.json`, `.github/workflows/`

**Type:** Maintenance

**Description:** `npm.cmd run lint` passes, but Next.js reports that `next lint` is deprecated and will be removed in Next.js 16. The current lint script and CI workflows depend on this deprecated command.

**Expected outcome:** Linting should use the ESLint CLI directly and remain compatible with future Next.js releases.

**Acceptance criteria:**
- Update the lint script to use ESLint CLI.
- Add or update ESLint config if needed.
- Update CI workflow commands.
- Confirm lint, test, typecheck, and build all pass.

## Issue #7: Make multi-wallet support real in the wallet connection flow

**Directory:** `context/`, `lib/stellar/`, `components/wallet/`

**Type:** Feature, wallet UX

**Description:** The platform advertises Freighter, xBull, and Lobstr support, and `lib/stellar/walletsKit.ts` contains multiple wallet adapters. However, `WalletContext` first checks `isFreighterInstalled()`, uses Freighter network helpers, and stores `FREIGHTER_ID` after connection. This can block or mislabel non-Freighter wallets.

**Expected outcome:** Users should be able to connect each supported wallet without being forced through Freighter-specific checks.

**Acceptance criteria:**
- Remove the Freighter-only install gate from the generic connect path.
- Store the actual selected wallet ID.
- Use wallet-specific address/signing/network behavior where supported.
- Add tests or manual QA notes for Freighter, xBull, and Lobstr paths.

## Issue #8: Block duplicate member wallet addresses during form submission

**Directory:** `components/expenses/`, `components/trips/`, `lib/split/`

**Type:** Bug, validation

**Description:** `ExpenseForm` shows an inline warning when two members use the same wallet address, but the `validate()` function does not block submission for duplicates. `TripForm` does not appear to enforce uniqueness either. Duplicate wallets can create confusing payer/member roles, hidden pay buttons, or invalid settlement logic.

**Expected outcome:** Each member in an expense or trip should have a unique Stellar wallet address.

**Acceptance criteria:**
- Add duplicate wallet validation in `ExpenseForm`.
- Add duplicate wallet validation in `TripForm`.
- Treat addresses case-insensitively after trimming.
- Add tests for duplicate wallet rejection.

## Issue #9: Replace regex-only Stellar address validation with SDK validation

**Directory:** `lib/split/`, `components/trips/`, `components/expenses/`

**Type:** Bug, validation

**Description:** Stellar address validation currently uses a regex that checks shape only. A string can match `G[A-Z2-7]{55}` and still fail StrKey checksum validation. Invalid but regex-shaped addresses may be accepted and then fail later during payment creation.

**Expected outcome:** Address validation should use canonical Stellar SDK validation.

**Acceptance criteria:**
- Use `StrKey.isValidEd25519PublicKey` or the current SDK equivalent.
- Reuse one shared validation helper across expense and trip forms.
- Update unit tests to include invalid checksum cases.

## Issue #10: Persist pending on-chain record retries across page refreshes

**Directory:** `hooks/`, `context/`, `lib/stellar/`

**Type:** Reliability

**Description:** `usePayment` stores `pendingOnChain` only in component state. If the XLM transfer succeeds but contract recording fails, refreshing the page removes the retry information. The user may see the share as paid in Supabase but lose the easiest way to complete the Soroban record.

**Expected outcome:** Partial-success payments should remain recoverable after refresh, navigation, or browser restart.

**Acceptance criteria:**
- Persist pending on-chain record data in a durable place such as Supabase or localStorage scoped by wallet.
- Show a retry action when pending records are detected.
- Clear the pending record after successful contract recording.
- Add tests for retry-state restoration.

## Issue #11: Verify payment transaction details before accepting `txHash` as settlement proof

**Directory:** `hooks/`, `lib/stellar/`, `contract/`, `docs/`

**Type:** Security, blockchain integrity

**Description:** The architecture docs note that `record_payment` stores the provided `tx_hash` and relies on app flow integrity. The contract does not verify that the hash corresponds to a real payment with the expected payer, member, amount, asset, and destination. This creates a gap between "recorded" and "cryptographically verified payment".

**Expected outcome:** Settlement proof should be tied to an actual Stellar payment matching the expense share.

**Acceptance criteria:**
- Add an off-chain verifier or an improved protocol design.
- Verify source, destination, asset, amount, memo, and ledger status before recording settlement.
- Document the trust boundary clearly.
- Add tests for mismatched transaction hash rejection.

## Issue #12: Expose or redesign the internal pool-credit prerequisite

**Directory:** `hooks/`, `lib/stellar/`, `contract/`, `components/payment/`

**Type:** UX, smart contract integration

**Description:** The payment flow prechecks internal pool credits before recording on-chain settlement, but the app does not provide a user-facing way to deposit or understand pool balance. A normal successful XLM transfer can become `partial_success` because the internal pool balance is too low.

**Expected outcome:** Users should understand and satisfy contract prerequisites before payment, or the pool-credit model should be redesigned.

**Acceptance criteria:**
- Show pool balance and shortfall before attempting on-chain recording.
- Provide a supported deposit/admin-credit flow, or remove the pool dependency from user settlement.
- Update docs to explain the current model.
- Add integration tests for enough balance, insufficient balance, and retry paths.

## Issue #13: Improve net-settlement payment mapping back to individual shares

**Directory:** `components/trips/`, `lib/settlement/`, `context/`

**Type:** Bug, settlement logic

**Description:** The Settle Up tab computes optimized net payments, then marks matching unpaid shares as paid by comparing member names and payer names. A single net payment can represent multiple expenses, and name-based matching can mark the wrong shares if names repeat or if the net amount only partially covers multiple debts.

**Expected outcome:** Net-settlement payments should map deterministically to the exact expense shares they settle.

**Acceptance criteria:**
- Track source expense/share IDs in the net-settlement calculation.
- Avoid name-only matching.
- Ensure the total marked-paid amount equals the payment amount.
- Add unit tests for duplicate names and multi-expense net payments.

## Issue #14: Match on-chain events by expense and amount, not only member wallet

**Directory:** `hooks/`, `lib/stellar/`, `components/trips/`

**Type:** Bug, blockchain sync

**Description:** `SettlementSummary` builds a set of on-chain confirmed members and marks a net payment as on-chain if the debtor wallet appears in any event. This is too broad. A member could have one on-chain event for a different expense while another settlement row is still unpaid.

**Expected outcome:** On-chain status should match the exact trip, expense, member, and amount being displayed.

**Acceptance criteria:**
- Include exact payment identifiers when comparing events to UI rows.
- Avoid marking unrelated rows as on-chain.
- Add parser and UI tests for multiple events from the same member.

## Issue #15: Add owner-aware delete controls for trips

**Directory:** `components/trips/`, `app/trips/`, `context/`

**Type:** Bug, authorization UX

**Description:** Expense cards hide delete controls unless the connected wallet is the payer. Trip cards show a delete button for every viewer, while the Supabase RLS policy only allows the creator to delete. Non-creators can click delete and may see confusing failure/fallback behavior.

**Expected outcome:** Trip delete controls should follow the same owner-aware UX as expenses.

**Acceptance criteria:**
- Pass the connected wallet into `TripCard`.
- Hide or disable delete for non-creators.
- Show clear feedback if deletion is denied.
- Add tests or manual QA notes for creator and non-creator users.

## Issue #16: Scope localStorage fallback data by wallet address

**Directory:** `context/`, `lib/utils/`

**Type:** Privacy, data consistency

**Description:** Trips, expenses, and user data are cached under global keys such as `StellarStar:expenses` and `StellarStar:trips`. If Supabase fails after switching wallets, one wallet may see stale cached data created by another wallet in the same browser.

**Expected outcome:** Offline/cache fallback data should be isolated per connected wallet.

**Acceptance criteria:**
- Include wallet address in cache keys or cache payload metadata.
- Clear or ignore cache when the connected wallet changes.
- Add tests for wallet switch behavior.
- Keep a safe empty state when cache does not belong to the active wallet.

## Issue #17: Use provider loading and error states on dashboard, expenses, and trips pages

**Directory:** `app/`, `context/`, `components/ui/`

**Type:** UX

**Description:** `TripContext` and `ExpenseContext` expose `isLoading`, but main pages mostly render empty states based only on array length. During initial load or Supabase fallback, users may briefly see "No expenses yet" or "No trips yet" even when data is still loading.

**Expected outcome:** Pages should clearly distinguish loading, empty, offline fallback, and error states.

**Acceptance criteria:**
- Render a loading state while providers are fetching.
- Show a clear offline/fallback notice when local cache is used.
- Avoid misleading empty states before loading completes.
- Add component tests for loading and empty-state transitions.

## Issue #18: Replace spoofable wallet-header authentication with signed wallet proof

**Directory:** `lib/supabase/`, `context/`, `supabase-setup.sql`

**Type:** Security

**Description:** Supabase RLS policies rely on `current_setting('request.headers')` and an `x-wallet-address` header created by the client. A malicious client can spoof this header unless there is a signed challenge or trusted server component verifying wallet ownership.

**Expected outcome:** Database access should be based on verifiable wallet ownership, not a client-provided address string alone.

**Acceptance criteria:**
- Add wallet signature challenge flow for sign-in/sign-up.
- Store and verify a session or token tied to the wallet address.
- Update RLS policies to rely on verified identity.
- Document the security model and migration path.

## Issue #19: Add Playwright end-to-end and mobile viewport tests

**Directory:** `__tests__/`, `app/`, `components/`, `.github/workflows/`

**Type:** Testing

**Description:** Current Jest coverage is useful, but there are no browser end-to-end tests for the main flows. The docs already recommend Playwright mobile viewport assertions. Important flows like connect wallet prompts, creating expenses, trip detail navigation, QR display, and responsive layout need browser-level coverage.

**Expected outcome:** Core user journeys should be covered by automated browser tests.

**Acceptance criteria:**
- Add Playwright setup.
- Cover landing, auth prompt, dashboard, expenses, trips, and trip detail pages.
- Include at least one mobile viewport test.
- Add the Playwright job to CI or document how to run it locally.

## Issue #20: Expand contract deployment script to deploy and initialize both contracts

**Directory:** `scripts/`, `contract/`, `docs/`

**Type:** DevOps, smart contract operations

**Description:** `scripts/deploy-contract.sh` deploys one contract and prints `NEXT_PUBLIC_CONTRACT_ID`. The current architecture requires both the settlement contract and pool contract, plus initialization and proof links. Manual steps increase deployment mistakes and stale docs.

**Expected outcome:** Contract deployment should automate the full settlement and pool setup.

**Acceptance criteria:**
- Build and deploy settlement and pool contracts.
- Initialize pool and settlement references.
- Print all contract IDs and transaction links.
- Update README/runbook instructions to match the script.

## Issue #21: Add mobile proof assets and documentation link validation

**Directory:** `public/`, `README.md`, `docs/`, `.github/workflows/`

**Type:** Documentation, CI

**Description:** The requirement matrix still lists the mobile screenshot as pending manual capture. The docs also include several external proof links and demo URLs that can drift over time. Contributors need a clear task to keep proof assets current.

**Expected outcome:** README proof assets and links should stay complete and verifiable.

**Acceptance criteria:**
- Add a current mobile viewport screenshot under `public/`.
- Reference the screenshot from README.
- Add a lightweight link/proof checker script or CI job.
- Update the requirement matrix from pending to complete after the asset is added.

## Issue #22: Unfunded accounts cannot read contract state (is_paid, get_payments) due to Horizon account loading failure

**Directory:** `lib/stellar/contract.ts`

**Type:** Bug, Developer Experience

**Description:** Read-only contract queries (such as checking if an expense is paid or retrieving a list of payments) fail for unfunded Stellar accounts because the helper functions invoke `loadAccount(callerPublicKey)` to fetch account details. Horizon returns a 404 error if the address has not been funded yet, completely blocking status checks.

**Expected outcome:** Read-only queries should not fail for unfunded accounts.

**Acceptance criteria:**
- Query functions like `checkIsPaid` and `getContractPayments` should bypass account loading or use a fallback funded transaction fee account to simulate transactions.
- New/unfunded accounts can query their settlement status.
- Integration tests check queries with mock unfunded addresses.

## Issue #23: Realtime database subscription uses unauthenticated supabase client instead of wallet-authenticated client

**Directory:** `context/ExpenseContext.tsx`, `context/TripContext.tsx`

**Type:** Bug, Security

**Description:** Realtime database subscriptions use the root `supabase` client instead of the authenticated client created by `createAuthenticatedClient(publicKey)`. Under active RLS policies, unauthenticated subscriptions are rejected or receive no updates, leaving the UI stale until a reload.

**Expected outcome:** Realtime subscriptions should use the authenticated client when a wallet is connected.

**Acceptance criteria:**
- Re-initialize realtime database channel listeners using the authenticated client when `publicKey` changes.
- Unsubscribe from old channels to prevent leaks.
- Verify updates propagate dynamically when RLS policies are enabled.

## Issue #24: Performance issues and memory leaks from instantiating a new SupabaseClient on every authenticated request

**Directory:** `lib/supabase/client.ts`, `context/ExpenseContext.tsx`, `context/TripContext.tsx`

**Type:** Performance, Maintenance

**Description:** `createAuthenticatedClient` calls `createClient` on every single invocation, returning a new instance. Every time a context creates, updates, or settles a trip/expense, a new client instance is created. This wastes system resources and leaks WebSocket connections.

**Expected outcome:** Authenticated Supabase clients should be cached and reused.

**Acceptance criteria:**
- Store/cache the authenticated client instance scoped by the active wallet address.
- Clear the client cache on disconnect.
- Verify that only one client instance exists per active session.

## Issue #25: Memo text is not truncated in `buildQRPaymentURI`, causing transaction errors in external wallets

**Directory:** `lib/qr/generator.ts`

**Type:** Bug, UX

**Description:** The `buildQRPaymentURI` helper includes the raw `memo` string in the SEP-0007 query parameters without byte-length verification or truncation. If an expense title is long, the URL query parameter contains a memo text exceeding 28 bytes, which causes external wallets (like Lobstr or xBull) to crash or reject the transaction during scanning.

**Expected outcome:** Memo text should be safely truncated to a maximum of 28 bytes before constructing the QR URI.

**Acceptance criteria:**
- Implement UTF-8 byte-aware truncation in `buildQRPaymentURI` to limit the memo to 28 bytes.
- Add unit tests validating that long emojis and strings are truncated without producing invalid UTF-8 sequences.

## Issue #26: String `slice(0, 28)` in `PaymentRow` and `SettlementSummary` can split multi-byte characters, resulting in invalid memo encoding

**Directory:** `components/expenses/PaymentRow.tsx`, `components/trips/SettlementSummary.tsx`

**Type:** Bug, Internationalization

**Description:** Slicing the memo to 28 characters using JavaScript's `.slice(0, 28)` is unsafe if the string contains multi-byte UTF-8 characters (like emojis or special glyphs) near the index boundary. This can cut a character in half, creating invalid UTF-8 strings that cause Horizon to reject transaction submissions.

**Expected outcome:** Use a byte-length aware truncation helper to prepare safe on-chain memo strings.

**Acceptance criteria:**
- Replace string `.slice` with a byte-aware truncation helper (similar to `trimToMemoBytes` in transaction builder).
- Test with multi-byte characters at the boundary (e.g. 🍔 emojis).

## Issue #27: Net settlement transactions are not recorded on-chain, creating a mismatch between blockchain status and Supabase state

**Directory:** `components/trips/SettlementSummary.tsx`

**Type:** Bug, Architecture Mismatch

**Description:** When users click "Pay" in the "Settle Up" tab, the transaction is submitted directly to the Stellar network as a value transfer, but the Soroban smart contract is never invoked to record the settlement proof. This results in the database and UI displaying a settled status that is completely missing from the blockchain audit trail.

**Expected outcome:** Net settlements should record their status on-chain.

**Acceptance criteria:**
- Integrate smart contract recording in the "Settle Up" transaction flow.
- Update the database and UI to only mark net-shares as paid on-chain after successful contract simulation and submission.
- Handle partial contract recording errors gracefully.

## Issue #28: No database-level validation to ensure the sum of expense shares matches `total_amount`

**Directory:** `supabase-setup.sql`

**Type:** Database Integrity, Security

**Description:** The `expenses` table does not enforce that the sum of amounts within the JSONB `shares` array equals the `total_amount`. A client bug or direct API mutation can insert an expense where the split shares are inconsistent with the total cost.

**Expected outcome:** Database constraints or triggers should ensure transactional consistency between the total bill and individual shares.

**Acceptance criteria:**
- Add a PostgreSQL database trigger or CHECK constraint to validate that the sum of all `amount` values in the `shares` JSONB array equals the parsed numeric value of `total_amount`.
- Test that invalid entries are rejected by Supabase.

## Issue #29: Inconsistency between `member_wallets` array and the actual `members` JSONB array on table insertion/update

**Directory:** `supabase-setup.sql`

**Type:** Database Integrity

**Description:** RLS policies rely on the `member_wallets` text array to restrict read/write access. However, there is no database-level assertion ensuring that the addresses listed in the `member_wallets` array match the actual wallet addresses stored inside the `members` or `shares` JSONB arrays, leading to potential data drift or security bypasses.

**Expected outcome:** Database schema should guarantee consistency between member lists and RLS access arrays.

**Acceptance criteria:**
- Implement a PostgreSQL trigger function that automatically syncs the `member_wallets` array from the `members` JSONB field on insert/update, or validates they are identical.
- Confirm RLS remains functional and secure.

## Issue #30: Suboptimal performance of RLS select policies utilizing JSONB array expansion (`jsonb_array_elements`)

**Directory:** `supabase-setup.sql`

**Type:** Performance, Database Tuning

**Description:** The select policy `"Members can view their expenses"` expands the `shares` JSONB array using `jsonb_array_elements` for every single row scanned. On large tables, this causes massive CPU usage and prevents index usage.

**Expected outcome:** RLS queries should run in logarithmic time by utilizing indexes.

**Acceptance criteria:**
- Rephrase the select policy to query the `member_wallets` column exclusively (which is indexed using GIN) instead of checking individual shares via `jsonb_array_elements`.
- Verify performance improvements using `EXPLAIN ANALYZE`.

## Issue #31: Immediate deletion of trips on clicking delete button without any confirmation prompt

**Directory:** `components/trips/TripCard.tsx`

**Type:** UX

**Description:** Clicking the "Delete" button on a trip card deletes the trip immediately. Because there is no verification modal, users risk losing all trip details and linked expenses due to a single misclick.

**Expected outcome:** Users must confirm their intention before any destructive delete action.

**Acceptance criteria:**
- Display a confirmation modal when the delete button is pressed.
- Only call `onDelete` after explicit user confirmation.
- Add tests/manual QA checklist verification.

## Issue #32: No option to disconnect or switch wallets in the Authentication page once connected

**Directory:** `app/auth/page.tsx`

**Type:** UX, Wallet Connection Flow

**Description:** In the authentication screen (`/auth`), once a wallet is connected, the signup/signin forms are rendered. However, there is no option to disconnect or switch the active wallet from this interface, trapping the user unless they manually clear their extension session.

**Expected outcome:** Provide a clear "Disconnect" button to reset the wallet connection state.

**Acceptance criteria:**
- Add a "Disconnect Wallet" or "Switch Wallet" button in the connected state view of the auth page.
- Clear local storage cache and state on click.

## Issue #33: Relative hash links in Header are broken on subpages (Dashboard, Expenses, Trips)

**Directory:** `components/layout/Header.tsx`

**Type:** Bug, Routing

**Description:** The navigation links in the header are set as relative hashes (e.g., `#features`). If a user is on `/dashboard` and clicks these, Next.js tries to find the elements on the dashboard page instead of returning to the home page, resulting in broken navigation.

**Expected outcome:** Navigation links should work from any route.

**Acceptance criteria:**
- Convert relative hash links to absolute home page links (e.g. `/#features`, `/#pricing`).
- Verify clicking the links from dashboard correctly redirects to the homepage and scrolls to the selected anchor.

## Issue #34: The `useBalance` hook abort trigger is a no-op because it is not passed to the underlying `getXLMBalance` function

**Directory:** `hooks/useBalance.ts`, `lib/stellar/getBalance.ts`

**Type:** Bug, Resource Efficiency

**Description:** In `useBalance.ts`, the hook registers an `AbortController` in `useEffect` and calls `.abort()`. However, `getXLMBalance` does not receive or forward the `AbortSignal` to the fetch API, meaning requests are never canceled, leading to memory overhead and potential state race conditions.

**Expected outcome:** Fetch requests should be abortable to prevent race conditions.

**Acceptance criteria:**
- Update `getXLMBalance` to accept an optional `AbortSignal`.
- Pass the signal from `useBalance.ts` to `getXLMBalance`.
- Verify network requests are aborted in the network tab when the hook unmounts.

## Issue #35: Lack of pagination handling in `fetchContractEvents`, risking missing records for active trips

**Directory:** `lib/stellar/events.ts`

**Type:** Bug, Scalability

**Description:** The event polling helper limits results using `limit: 200`. If a trip has a high transaction volume and accumulates more than 200 events within the lookback ledgers, subsequent events are cut off and never synchronized, leaving the client state incomplete.

**Expected outcome:** Polling should retrieve all events by handling pagination cursor tokens.

**Acceptance criteria:**
- Add a loop or recursive paging logic in `fetchContractEvents` if the returned event count equals the limit.
- Ensure all events are fetched and parsed correctly.

## Issue #36: Deleting an expense does not clean up its ID from `expense_ids` in the `trips` table, causing database references to drift

**Directory:** `context/ExpenseContext.tsx`

**Type:** Database Integrity

**Description:** Deleting an expense from `ExpenseContext` removes it from the `expenses` table, but the containing trip still references the deleted ID in its `expense_ids` array, causing dead references and rendering bugs.

**Expected outcome:** Deleting an expense should clean up all associations in other tables.

**Acceptance criteria:**
- In `deleteExpense`, trigger a database update to remove the deleted `expenseId` from the `expense_ids` array in the `trips` table.
- Verify database referential integrity is preserved.

## Issue #37: Pool contract lacks actual token transfer (deposit/withdraw) logic, making it only a mock credit counter

**Directory:** `contract/src/pool.rs`

**Type:** Security, Smart Contract Architecture

**Description:** The `SettlementPoolContract` increments and decrements internal balances but does not custody or transfer actual Stellar assets (like XLM or custom SAC tokens). Users don't get any value back upon withdrawing from the pool, making it only a mock credit counter.

**Expected outcome:** The pool contract should handle actual token custody and transfers.

**Acceptance criteria:**
- Integrate Stellar Asset Contract (SAC) token transfer logic in the deposit and withdraw functions.
- Safely hold deposited tokens in the pool contract and transfer them back on withdrawal.

## Issue #38: Users cannot deposit funds directly into the pool contract because `deposit` requires admin authentication

**Directory:** `contract/src/pool.rs`

**Type:** Smart Contract UX, Security

**Description:** The `deposit` function in `pool.rs` requires admin authorization (`cfg.admin.require_auth()`). This prevents users from depositing their own funds directly, creating a centralized bottleneck.

**Expected outcome:** Users should be able to deposit their own funds by authenticating themselves.

**Acceptance criteria:**
- Allow any user to call `deposit` by using their own address auth rather than admin authorization.
- Integrate token transfer from the depositor to the pool.

## Issue #39: The pool contract lacks a method for users to withdraw their credits to their external wallets

**Directory:** `contract/src/pool.rs`

**Type:** Smart Contract Architecture

**Description:** The `withdraw` function only decrements the internal balance in storage. There is no mechanism to transfer actual assets from the contract's custody back to the user's wallet address, meaning withdrawn credits are simply burned without releasing tokens.

**Expected outcome:** Withdrawals should trigger token transfers back to the caller's address.

**Acceptance criteria:**
- Update the `withdraw` function to execute a token transfer of the corresponding amount from the contract to the `from` address.

## Issue #40: Lack of component unit tests for key forms and UI elements (ExpenseForm, TripForm, PayButton, QRCodeDisplay)

**Directory:** `__tests__/`

**Type:** Testing Coverage

**Description:** While there are unit tests for utilities and transaction building under `__tests__`, there are no component-level tests verifying user input handling, validation triggers, and event emission for primary forms like `ExpenseForm` and `TripForm`.

**Expected outcome:** Critical UI forms should be covered by unit tests.

**Acceptance criteria:**
- Add Jest + React Testing Library tests for `ExpenseForm` and `TripForm`.
- Cover mock input inputs, error validation messages, and submit clicks.

## Issue #41: Accumulated rounding errors in custom split calculations can cause the sum of shares to deviate from the total bill amount

**Directory:** `lib/split/calculator.ts`

**Type:** Bug, Split Accuracy

**Description:** In `lib/split/calculator.ts`, the `calculateCustomSplit` function divides weights and multiplies by `totalXLM`, formatting each share independently using `.toFixed(7)`. Unlike `calculateEqualSplit`, there is no remainder distribution for the last member, leaving a discrepancy between the total bill and the sum of shares.

**Expected outcome:** The sum of calculated custom shares plus the payer's share must exactly match the total bill amount.

**Acceptance criteria:**
- Update the custom split calculator to distribute rounding remainders to the final share.
- Add unit tests verifying zero-loss precision splits.

---

# Epic: Real Money — hard track (Issues #42–#66)

Stellar-star works, but it is a demo wearing a product's clothes. Every amount is XLM,
settlement proof is verified by the client that benefits from the verification, the
settlement pool holds exactly one token, debts never actually simplify, and a concurrent
write can lose money. This epic takes it to something you could hand a stranger.

**These issues are deliberately hard.** Each states a problem and the invariants a
solution must satisfy. **None of them tells you how to build it.** The design is the
work, and most carry a required design note so the reasoning survives the pull request.
Expect days, not hours. Several require reading the Stellar protocol docs or the
`soroban-sdk` source rather than guessing from the existing code.

If an issue looks like it can be finished in one sitting, you have probably missed a
constraint. Re-read the invariants.

## Ground rules

**Rule 1 — Interface seams are fixed; everything behind them is yours.**
Where two issues must meet, this document fixes only the *seam*: a module path and an
exported signature. The implementation behind it, and every design decision it implies,
belongs to whoever takes the issue. If the seam file does not exist when you start,
create it with the specified exports and your own implementation. If it does exist, code
against it and do not rewrite it.

**Rule 2 — Any order. Prove it.**
Every issue must land on `main` independently, with `npm test`, `npm run lint`, and
`npm run build` green, whether or not any sibling issue has landed. New parameters on
existing signatures are optional with behaviour-preserving defaults. Your PR description
must state which siblings you assumed absent and how you degraded.

**Rule 3 — Invariants are the specification.**
Where an issue lists invariants, they are not guidance. They are the acceptance test.
Several are stated as properties over all inputs and expect property-based tests, not a
handful of examples.

**Rule 4 — Adversarial by default.**
This application moves real value. Any issue touching the money path must assume the
client is hostile and controlled by someone who profits from the bug. "The UI prevents
it" is never a defence — the client talks to PostgREST and Horizon directly.

**Rule 5 — Show your rejected alternatives.**
Issues marked *Design note required* must ship a short document under `docs/` stating
the approach taken, at least two alternatives considered, and why they were rejected.
A PR that implements without this will be sent back regardless of code quality.

## Interface seams

Fixed contracts, so issues can be worked in parallel. **Signatures only — no
implementations are given.**

| Seam | Module | Exports |
|---|---|---|
| **S1** Asset identity | `lib/stellar/assets.ts` | `AssetRef {code, issuer\|null}`, `assetKey(ref): string`, `parseAssetKey(s): AssetRef`, `toSdkAsset(ref): Asset`, `resolveAsset(ref): AssetDef`, `getAssetRegistry(net?): AssetDef[]` |
| **S2** Money arithmetic | `lib/money/amount.ts` | `Amount` opaque type, `parse(s, decimals): Amount`, `add/sub/mul/div`, `format(a, decimals): string`, `compare` |
| **S3** Settlement attestation | `lib/settlement/attest.ts` | `Attestation` type, `requestAttestation(claim): Promise<Attestation>`, `verifyAttestation(a): boolean` |
| **S4** Rate quotes | `lib/fx/types.ts` | `RateQuote {rate, source, asOf, stale}`, `RateProvider {id, supports, quote}` |
| **S5** Debt graph | `lib/settlement/graph.ts` | `Debt {from, to, amount, asset}`, `simplify(debts[]): Transfer[]` |

Two facts that constrain many issues, both verified against the protocol and this
codebase — do not re-derive them, and do not assume more than they say:

- **Every classic Stellar asset uses exactly 7 decimals.** Amounts are int64 stroops
  protocol-wide. This is *not* true of arbitrary Soroban tokens, which may declare any
  `decimals()`. Code that assumes 7 must say so where it assumes it.
- **Circle USDC issuers.** Testnet `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
  mainnet `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`. Anyone can issue an
  asset called "USDC"; only one of these is Circle's. Comparing asset *code* alone is a
  security bug, not a shortcut.

---

## Issue #42: Close the settlement trust boundary with an attestation oracle

**Directory:** `contract/src/`, `app/api/`, `lib/settlement/`
**Type:** Security, protocol, backend
**Difficulty:** Very hard — 1 to 2 weeks
**Prerequisites:** Soroban `contractimpl`, ed25519 signature schemes, replay resistance
**Seam:** S3
**Design note required.**

**The problem.**

`docs/ARCHITECTURE_AND_LIMITATIONS.md` documents this as an accepted limitation, and it
is the single largest hole in the product's central claim. `record_payment` stores a
`tx_hash` as immutable settlement evidence. Whether that hash corresponds to a real
payment of the right amount, asset, and destination is checked **by the client, in
`lib/stellar/verifyTransaction.ts`, in the browser of the person who benefits from the
answer**.

Anyone can call the contract directly with `stellar contract invoke` and a fabricated
`tx_hash`. The contract will happily record it, `is_paid` will return true, and the app
will show the debt as settled on-chain. The "verifiable proof" is not verifiable.

**Why this is hard.**

You cannot verify a Horizon transaction from inside a Soroban contract — there is no
host function for it, and there will not be one. The proof has to come from somewhere
trusted, which means designing a trust anchor and then defending it. Every naive answer
has a hole:

- A signed attestation is replayable unless bound to something single-use.
- Binding it to the expense alone lets a debtor reuse one attestation across trips.
- Putting the oracle key in the app's environment means anyone with a deploy log has it.
- Making the oracle the sole writer creates an availability dependency: if it is down,
  nobody can settle, and a settlement app that cannot settle is worse than one with a
  theoretical hole.

You must also decide what happens to the existing pool `withdraw` call, which currently
runs on the same code path.

**Invariants.**

1. A `record_payment` call not accompanied by a valid, unexpired, unreplayed attestation
   over *this exact claim* must fail.
2. An attestation is bound to the full claim: trip, expense, payer, member, amount,
   asset, and tx hash. Changing any field invalidates it.
3. An attestation can be consumed at most once, and this must hold across concurrent
   submissions and across multiple oracle instances.
4. The oracle independently verifies against Horizon. It must never trust a
   client-supplied assertion about the transaction, only the tx hash as a lookup key.
5. Oracle unavailability degrades settlement to off-chain-recorded, never to a silent
   success that claims on-chain proof it does not have.

**Deliverables.** Contract-side verification, an oracle endpoint, key management that
does not put the signing key in `NEXT_PUBLIC_*`, the S3 client module, and an adversarial
test suite that *attempts* forgery, replay, cross-expense reuse, and field tampering, and
asserts each is rejected.

**Explicitly not specified.** The signature scheme and how the contract verifies it; how
nonces are represented and stored; whether attestations are pre- or post-payment; the
key custody model; how oracle downtime surfaces in the UI.

**Out of scope.** Multi-asset pool routing (#43). Assume single-asset for now and say so.

---

## Issue #43: Make the settlement pool hold more than one asset, without stranding balances

**Directory:** `contract/src/`, `scripts/`, `lib/stellar/`
**Type:** Protocol, migration
**Difficulty:** Very hard — 1 to 2 weeks
**Prerequisites:** Rust, `soroban-sdk`, contract storage and TTL semantics
**Design note required.**

**The problem.**

`contract/src/pool.rs` holds exactly one token — `cfg.token: Address` — and
`contract/src/lib.rs` makes `record_payment` unconditionally call
`pool_client.withdraw(&member, &amount)`. So a USDC settlement would withdraw that many
units from a pool denominated in some other token. Multi-asset settlement is impossible
until this is resolved, and it is the reason every other multi-asset issue in this epic
has to work around the on-chain path.

**Why this is hard.**

The obvious fix — key balances by `(member, token)` instead of `member` — changes the
storage layout of a contract that already holds real testnet balances. Redeploying to a
fresh contract ID strands them and every historical `PaymentRecord` with them. Migrating
in place means writing a migration entry point, reasoning about which ledger entries
exist, and handling the case where a member never interacts again.

Then there is `CONTRACT_VERSION` and the `VersionMismatch` error: the current code
panics if instance storage disagrees with the compiled constant, so a v2 wasm deployed
over v1 storage bricks the contract. And Soroban storage has TTLs — the existing code
bumps by `LEDGERS_PER_DAY * 365`, so an entry can expire and be archived. A migration
that assumes every historical entry is still live is wrong.

You must also decide whether one pool per asset or one multi-asset pool is correct, and
defend it. Both are defensible; an undefended choice is not.

**Invariants.**

1. No member's existing credit balance is lost, unreachable, or double-counted after
   migration.
2. A settlement in asset A can never withdraw from a balance denominated in asset B.
3. The migration is idempotent — running it twice does not double-credit.
4. Deploying the new wasm cannot brick the contract via version mismatch, whether over
   fresh or existing storage.
5. An archived (TTL-expired) entry is handled explicitly, not assumed present.

**Deliverables.** The contract change, a migration path with tests covering the
pre-existing-state case, an extended `scripts/deploy-contract.sh`, updated `README.md`
contract IDs and proof links (`npm run proof:links` gates this in CI), and Rust tests
including a same-expense-two-assets case.

**Explicitly not specified.** Pool-per-asset vs multi-asset pool; the migration
mechanism; whether to preserve the inter-contract-call proof the README advertises.

---

## Issue #44: Let a payer settle in an asset they do not hold, via path payments

**Directory:** `lib/stellar/`, `hooks/`, `components/payment/`
**Type:** Feature, protocol
**Difficulty:** Hard — 4 to 7 days
**Prerequisites:** Stellar DEX, path payments, order book mechanics, slippage
**Seam:** S1
**Design note required.**

**The problem.**

If a bill is denominated in USDC and the debtor holds only XLM, they are stuck: acquire
USDC elsewhere, or do not settle. Stellar solves this natively —
`pathPaymentStrictReceive` lets the sender spend XLM while the recipient receives an
exact USDC amount, atomically, through the DEX. Using it is the single strongest
argument for settling on Stellar rather than anywhere else, and the app does not use it.

**Why this is hard.**

Path payments are where naive implementations lose money. `sendMax` is a real spend
limit, and setting it from a stale quote either fails the transaction or overpays into a
thin book. The path returned by Horizon is a *suggestion* computed against a book that
can move before the transaction lands. A path through an illiquid intermediate asset can
have severe price impact that a quote does not surface.

The recipient must still have a trustline to the destination asset, so this composes
with the trustline problem rather than avoiding it. And verification changes shape: the
resulting Horizon operation is `path_payment_strict_receive`, not `payment`, with a
different record structure — anything asserting `op.type === "payment"` will silently
reject a perfectly good settlement.

**Invariants.**

1. The recipient receives **exactly** the amount owed, or the transaction fails. Never
   less.
2. The sender can never spend more than an explicitly displayed and confirmed maximum.
3. Slippage tolerance is bounded, explicit, and shown before signing — never a silent
   default.
4. Settlement verification accepts a path payment as valid proof, asserting the
   destination asset and received amount, not the source.
5. No path found is a clear, actionable state, not a generic failure.

**Deliverables.** Path discovery with a freshness policy, `sendMax` derivation, a
pre-signature confirmation showing worst-case spend and price impact, verification that
handles both operation types, and tests against recorded Horizon fixtures including a
thin-book case.

**Explicitly not specified.** Slippage default and whether users can change it; quote
refresh strategy; whether to reject paths above a price-impact threshold.

---

## Issue #45: Onboard users who have no funded Stellar account

**Directory:** `lib/stellar/`, `app/api/`, `components/`
**Type:** Feature, protocol, UX
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Sponsored reserves, `CreateAccount`, claimable balances, fee bumps
**Design note required.**

**The problem.**

A Stellar account does not exist until it is funded, and a trustline raises the minimum
reserve by 0.5 XLM. So a new user with an empty wallet cannot receive USDC, cannot add a
trustline, and in fact does not have an account at all. `getXLMBalance` returns a Horizon
404 for them. Today that is a dead end: the app tells them something failed and stops.

Every group expense app lives or dies on whether you can add the friend who has never
heard of it. Right now you cannot.

**Why this is hard.**

Stellar offers several mechanisms and they solve different halves. Sponsored reserves
(`BeginSponsoringFutureReserves` / `EndSponsoring`) let a third party pay the base
reserve while the sponsored account retains control — but sponsorship is a durable
liability that locks the sponsor's XLM until revoked, so an unbounded sponsor is a
drain. Claimable balances let you send value to an account that does not exist yet, but
the claimant still needs an account to claim it. Fee-bump transactions cover fees but
not reserves.

You must choose a combination, bound the cost, and decide who pays — and defend it
against someone who scripts account creation to drain the sponsor.

**Invariants.**

1. A user with no funded account can be added to an expense and can eventually settle,
   without leaving the app for an external faucet.
2. The sponsor's exposure per account is bounded and known, and total exposure is
   bounded.
3. Sponsorship is revocable, and the revocation path is implemented, not just described.
4. A sponsored user retains full control of their account and keys at all times.
5. Abuse resistance: creating N accounts costs an attacker something that scales.

**Deliverables.** The onboarding flow, sponsorship accounting with a hard cap, a
revocation path, an abuse-resistance mechanism, and tests covering the unfunded,
partially funded, and sponsor-exhausted cases.

**Explicitly not specified.** Which mechanism combination; who sponsors; the funding
model; how exhaustion surfaces.

---

## Issue #46: Build an asset abstraction that survives the protocol's real edge cases

**Directory:** `lib/stellar/`, `types/`
**Type:** Feature, foundation
**Difficulty:** Hard — 3 to 5 days
**Prerequisites:** Stellar asset semantics, trustline flags, SEP-0011
**Seam:** S1

**The problem.**

`lib/stellar/buildTransaction.ts` hardcodes `Asset.native()` and `types/expense.ts`
types `currency` as the literal `"XLM"`. The app needs a real asset abstraction. Writing
one that handles XLM and USDC is an afternoon; writing one that does not fall over on the
protocol's actual behaviour is not.

**Why this is hard.**

The edge cases are where this goes wrong, and each has bitten a real Stellar app:

- `credit_alphanum4` vs `credit_alphanum12` are distinct types with different XDR
  encodings. A 5-character code is not an alphanum4 asset with padding.
- Trustlines carry authorization flags. An asset with `AUTH_REQUIRED` cannot be received
  until the issuer authorizes that specific trustline — the trustline existing is not
  sufficient.
- Assets can be issued with `AUTH_CLAWBACK_ENABLED`, meaning the issuer can claw back
  balances. Presenting such an asset as a settled debt is arguably dishonest.
- Two issuers can mint the same code. Identity is `(code, issuer)`, always.
- The native asset has no issuer and must never be compared as though it does.
- Soroban tokens may declare decimals other than 7. Classic assets never do.

**Invariants.**

1. Asset identity is `(code, issuer)`. No code path compares codes alone.
2. Codes of 1–4 and 5–12 characters both round-trip correctly through XDR.
3. An asset requiring authorization is distinguishable from one merely lacking a
   trustline, and the two produce different user-facing outcomes.
4. `assetKey` is stable, collision-free, and round-trips through `parseAssetKey`.
5. An unknown or malformed asset degrades to a safe, explicit state — never a silent
   fallback to native.

**Deliverables.** The S1 seam, a network-aware registry with env override, and tests
covering alphanum12, auth-required, clawback-enabled, same-code-different-issuer, and
malformed input.

**Explicitly not specified.** Registry shape and storage; how clawback-enabled assets are
surfaced; whether unknown assets are rejected or shown read-only.

---

## Issue #47: Replace floating-point money with an exact arithmetic type

**Directory:** `lib/money/`
**Type:** Refactor, correctness
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** Fixed-point arithmetic, IEEE-754 failure modes
**Seam:** S2

**The problem.**

Money in this codebase is `string` at rest and `number` in flight. `lib/split/calculator.ts`
does `parseFloat`, arithmetic, and `toFixed(7)`. `lib/settlement/netBalance.ts` accumulates
into a float and rounds with `Math.round(total * 1e7) / 1e7`. `components/dashboard/DashboardStats.tsx`
sums with `reduce`.

Every one of those is a place `0.1 + 0.2 === 0.30000000000000004` becomes a real
discrepancy. The existing `isValidXLMAmount` counts decimals on the *input string*
specifically to dodge this, with a comment saying so — which is an acknowledgement that
the problem is understood and unaddressed everywhere else.

**Why this is hard.**

This is a cross-cutting refactor of the money path with no behaviour change permitted
except that wrong answers become right. It touches split calculation, netting,
aggregation, contract conversion, and display, and it must not regress the existing
suites. `MAX_AMOUNT_STROOPS` is 1e16, beyond `Number.MAX_SAFE_INTEGER` when expressed in
stroops, so `number` is not merely imprecise but insufficient.

You must also decide how the type crosses boundaries — PostgREST returns strings, Horizon
returns strings, `nativeToScVal` wants `bigint`, React wants something renderable — and
where conversion is allowed to happen.

**Invariants.**

1. No arithmetic on a money value passes through `number` at any point.
2. Round-trip `parse(format(x)) === x` for all representable values.
3. Addition is associative and commutative over any ordering of a list.
4. Every rounding is explicit at a named call site with a stated mode. No implicit
   rounding anywhere.
5. Values up to `MAX_AMOUNT_STROOPS` are representable without loss.

**Deliverables.** The S2 seam, migration of split, netting, aggregation, and contract
conversion, and property-based tests asserting associativity, commutativity, and
round-tripping over generated inputs — not example-based tests.

**Explicitly not specified.** The representation; whether to adopt a dependency or build
it; the rounding mode; where boundary conversions live.

---

## Issue #48: Actually simplify debts across the whole group

**Directory:** `lib/settlement/`
**Type:** Algorithm, feature
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Graph algorithms, flow networks, NP-hardness, property testing
**Seam:** S5
**Design note required.**

**The problem.**

`computeNetPayments` in `lib/settlement/netBalance.ts` groups debts by
`` `${fromId}_${toId}` `` and sums each group. That is not simplification, it is
deduplication. Two consequences, both visible to users:

- **Mutual debts do not cancel.** A owes B 10 and B owes A 6 produces *two* payments,
  10 and 6, instead of one payment of 4. Both parties pay fees, both sign, and 6 units
  move in a circle.
- **Cycles do not collapse.** A owes B 10, B owes C 10, C owes A 10 produces three
  payments, when the correct answer is zero payments — the debts are already settled in
  aggregate.

For a trip with six people and twenty expenses, this is the difference between four
transfers and twenty-two.

**Why this is hard.**

Minimizing the number of transfers that settle a debt graph is NP-hard — it reduces from
subset-sum. You are not going to find an optimal polynomial algorithm, so the work is
choosing a good heuristic, bounding how far from optimal it can be, and being honest about
it in the design note.

Beyond that, the constraints are what make it real:

- **Assets do not net against each other.** A USDC debt and an XLM debt between the same
  pair are two separate graphs. Getting this wrong silently invents money.
- **Partial settlement.** Some debts are already paid. Simplification must operate over
  the unsettled subgraph and must never produce a transfer that contradicts a recorded
  on-chain payment.
- **Determinism.** Two members' browsers must compute the *same* transfer set from the
  same inputs, or they will see different amounts owed and sign contradictory
  transactions. Any iteration over an unordered structure is a bug here.
- **Fairness.** A minimal-transfer solution can route a debt through someone who was
  never involved, making them front money. Whether that is acceptable is a product
  decision you must make and defend.

**Invariants.**

1. Conservation: for every participant, net position before and after simplification is
   identical.
2. Never cross assets.
3. Deterministic: identical input yields byte-identical output, independent of map or
   object iteration order.
4. Transfer count is never greater than the current pairwise-grouping result.
5. No transfer is produced for a debt already settled.
6. Terminates for any graph, including fully-connected ones with cycles.

**Deliverables.** The S5 seam, the algorithm, and property-based tests over randomly
generated graphs (vary participant count, density, cycles, mixed assets, partial
settlement) asserting every invariant. Include a benchmark at 50 participants and 500
debts. Document the optimality bound.

**Explicitly not specified.** The algorithm; the fairness policy; whether to expose
"simplified" versus "literal" as a user choice.

---

## Issue #49: Make split arithmetic provably exact for every input

**Directory:** `lib/split/`
**Type:** Algorithm, correctness
**Difficulty:** Hard — 3 to 5 days
**Prerequisites:** Fixed-point rounding, apportionment methods, property testing

**The problem.**

`calculateEqualSplit` and `calculateCustomSplit` compute each share, then hand the
accumulated remainder to whichever member happens to be last in the array. That is a real
choice with real consequences, and it is currently made by accident.

Split 10 XLM three ways at 7 decimals and someone absorbs a remainder. Today it is
whoever was added last — not the payer, not a rotation, not anything defensible. Worse,
the shares only cover non-payers, so `sum(shares) + payerShare == total` is an invariant
nobody has ever asserted. `Issue #41` in this file reports a real deviation from it.

**Why this is hard.**

This is a known problem with a literature: apportionment. Largest-remainder, Hamilton,
Webster, and Jefferson methods all distribute an indivisible remainder differently, and
each has a documented pathology — largest-remainder suffers the Alabama paradox, where
increasing the total can *decrease* someone's share.

You must pick a method, understand its pathology, and decide whether it matters at 7
decimals. You must also handle weight edge cases the current code does not: zero weights,
fractional weights, weights summing to something that does not divide the total, a single
member, and a member whose weight is the entire total.

And it must be deterministic and order-independent — two clients computing the same
split must agree exactly, or they will disagree about what is owed.

**Invariants.**

1. `sum(all shares including payer) == total` **exactly**, for every input. No epsilon.
2. No share is negative.
3. Equal weights yield shares differing by at most one minor unit.
4. Deterministic and independent of member array ordering.
5. Reordering members permutes the shares but never changes the multiset of values.
6. Adding a member with weight zero changes nobody else's share.

**Deliverables.** The corrected algorithm, a documented rounding policy, and
property-based tests over generated member counts (1 to 50), weights (including zero and
fractional), and totals — asserting every invariant, not sampling a few cases.

**Explicitly not specified.** The apportionment method; who absorbs the remainder;
whether the policy is configurable.

---

## Issue #50: Make settlement recording exactly-once under concurrency and crashes

**Directory:** `hooks/`, `lib/`, `supabase-setup.sql`
**Type:** Correctness, distributed systems
**Difficulty:** Very hard — 1 to 2 weeks
**Prerequisites:** Idempotency, distributed transactions, outbox pattern, optimistic concurrency
**Design note required.**

**The problem.**

Settlement spans four systems that can each fail independently: Horizon (the payment),
Soroban (the record), Supabase (the app state), and localStorage (the retry record). The
current flow submits to Horizon, then verifies, then records on Soroban, then marks the
share paid in Supabase — with a localStorage retry record papering over the gap.

Every seam is a lost-money window. If the browser closes between the Horizon submit and
the Supabase write, the payment happened and the app does not know. If two members open
the same trip and settle simultaneously, `markSharePaidRow` re-reads `shares` before
writing — which narrows the race but does not close it, because the read and the write
are not atomic.

`lib/utils/pendingOnChain.ts` is per-browser. Clear site data and the retry is gone along
with the knowledge that money moved.

**Why this is hard.**

There is no distributed transaction available across Horizon, Soroban, and Postgres, so
you cannot make this atomic. You have to make it *convergent*: every partial failure must
be detectable and recoverable by any client, not just the one that started it.

That means durable intent recorded before the irreversible step, an idempotency key that
survives retries from different devices, and a reconciliation path that can look at chain
state and repair app state. It also means deciding what is authoritative when Supabase and
the chain disagree — and the answer must be the chain, which means writing the code that
believes it.

Concurrent JSONB updates to `shares` need real concurrency control. Postgres offers
several options; picking one and defending it is part of the work.

**Invariants.**

1. A payment that lands on Horizon is eventually reflected in app state, regardless of
   which client observes it or whether the originating browser ever returns.
2. No double-payment: retrying a settlement never produces a second transfer.
3. Two clients settling the same share concurrently produce at most one payment.
4. No lost updates on `shares` under concurrent writes.
5. Recovery requires no localStorage — a user on a fresh device converges to correct
   state.
6. Reconciliation is idempotent.

**Deliverables.** A durable intent mechanism, an idempotency scheme, concurrency control
on the JSONB write, a reconciliation path, and tests that *simulate* concurrent settlement
and crash-at-each-step — not just unit tests of the happy path.

**Explicitly not specified.** Where intent is stored; the idempotency key derivation;
optimistic versus pessimistic concurrency; whether reconciliation is client-driven,
server-driven, or both.

---

## Issue #51: Stop concurrent expense edits from silently destroying each other

**Directory:** `lib/supabase/`, `context/`, `hooks/`
**Type:** Correctness, distributed systems
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Concurrent editing, conflict resolution, realtime sync
**Design note required.**

**The problem.**

`expenses.members` and `expenses.shares` are JSONB blobs, and the RLS policy lets **any
member** update the row. `lib/supabase/useRealtimeCollection.ts` subscribes to
`postgres_changes` and replaces local state with whatever arrives.

So two members editing the same expense is last-write-wins over the entire blob. If one
adds a member while the other corrects the amount, one edit vanishes with no error, no
conflict indicator, and no way to recover it. Both users believe their change was saved.
Realtime makes this *more* likely, not less, because both are looking at the expense at
the same time.

**Why this is hard.**

Field-level merge is not sufficient, because `members` and `shares` are coupled: changing
members must recompute shares, so merging a member addition with a share edit can produce
an internally inconsistent expense where shares do not sum to the total.

You also cannot merge freely once money has moved. A share with a `txHash` is settled and
must never be recomputed by a merge — the money is gone and the record must match it.

And the realtime channel delivers events out of order relative to your own optimistic
writes, so the client needs to distinguish "my write echoed back" from "someone else's
write" without flickering.

**Invariants.**

1. No committed edit is silently discarded. Either it applies, or the user is told it
   could not.
2. A settled share is never modified by conflict resolution.
3. Post-merge, `sum(shares) == total` still holds.
4. An expense never renders in a state that never existed on the server.
5. Convergence: all clients observing the same event sequence reach identical state.

**Deliverables.** A conflict detection and resolution strategy, whatever schema support
it needs (idempotently added), realtime integration that handles self-echo and
out-of-order delivery, and tests simulating concurrent edits including the
member-plus-amount case and the settled-share case.

**Explicitly not specified.** Versioning versus CRDT versus operational transform;
whether conflicts auto-merge or prompt; how the UI surfaces a rejected edit.

---

## Issue #52: Make wallet authentication safe on more than one server instance

**Directory:** `lib/auth/`, `app/api/auth/`
**Type:** Security, backend
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** Replay attacks, distributed state, atomic operations, rate limiting
**Design note required.**

**The problem.**

`lib/auth/challengeStore.ts` stores issued auth challenges in a `Map` on `globalThis`.
Its own docstring admits this is not multi-instance safe. The app deploys to Vercel,
which is multi-instance by construction.

The consequence is concrete: `/api/auth/challenge` issues a nonce on instance A;
`/api/auth/verify` consumes it on instance B, which has never seen it. Depending on how
the miss is handled, that is either a broken login or — worse — a challenge that can be
replayed against every instance that has not recorded the burn. The single-use guarantee
that makes signature auth safe does not hold.

There is no rate limiting on either endpoint.

**Why this is hard.**

Consuming a challenge must be **atomic** — check-then-delete across a network round trip
is a race that lets two concurrent verifies both succeed on one nonce. You need an
atomic compare-and-delete, which constrains your storage choice.

The current store also has a 10,000-entry cap with FIFO eviction, meaning an attacker can
flush legitimate pending challenges by requesting 10,000 of their own. Whatever replaces
it needs a bound that is not weaponizable.

And it must degrade sensibly: if the shared store is unreachable, failing closed locks
everyone out, and failing open removes replay protection entirely. Neither is acceptable
as a silent default.

**Invariants.**

1. A challenge is consumable exactly once, globally, across all instances and under
   concurrent verification attempts.
2. Expired challenges are unusable and eventually reclaimed.
3. An attacker cannot evict another user's pending challenge by generating load.
4. Rate limits apply per-address and per-source and cannot be trivially bypassed.
5. Store unavailability produces an explicit, logged, deliberate failure mode — never a
   silent downgrade of replay protection.

**Deliverables.** A multi-instance-safe store with atomic consume, non-weaponizable
bounds, rate limiting on both endpoints, and tests covering concurrent consumption of one
nonce, cross-instance issue-and-verify, and eviction abuse.

**Explicitly not specified.** The backing store; the rate-limit algorithm and thresholds;
the unavailability policy.

---

## Issue #53: Give the app a real database migration story

**Directory:** `supabase-setup.sql`, `scripts/`, `docs/`
**Type:** Infrastructure, data
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Schema migration, zero-downtime deploys, Postgres DDL
**Design note required.**

**The problem.**

There is no migrations directory. `supabase-setup.sql` is a single 423-line file that an
operator pastes into the Supabase SQL Editor, containing table creation, a `DO $migrate$`
block of `ALTER`s, triggers, RLS policies, grants, and realtime registration — all
guarded by `IF NOT EXISTS` to stay re-runnable.

It works, and it will not keep working. There is no record of which version a given
database is at, no way to verify a database matches what the code expects, no rollback,
and no way for two contributors to add columns without conflicting. A member of this
epic's own scope — adding asset and FX columns — has to be appended to a growing
imperative blob and hope.

The trigger firing order currently depends on **alphabetical trigger names**
(`freeze_row_identity` before `sync_member_wallets` before `set_updated_at`). That is
load-bearing behaviour resting on a naming coincidence, and nothing documents or tests it.

**Why this is hard.**

Migrations must be introduced without breaking existing deployed databases, which are at
an unknown state and were provisioned by pasting a file. You need to derive a baseline
from a database you cannot inspect, and make the first migration a no-op for anyone
already current while still working on a fresh one.

RLS policies and triggers are not additive the way columns are — the current file drops
and recreates every policy, which is fine imperatively and hostile to versioned
migrations. And Supabase-hosted Postgres restricts some DDL, so the mechanism has to work
within what the platform actually permits.

**Invariants.**

1. An existing production database converges to the same schema as a fresh one, with no
   data loss.
2. Migrations are idempotent and record what has been applied.
3. A schema-version check can tell an operator their database does not match the code,
   before it fails at runtime.
4. Trigger execution order is explicit and asserted by a test, not inherited from naming.
5. Two contributors can add migrations in parallel without silent conflict.

**Deliverables.** A migration mechanism, a baseline derived from the current schema, a
verification command wired into `npm run db:check`, a documented rollback story, and a
test asserting trigger order.

**Explicitly not specified.** Tooling versus hand-rolled; migration naming; whether
rollback is automated or documented.

---

## Issue #54: Price bills in real currency without inventing a number

**Directory:** `lib/fx/`, `app/api/`
**Type:** Feature, backend
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Rate aggregation, caching, circuit breakers, oracle failure modes
**Seam:** S4
**Design note required.**

**The problem.**

Nobody prices a dinner in XLM. Until a user can type "1200 INR", this is a crypto demo
rather than an expense app. That needs an exchange rate, and a rate is a claim about the
world that can be wrong, stale, manipulated, or unavailable.

**Why this is hard.**

Rate sourcing is where this becomes a real system rather than a `fetch`:

- **Every source can fail**, and the failure modes differ. A REST API returns 500. The
  Stellar DEX returns a path through a book so thin the price is meaningless. A cached
  value goes stale silently — the worst failure, because it looks like success.
- **Testnet has effectively no XLM/USDC liquidity.** Any design that depends on
  on-chain pricing is undemoable on the network where all development happens. Solve this
  without making testnet a special case that hides bugs in production code.
- **A thin book is manipulable.** Deriving a price from a DEX order book means someone
  can move it. Quoting a large notional rather than a unit mitigates this; understanding
  why is the point.
- **Cache stampede.** Twenty form mounts must not become twenty upstream calls.
- **Fiat and crypto rates have different natural freshness.** ECB publishes daily; XLM
  moves by the second. One TTL for both is wrong in one direction or the other.

The hardest requirement is the last invariant: this must never block expense creation.
A rate service that takes the app down when a third party has an outage is worse than no
rate service.

**Invariants.**

1. Rate unavailability **never** blocks expense creation. The degraded path is a designed
   state, not an error branch.
2. A stale value is served only when explicitly marked stale, with its age available to
   the caller. Never silently.
3. N concurrent identical requests produce at most one upstream call.
4. A failing provider is bypassed without repeatedly paying its timeout.
5. No credential ever reaches the client bundle.
6. Every quote carries provenance: which source, at what time.

**Deliverables.** The S4 seam, a multi-source provider chain with failover, caching with
distinct freshness policies, stampede protection, a circuit breaker, and tests covering
each provider failing independently, stale-serve, concurrent collapse, and breaker
open/close transitions.

**Explicitly not specified.** Which providers; TTLs and staleness bounds; breaker
thresholds; how testnet is handled without special-casing production logic.

---

## Issue #55: Freeze the exchange rate so a debt cannot be rewritten after the fact

**Directory:** `supabase-setup.sql`, `lib/supabase/`, `components/`
**Type:** Security, feature
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** Postgres triggers, RLS, adversarial reasoning
**Seam:** S4

**The problem.**

Once a bill is entered in fiat, the app stores a conversion rate. That rate determines
what everyone owes — and the `expenses_update_members` RLS policy lets **any member of
the expense** UPDATE the row.

So without further protection, any member can rewrite the locked rate after everyone
agreed to it, silently changing what every other member owes. RLS will permit it, because
permitting member edits is the policy's entire purpose. This is the most direct
money-stealing path in the application.

Application-side validation is not a defence. The client talks to PostgREST directly with
its own JWT; anything enforced only in TypeScript is advisory.

**Why this is hard.**

`public.freeze_row_identity()` already exists and freezes `id`, `created_at`, and
`created_by_wallet`. Extending it sounds trivial until you consider that it must work on
databases at either schema version, that its firing order relative to
`sync_member_wallets` is load-bearing and currently depends on alphabetical naming, and
that over-freezing breaks the legitimate flow where a member marks their own share paid.

You must also settle a genuine product question and defend it: **which figure is
authoritative when the market moves?** If fiat is authoritative, the amount owed changes
between agreement and settlement, which is the exact problem fiat pricing was meant to
fix, and `verifyPaymentTransaction` has no fixed amount to compare against. If the asset
amount is authoritative, a bill agreed as ₹1,200 may settle for materially less real
value, and the UI has to be honest about that rather than hiding it.

**Invariants.**

1. No member — creator included — can alter a stored rate or its provenance after
   creation, via any client, including direct PostgREST calls.
2. Marking a share paid still works for any member. The existing flow does not regress.
3. A partial rate snapshot cannot exist: amount, rate, currency, and timestamp are
   all-or-nothing.
4. The authoritative figure is documented, enforced consistently, and shown to users
   without ambiguity.
5. Enforcement is at the database level.

**Deliverables.** Idempotent schema and trigger changes, the data-layer changes that stop
sending frozen fields, UI that presents locked versus current value honestly, and an
adversarial test in `scripts/check-supabase.mjs` that *attempts* the rewrite from a
non-creator member and asserts the value is unchanged.

**Explicitly not specified.** Which figure is authoritative; how drift is surfaced;
whether correction is possible and how.

---

## Issue #56: Remove the production wallet bypass and write the threat model

**Directory:** `lib/stellar/`, `context/`, `docs/`
**Type:** Security
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** Threat modelling, browser security, supply chain risk
**Design note required.**

**The problem.**

`lib/stellar/walletsKit.ts` short-circuits the entire wallet layer on the presence of
`window.__E2E_WALLET__`, with **no** `NODE_ENV` guard. The docstring says this is
deliberate, so Playwright can reuse a dev server. It also ships in the production bundle.

The consequences are specific: `freighterGetAddress` returns the injected address without
consulting Freighter, `freighterSign` delegates signing to injected code, and
`WalletContext.connect` skips the wallet modal and writes the injected address to
localStorage. Any script that reaches the page — an extension, an XSS, a compromised
dependency — drives the wallet layer and controls what the UI believes about identity.

Server-side `/api/auth/verify` still demands a real signature, so this is not a full auth
bypass. It is a UI-state impersonation primitive shipping to production, and it is
exactly the kind of thing that turns a small XSS into a large incident.

**Why this is hard.**

The easy fix — a `NODE_ENV` check — breaks the E2E suite it exists for, so you must first
understand why the current approach was chosen and design a test seam that does not
require a production backdoor. That means reasoning about how Playwright drives a built
app versus a dev server.

The larger deliverable is the threat model this codebase does not have. `docs/SECURITY.md`
exists but does not enumerate trust boundaries. You are asked to write one for a
non-custodial app where the client is hostile: what an attacker with script execution can
do, what a malicious group member can do, what a compromised dependency can do, and which
of those the architecture actually defends against.

**Invariants.**

1. No production build contains a code path that bypasses real wallet signing.
2. The E2E suite still runs, including against a production-mode build.
3. Every trust boundary is documented with what is trusted, by whom, and why.
4. Each identified threat is either mitigated, accepted with a written rationale, or
   tracked.

**Deliverables.** Removal of the production bypass, a test seam that does not weaken
production, a threat model in `docs/`, and a security test asserting the bypass is absent
from a production build.

**Explicitly not specified.** The test seam mechanism; threat model format; where the
accepted-risk line sits.

---

## Issue #57: Make the trustline lifecycle correct, including the reserve math

**Directory:** `lib/stellar/`, `hooks/`, `components/`
**Type:** Feature, protocol, UX
**Difficulty:** Hard — 5 to 7 days
**Prerequisites:** Base reserves, subentries, trustline flags, sponsorship
**Seam:** S1

**The problem.**

An account cannot receive an asset it has not opted into. Today the app cannot detect a
missing trustline, cannot add one, and surfaces the resulting failure as a raw Horizon
`op_no_trust`. For anyone not already a Stellar native, that is where they stop.

**Why this is hard.**

The reserve math is the part that gets skipped and it is the part that fails in
production. Each subentry raises the account's minimum balance by the base reserve
(currently 0.5 XLM, but it is a **network parameter that can change** — reading it from
the ledger is correct, hardcoding it is a latent bug). That XLM is locked, not spent, and
the distinction matters to a user watching their balance.

So "can this account add a trustline?" is not `balance > 0.5`. It is a function of
balance, current subentry count, base reserve, existing sponsorships, and pending
liabilities from open offers. Getting it wrong means telling a user to try, and watching
them fail.

Then the state space is larger than present/absent: the account may not exist at all;
the trustline may exist but be unauthorized for an `AUTH_REQUIRED` asset; it may be
authorized-to-maintain-liabilities only; it may be at its limit; it may be sponsored by
someone else. Each needs a different message and a different action.

**Invariants.**

1. Reserve requirement is computed from live ledger parameters, never hardcoded.
2. The check accounts for existing subentries, sponsorship, and liabilities.
3. Every distinct state — no account, no trustline, unauthorized, at limit, sponsored —
   is distinguishable and produces its own actionable message.
4. The reserve increase is disclosed before signing, framed as locked rather than spent.
5. A user who cannot afford the reserve is told so before attempting, not after failing.
6. Native XLM never prompts for a trustline.

**Deliverables.** Trustline state detection covering the full state space, reserve
computation from ledger parameters, an in-app add flow, and tests covering each state
including insufficient-reserve and auth-required.

**Explicitly not specified.** Whether to offer sponsorship for users who cannot afford it
(see #45); trust limit policy; UI placement.

---

## Issue #58: Settle mixed-asset trips without ever inventing a number

**Directory:** `lib/settlement/`, `hooks/`, `components/trips/`
**Type:** Bug, feature
**Difficulty:** Hard — 5 to 7 days
**Prerequisites:** Multi-asset accounting, the S5 debt graph
**Seam:** S1, S5

**The problem.**

`hooks/useNetPayment.ts` collapses a trip's entire debt list into a single
`totalAmountXlm` and sends it as one payment. `computeNetPayments` groups only by
`(from, to)`. Neither knows what an asset is.

Introduce a second asset without fixing this and the app adds USDC to XLM, displays the
sum, and sends it as one asset. That is not a display bug — it moves the wrong amount of
real value. It is the most dangerous single line in this epic.

**Why this is hard.**

Correctness is only the floor. Above it sit real product questions with no obvious answer:

- If Ana owes Ben 20 USDC and Ben owes Ana 50 XLM, are they settled? Only if you convert,
  and converting means picking a rate, and picking a rate means someone bears the
  spread and the timing risk. Doing it silently is unacceptable; refusing entirely leaves
  obviously-offsetting debts outstanding.
- If cross-asset netting is offered, both parties must consent to the rate, which is a
  consent flow, not a calculation.
- Path payments (#44) make "settle a USDC debt using XLM" possible without netting at
  all, which may be the better answer — but only if the payer accepts the slippage.

You must decide what this product does, and defend it. "Never cross assets" is a
completely acceptable answer if argued.

**Invariants.**

1. Amounts in different assets are never summed. Not in a total, not in a stat card, not
   in a settle button.
2. Each transfer is denominated in exactly one asset and independently verifiable.
3. If cross-asset netting is offered at all, the rate is explicit, timestamped, and
   affirmatively consented to by both parties.
4. A single-asset trip behaves exactly as today — no new UI noise for the common case.
5. Every displayed total is either per-asset or an explicitly-labelled conversion, never
   an implicit mix.

**Deliverables.** Asset-aware netting, per-asset settlement flows, corrected totals
everywhere they are computed (dashboard, trip header, cards), and tests asserting no
cross-asset sum can occur — including a regression test for the specific bug above.

**Explicitly not specified.** Whether cross-asset netting is offered; the consent flow;
how mixed totals are presented.

---

## Issue #59: Make on-chain reconciliation correct and complete

**Directory:** `lib/stellar/`, `hooks/`
**Type:** Correctness, protocol
**Difficulty:** Hard — 5 to 7 days
**Prerequisites:** Soroban events, RPC retention, pagination, ledger semantics

**The problem.**

`lib/stellar/events.ts` polls Soroban RPC `getEvents` every 10 seconds with a 600-ledger
lookback and 200-per-page pagination, and the app matches those events back to expenses
to decide what is settled on-chain.

Two problems. First, matching is not precise enough: `buildPaymentEventKey` does not
include the asset, so once assets vary, a 10 USDC payment and a 10 XLM payment on the same
expense collide and one falsely displays as settled. Second, and more fundamental,
**Soroban RPC retains events for a limited window** — roughly 24 hours on public
infrastructure. A 600-ledger lookback is about an hour. Any trip older than the retention
window cannot be reconciled from events at all, and the app has no other path: it simply
shows nothing and users conclude their payment was lost.

**Why this is hard.**

Events are a notification mechanism, not a database, and the app treats them as durable
history. Fixing this means designing reconciliation that works from contract *state*
(`get_payments`, which is durable but subject to storage TTL and archival) as well as
events, and reasoning about which is authoritative when they disagree.

`getContractPayments` already exists and is unit-tested but is called by nothing — the
durable path was built and never wired up.

Polling every 10 seconds per open trip also does not scale, and the visibility-change
refresh means a returning user triggers a burst.

**Invariants.**

1. Event matching is exact on expense, member, amount, **and** asset. No collisions.
2. A trip older than the RPC event retention window still reconciles correctly.
3. Reconciliation is idempotent and converges regardless of poll timing or missed events.
4. Pagination is exhaustive — an active trip never silently drops records past the page
   limit.
5. Archived or TTL-expired contract state is handled explicitly, not assumed present.
6. Polling cost does not grow unbounded with open trips or returning users.

**Deliverables.** Precise matching, a state-based reconciliation path alongside events,
a documented authority rule for disagreements, bounded polling, and tests covering
retention expiry, pagination overflow, and event/state disagreement.

**Explicitly not specified.** State versus event authority; polling strategy; whether to
cache reconciled results and where.

---

## Issue #60: Make the app survive going to mainnet

**Directory:** `lib/utils/`, `context/`, `components/`, `docs/`
**Type:** Infrastructure, safety
**Difficulty:** Hard — 5 to 7 days
**Prerequisites:** Stellar network semantics, configuration safety, operational readiness
**Design note required.**

**The problem.**

`components/landing/Pricing.tsx` advertises mainnet as "Coming Soon". The app is not
close, and the gaps are the kind that cost money rather than break builds.

`lib/utils/constants.ts` derives `NETWORK_PASSPHRASE` from `STELLAR_NETWORK`, but
`HORIZON_URL`, `SOROBAN_RPC_URL`, and `STELLAR_EXPLORER` are **independent** environment
variables that each default to testnet. Set `STELLAR_NETWORK=PUBLIC` and forget one, and
the app signs mainnet-passphrase transactions against testnet infrastructure, or shows
mainnet transactions on a testnet explorer, or worse.

`context/WalletContext.tsx` reads the wallet's network and then ignores a mismatch. A
user whose Freighter is on testnet, using an app configured for mainnet, gets no warning
at all.

`components/expenses/ReceiptModal.tsx` hardcodes the string "Stellar Testnet" — on
mainnet, the receipt is simply false.

**Why this is hard.**

Configuration correctness cannot be a documentation problem when the failure mode is
lost funds. It has to be structurally impossible to get into an inconsistent state, which
means deriving what can be derived, validating what cannot, and failing loudly at startup
rather than at signing time.

Mainnet also changes the risk profile of things that are fine on testnet: fee strategy
under surge (`TX_BASE_FEE` is hardcoded at 100 stroops, which will fail when the network
is congested), reserve requirements against real balances, and the absence of a faucet to
recover from mistakes.

Then there is the operational half. There is no deploy workflow, no error reporting, no
alerting, and `console.error` is where errors go to die. Running an app that moves real
money with no observability is the actual blocker, and it is not a code change.

**Invariants.**

1. Network configuration is internally consistent by construction, or the app refuses to
   start with a specific, actionable message.
2. A wallet on a different network than the app is detected and blocked from signing,
   with a clear explanation.
3. No user-facing string hardcodes a network name.
4. Fee strategy adapts to observed network conditions rather than a fixed constant.
5. A failed money-path operation produces a diagnosable record somewhere a maintainer
   will actually see it.

**Deliverables.** Configuration derivation and startup validation, network mismatch
detection and blocking, adaptive fees, error reporting for the money path, a mainnet
readiness checklist in `docs/`, and tests for each inconsistent-configuration case.

**Explicitly not specified.** Error reporting vendor or approach; fee strategy; whether
mismatch blocks or warns.

---

## Issue #61: Build a property-based test harness for the money path

**Directory:** `__tests__/`, `jest.config.js`
**Type:** Testing, infrastructure
**Difficulty:** Hard — 5 to 7 days
**Prerequisites:** Property-based testing, generators, shrinking, invariant design

**The problem.**

There are 28 test files and roughly 324 assertions, and they are almost all
example-based: given these three members and this amount, expect that result. Example
tests find the bugs you thought of. The money bugs in this codebase — rounding drift
across N members, cross-asset summation, ordering dependence, concurrent lost updates —
are the ones nobody thought of.

Coverage is also misleading. `jest.config.js` sets a 30% threshold, collects only from
`lib/**/*.ts`, and **excludes `lib/supabase/**` entirely** — which is the module that owns
every read and write in the application. `app/`, `components/`, `hooks/`, and `context/`
are never measured despite having tests.

**Why this is hard.**

Writing good generators is genuinely difficult. A naive generator produces uninteresting
cases: three members, round amounts, no edge conditions. A good one biases toward
boundaries — zero weights, single members, 50 members, amounts at the 7-decimal limit,
amounts at `MAX_AMOUNT_STROOPS`, duplicate wallets, self-payment, empty groups.

The harder part is designing invariants that are strong enough to catch real bugs and
true enough not to produce false failures. "Shares sum to total" is easy. "Simplification
preserves every participant's net position across an arbitrary graph with cycles, mixed
assets, and partial settlement" is the one that finds things — and stating it precisely is
most of the work.

Shrinking matters too: an unshrunk 50-member counterexample is unreadable, and a report
nobody can act on is not a passing gift to the next contributor.

**Invariants (of the harness itself).**

1. Generators produce boundary cases at meaningful frequency, demonstrably — not by
   assertion.
2. A discovered failure shrinks to a minimal reproducible case.
3. Failures are deterministic and replayable from a seed printed in the output.
4. The suite runs in CI within a sensible time budget.
5. Coverage configuration measures the code that actually handles money, including
   `lib/supabase/**`.

**Deliverables.** A generator library for the domain (members, weights, amounts, assets,
debt graphs, settlement states), invariant suites for split, netting, simplification, and
money arithmetic, seeded replay, corrected coverage configuration, and a documented guide
for adding new properties.

**Explicitly not specified.** The property-testing library; generator design; coverage
thresholds; the CI time budget.

---

## Issue #62: Make the app fail visibly instead of silently

**Directory:** `app/`, `components/`, `lib/`
**Type:** Reliability, UX
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** React error boundaries, App Router conventions, failure taxonomy

**The problem.**

There is no error boundary anywhere in the codebase — zero matches for `ErrorBoundary`,
`componentDidCatch`, or `getDerivedStateFromError`. There is no `error.tsx`,
`global-error.tsx`, or `loading.tsx` at any level of `app/`. Only `not-found.tsx` exists.
Any render-time throw shows the raw Next.js error screen, and in production that is a
blank page.

Error handling terminates in 16 `console.error` calls. `next.config.mjs` deliberately
preserves `error` and `warn` in production, and nothing collects them.

There is also a specific bug of this shape: `app/trips/[id]/page.tsx` destructures
`useTrip()` **without** `isLoading`, then renders `TripNotFound` whenever `trip` is
falsy. On a cold load with no cache, users see a false "Trip not found" before the data
arrives. The other three pages gate on `isLoading`; this one was missed.

**Why this is hard.**

A generic "something went wrong" boundary is worse than useless in an app that moves
money, because the correct user action differs completely by failure class. A wallet
rejection is not an error. A Horizon timeout after submission means *the payment may have
succeeded* and the user must not retry blindly. An RLS denial means a permissions problem
no retry will fix. A schema mismatch (`PGRST205`) means the operator has not run the setup
SQL. Each needs different copy and a different affordance.

`lib/supabase/queries.ts` already has a typed `DatabaseError` with PostgREST code
translation, and `lib/stellar/submitTransaction.ts` maps Horizon result codes. The
taxonomy exists in fragments and is nowhere unified.

The genuinely hard case is the one where recovery is ambiguous: submitted to Horizon,
no response. Showing "failed" invites a double-payment. Showing "success" may be a lie.

**Invariants.**

1. No unhandled render throw reaches the user as a blank page or a stack trace.
2. Every error class maps to a distinct message and a correct affordance. Retry is
   offered **only** where retrying is safe.
3. An ambiguous money-path outcome is never presented as either definite success or
   definite failure.
4. Loading and empty states are distinguishable from error states everywhere — including
   the trip detail page.
5. Errors reach somewhere a maintainer can see them.

**Deliverables.** A unified error taxonomy, boundaries and App Router error/loading
conventions, correct affordances per class, the trip-detail loading fix, and tests for
each class including the ambiguous-submission case.

**Explicitly not specified.** Taxonomy structure; boundary granularity; reporting
destination; ambiguous-outcome copy.

---

## Issue #63: Render money correctly for people who are not you

**Directory:** `components/ui/`, `lib/money/`, `components/`
**Type:** Feature, i18n, UX
**Difficulty:** Hard — 4 to 6 days
**Prerequisites:** `Intl.NumberFormat`, currency conventions, accessibility
**Seam:** S2

**The problem.**

Money is formatted ad hoc throughout the app, mostly `toFixed(4)` with `"XLM"`
concatenated. `components/dashboard/DashboardStats.tsx` uses `toFixed(2)`,
`components/payment/PayButton.tsx` uses `toFixed(4)`, and `lib/split/calculator.ts` emits
7 decimals. Three precisions for the same quantity, and the asset label is a literal.

Once assets vary, every one of those is a place a user can be shown the wrong ticker next
to a real amount — and someone who reads "25 XLM" when they owe 25 USDC sends roughly a
hundredth of what they meant to.

**Why this is hard.**

Currency formatting is a genuine minefield and the naive version is wrong for most of the
world. Decimal and grouping separators differ by locale (`1.234,56` in much of Europe).
Indian grouping is not by thousands — ₹12,34,567 is correct and no naive formatter
produces it. JPY has **zero** decimal places; formatting it with two is wrong. Symbol
placement, spacing, and negative-number conventions all vary.

Crypto has its own problems: 7 decimals is unreadable, but truncating for display while
transacting the full precision means what is shown differs from what is signed — which is
unacceptable on a confirmation screen. Rounding a *displayed* total independently of its
components produces visible arithmetic errors where a column does not add up.

Accessibility matters too: a screen reader announcing "42.7000000" is not useful, and
colour alone cannot distinguish owed from owing.

**Invariants.**

1. One formatting implementation. No component formats money itself.
2. Locale-correct separators, grouping (including Indian), and symbol placement.
3. Per-currency decimals respected — JPY renders zero, USD two, XLM its own convention.
4. Any confirmation screen shows the exact value being signed, never a rounded one.
5. Displayed component values always sum to the displayed total.
6. Screen-reader output is intelligible, and no state is conveyed by colour alone.

**Deliverables.** A single money display component built on the S2 seam, adoption across
every component currently formatting money, locale handling, and tests covering
en-US/de-DE/hi-IN/ja-JP, JPY zero-decimal, the sum-consistency invariant, and a11y
assertions.

**Explicitly not specified.** Locale detection; display precision policy; how full
precision is exposed.

---

## Issue #64: Test against a live network, not only mocks

**Directory:** `e2e/`, `scripts/`, `.github/workflows/`
**Type:** Testing, infrastructure
**Difficulty:** Hard — 5 to 8 days
**Prerequisites:** Playwright, testnet operations, flaky-test management, CI design

**The problem.**

`e2e/authenticated-flows.spec.ts` drives a mock wallet injected via `window.__E2E_WALLET__`
and never touches Stellar. So the E2E suite has never verified that a payment actually
submits, that a transaction is accepted by Horizon, that a contract call succeeds, or that
a QR code is parseable by a real wallet. The parts most likely to break are the parts
never exercised.

CI runs Playwright on Chromium only, so the three other desktop projects and both mobile
projects in `playwright.config.ts` never execute.

**Why this is hard.**

Testing against a live network fights determinism, which is why almost nobody does it
properly. Testnet accounts need funding and Friendbot rate-limits. Testnet is
periodically reset, destroying every account and contract. Transactions take seconds and
occasionally fail for network reasons unrelated to your change. Contract state persists
between runs, so tests are not independent unless you make them so. A suite that fails
20% of the time for environmental reasons gets ignored, and an ignored suite is worse than
none.

So the real work is isolating genuine failures from environmental noise: fixtures that
provision and tear down accounts, retry policies that distinguish flake from bug, and a
CI design where an infrastructure outage does not read as a code regression.

**Invariants.**

1. At least one test path exercises real submission to Horizon and a real contract call.
2. Tests are independent — any order, any subset, repeatable without manual cleanup.
3. Environmental failure is distinguishable from assertion failure in CI output.
4. Suite runtime stays within a budget that keeps it in the normal PR loop.
5. A testnet reset is a recoverable, documented condition, not a mystery red build.
6. Mobile and cross-browser projects actually run somewhere.

**Deliverables.** Live-network fixtures with provisioning and teardown, at least one
full settlement path end to end, flake isolation, CI wiring that runs the full project
matrix on a sensible cadence, and a documented recovery procedure for testnet resets.

**Explicitly not specified.** Funding strategy; which paths go live versus mocked; retry
policy; CI cadence.

---

## Issue #65: Let people join a group without pasting a 56-character key

**Directory:** `app/`, `components/`, `supabase-setup.sql`, `lib/supabase/`
**Type:** Feature, UX, security
**Difficulty:** Hard — 1 to 2 weeks
**Prerequisites:** Invitation tokens, RLS design, capability security
**Design note required.**

**The problem.**

`hooks/useExpenseForm.ts` requires a valid `G...` address for every member before an
expense can be saved — the error reads "Stellar address is required to enable payments."
So you cannot add a friend to a trip until they have installed a wallet, created an
account, and sent you 56 characters.

That is the single largest adoption blocker in the product. Every competitor lets you add
someone by name and settle up later.

**Why this is hard.**

The whole authorization model assumes wallet addresses. `member_wallets` is derived by a
trigger and is the array every RLS policy checks with `@>` containment. A member without
a wallet has nothing to put in that array, so they cannot be granted access by the
existing mechanism — and inventing a second mechanism means two authorization paths, which
is how privilege escalation bugs are born.

An invite link is a **capability**: whoever holds it gains access. That needs unguessable
tokens, expiry, revocation, single- or bounded-use semantics, and resistance to someone
who obtains a link claiming the wrong member slot. Getting it wrong grants a stranger read
access to a group's entire financial history.

Then there is identity reconciliation. A placeholder member accrues shares; later a real
wallet attaches and must inherit exactly those shares — no more, no fewer — and the
attachment must be verified, not asserted. Two people must not be able to claim the same
slot, and a claim must be idempotent under retry.

RLS performance matters too: the current policies use `@>` specifically so the GIN indexes
are usable. Any new access path must not force a sequential scan.

**Invariants.**

1. A member can be added with no wallet address, and shares assigned to them are
   preserved exactly until claimed.
2. Holding an invite link grants access **only** to the intended group, at the intended
   level.
3. A member slot can be claimed at most once. Concurrent claims resolve to exactly one
   winner.
4. Claiming is verified against wallet control, never asserted by the client.
5. Invites are revocable and expire; revocation takes effect immediately.
6. Authorization remains a single mechanism, and RLS policies remain index-usable.
7. A wallet-less member never blocks other members from settling among themselves.

**Deliverables.** Schema and RLS changes, token generation and validation, the claim flow
with concurrency handling, revocation, form changes making the address optional, and an
adversarial test suite covering forged tokens, double-claim races, cross-group access,
and post-revocation use.

**Explicitly not specified.** Token scheme; whether placeholders are rows or JSONB
entries; the claim UX; expiry defaults.

---

## Issue #66: Prove the settlement path is correct with an executable specification

**Directory:** `docs/`, `__tests__/`
**Type:** Verification, documentation
**Difficulty:** Very hard — 1 to 2 weeks
**Prerequisites:** State machines, model-based testing, formal specification
**Design note required.**

**The problem.**

Settlement spans four independent systems, five or more failure points, and at least a
dozen states. Nobody can currently answer "what are all the states a share can be in, and
which transitions are legal?" — the answer is spread across `hooks/usePayment.ts`,
`hooks/useNetPayment.ts`, `lib/utils/pendingOnChain.ts`, and the contract.

`PaymentState` is a union of nine variants, but the *transitions* are implicit in
control flow, and the interesting states are combinations across systems: paid on Horizon
but not recorded on Soroban, recorded on Soroban but not in Supabase, marked paid locally
but never submitted. Several of those are reachable today. Nobody has enumerated them.

This is the capstone. It is where the epic's correctness claims become checkable rather
than asserted.

**Why this is hard.**

You must first extract a model from code that was not written against one, and the model
has to be faithful — a model that omits the states where bugs live proves nothing. Then
you must decide what "correct" means as a property over the *whole* system rather than
any component: money conservation, no double-spend, eventual consistency between chain
and app state, and progress (no share can get permanently stuck with no path forward).

Then you connect the model to the implementation so it tests reality rather than a
parallel fiction. Model-based testing generates transition sequences and checks the real
system follows; keeping model and implementation in sync as both evolve is the part that
usually fails.

You are not asked to produce a machine-checked proof. You are asked for an explicit,
executable specification and honest documentation of what it does and does not cover.

**Invariants.**

1. Every reachable state of a share is enumerated, including cross-system combinations.
2. Every legal transition is specified; every unspecified transition is demonstrably
   unreachable or explicitly documented as a known gap.
3. Money conservation holds across every generated transition sequence.
4. Progress: no reachable state leaves a share permanently stuck with no recovery path.
5. The specification is executable and runs in CI — not prose that drifts.
6. Divergence between model and implementation fails a test, not a review.

**Deliverables.** A state model of the settlement lifecycle, an executable specification,
model-based tests generating and checking transition sequences, documentation of coverage
and known gaps, and CI integration.

**Explicitly not specified.** Modelling formalism; the model-based testing approach;
where the boundary of "the system" is drawn.

---

## Epic completion

No issue is complete without `npm test`, `npm run lint`, `npm run build`,
`npm run db:check`, `cargo test`, and `npm run test:e2e` passing, and every
*Design note required* issue shipping its document under `docs/`.

**Suggested entry points by background:**

| If you know | Start with |
|---|---|
| Rust / Soroban | #43, #42 |
| Algorithms | #49, #48 |
| Distributed systems | #50, #51 |
| Security | #56, #55, #52 |
| Stellar protocol | #44, #57, #45 |
| Frontend / UX | #63, #62 |
| Testing / infra | #61, #64, #53 |

Take one. Read the invariants twice. Write the design note before the code — for most of
these, the design *is* the work, and the implementation follows in an afternoon once the
thinking is done.
