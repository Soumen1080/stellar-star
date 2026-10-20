# Stellar-star — sequenced product and engineering backlog

**Purpose.** This is the proposed next-60-issues backlog for Stellar-star. It
starts with the work needed before real-money use, then improves the current
expense-sharing experience, and ends with optional product expansions. Issues
are deliberately sequenced: a later item should not be started before its
dependencies are complete.

**Conventions**

- **Priority:** P0 blocks safe production use; P1 is a near-term product need;
  P2 is a planned enhancement; P3 is an optional exploration.
- **Size:** S (up to 2 days), M (3–5 days), L (1–2 weeks), XL (multi-sprint).
- **Definition of done:** implementation, relevant unit/integration tests,
  accessible UI where applicable, updated documentation, and no regression in
  the existing payment path.
- Existing capabilities are not duplicated here: wallet authentication,
  invitations, equal/custom splits, real-time sync, path payments, and
  attested on-chain settlement are already present.

---

## Phase 1 — Production safety and operational foundations

### 001 — Establish a mainnet go/no-go gate

**Priority:** P0 · **Size:** M · **Depends on:** none

Create a single, auditable release gate for moving from testnet to public
network. The current mainnet-readiness document identifies the risks, but the
decision needs named owners, evidence links, and an explicit approval record.

**Acceptance criteria**

- `docs/MAINNET_READINESS.md` has a dated checklist for security, finance,
  support, contracts, monitoring, legal/privacy review, and rollback.
- Each item has an owner, status, proof link, and an expiry/review date.
- Production deployment is blocked in CI until required P0 checks pass.
- The release runbook documents who can approve, pause, and roll back a
  release.

### 002 — Validate production configuration in CI and at startup

**Priority:** P0 · **Size:** M · **Depends on:** 001

Turn network configuration validation into a mandatory deployment control.
The app already validates many client settings; this issue makes that check
unavoidable before a public deployment.

**Acceptance criteria**

- A CI command validates the selected network, Horizon, Soroban RPC, explorer,
  contract IDs, asset issuer values, and public app URL without printing
  secrets.
- CI rejects testnet endpoints or placeholder contract IDs in a production
  deployment.
- Startup exposes a clear, non-sensitive diagnostic when configuration is
  invalid and prevents payment actions.
- Tests cover valid testnet, valid public network, and cross-network failures.

### 003 — Add durable error monitoring and payment-path alerts

**Priority:** P0 · **Size:** M · **Depends on:** 001

Structured client errors are currently routable to a server endpoint. Connect
that seam to a durable monitoring provider and define alerting for failures
that may leave a user uncertain whether funds moved.

**Acceptance criteria**

- Capture payment submission, attestation, contract-recording, and
  reconciliation failures with a correlation ID and no secret/XDR payload.
- Alert an on-call channel for repeated failures, a spike in partial success,
  and unavailable critical services.
- Provide a runbook for investigating an alert from correlation ID to Stellar
  transaction and database record.
- Add a test or smoke check that verifies the reporter receives a redacted
  event.

### 004 — Back up Supabase data and rehearse recovery

**Priority:** P0 · **Size:** L · **Depends on:** 001

Expenses, memberships, invitations, session-related records, and settlement
intent state need a recovery story even though transfers are independently
verifiable on Stellar.

**Acceptance criteria**

- Automated, encrypted database backups have documented retention and access
  controls.
- Migration files, storage policies, and environment configuration can rebuild
  a clean staging environment.
- A restore drill proves that a sampled trip, expense history, invitation, and
  settlement intent recover correctly.
- The runbook defines recovery point/time objectives and a customer-facing
  incident communication template.

### 005 — Commission a security review and resolve findings

**Priority:** P0 · **Size:** XL · **Depends on:** 001–004

Perform an independent review of the Next.js API routes, Supabase RLS policies,
wallet authentication, settlement oracle, Soroban contracts, and deployment
configuration. This is not a substitute for automated tests.

**Acceptance criteria**

- Scope, threat model, reviewer, findings, severity, and remediation status
  are recorded privately or in a suitably redacted security report.
- P0/P1 findings are fixed and regression-tested before mainnet approval.
- A responsible-disclosure policy and security contact are published.
- Contract source, deployed WASM hash, and deployed contract IDs are verified
  and recorded for release.

### 006 — Define privacy, retention, and account-deletion behavior

**Priority:** P0 · **Size:** L · **Depends on:** 001

Wallet addresses are public on-chain, while names, trip descriptions, receipts,
and invitation data are application data. Users need an accurate explanation
and a way to remove data that can legally and technically be removed.

**Acceptance criteria**

- Publish a privacy notice that distinguishes immutable public-chain records
  from mutable application data.
- Define retention for accounts, audit logs, invitations, receipts, analytics,
  and backups.
- Implement an authenticated export/delete request flow; deletion removes or
  anonymizes off-chain personal data without pretending chain records vanish.
- Verify that deleted accounts cannot access data through stale sessions,
  realtime subscriptions, or storage URLs.

### 007 — Strengthen authorization tests for every data boundary

**Priority:** P0 · **Size:** L · **Depends on:** 004

Make trip and expense authorization provable at the database and API layers,
not just in UI guards. In particular, test creator, member, invitee, revoked
member, and unrelated-wallet scenarios.

**Acceptance criteria**

- Maintain an authorization matrix covering read, create, edit, delete,
  invite, claim, and settlement-intent actions.
- Add automated Supabase/RLS and route tests for both allowed and denied cases.
- Realtime subscriptions only expose rows visible to the authenticated wallet.
- All privileged service-role use is server-only and documented.

### 008 — Introduce idempotency keys for money-adjacent mutations

**Priority:** P0 · **Size:** L · **Depends on:** 007

Networks retry. A repeated click, browser reload, or API retry must not create
duplicate invitations, expenses, settlement intents, or notifications.

**Acceptance criteria**

- Mutating API routes accept an idempotency key tied to the authenticated
  wallet and request fingerprint.
- A duplicate request returns the first successful result rather than creating
  new records.
- Conflicting reuse of a key is rejected with a useful error.
- Database uniqueness constraints and tests cover concurrent duplicates.

### 009 — Build an automated on-chain reconciliation worker

**Priority:** P0 · **Size:** XL · **Depends on:** 003, 008

Move reconciliation beyond a user’s open browser tab. A server-side worker
should verify pending payments and resolve the states “not submitted,”
“submitted but not confirmed,” “confirmed but not recorded,” and “recorded.”

**Acceptance criteria**

- A durable queue or scheduled worker polls only the required accounts and
  transaction hashes with backoff and rate limits.
- It verifies destination, asset, amount, memo/intent, and ledger result before
  changing settlement state.
- It never marks an ambiguous payment paid; ambiguous records are escalated for
  review.
- Operators have a dashboard or queryable report of pending and failed
  reconciliations, with alert thresholds.

### 010 — Create an incident-response and support console

**Priority:** P1 · **Size:** L · **Depends on:** 003, 009

When a payment fails or is delayed, support needs one read-only view of the
expense, settlement intent, transaction hash, contract event, and timeline.

**Acceptance criteria**

- Authorized staff can search by transaction hash, wallet, trip ID, expense ID,
  or correlation ID.
- The console shows a redacted timeline and links to the correct network
  explorer without exposing secrets or editing financial state by default.
- Every staff lookup is audit logged.
- A documented, dual-control procedure exists for exceptional corrective
  actions.

---

## Phase 2 — Complete the expense-sharing experience

### 011 — Add safe expense editing with version conflict resolution

**Priority:** P1 · **Size:** L · **Depends on:** 007, 008

Users need to correct titles, amounts, payer, members, and split values before
settlement. Existing version/conflict infrastructure should become a visible,
safe workflow rather than silently overwriting another member’s changes.

**Acceptance criteria**

- Only authorized trip members can edit an unsettled expense.
- The editor displays the latest version and offers a clear reload/merge choice
  when a concurrent change is detected.
- Editing recomputes shares using exact money arithmetic and blocks an invalid
  total.
- Settled or partially settled amounts cannot be changed in place; see issue
  012 for the corrective flow.

### 012 — Add reversals and corrections instead of destructive edits

**Priority:** P1 · **Size:** L · **Depends on:** 011

Financial history should remain understandable after a mistake. Replace the
temptation to mutate or delete settled data with linked correction records.

**Acceptance criteria**

- A user can void an unsettled expense with an audit reason.
- A settled expense can be corrected only through a linked adjustment/offset
  that preserves the original amount and on-chain proof.
- Trip and settlement views show the effective balance and a readable history.
- Permission, arithmetic, and repeated-correction edge cases are tested.

### 013 — Add categories, tags, search, and filterable history

**Priority:** P1 · **Size:** M · **Depends on:** 011

As a trip grows, a chronological list becomes hard to use. Add lightweight
organization without changing the financial model.

**Acceptance criteria**

- Expenses support a category and zero or more normalized tags.
- History is searchable by title, description, member, tag, and transaction
  hash, and filterable by date, category, payer, settlement state, and asset.
- Filtering is server-side/paginated for large trips and preserves URL state.
- Keyboard and screen-reader users can operate all search/filter controls.

### 014 — Support receipt attachments with secure storage

**Priority:** P1 · **Size:** L · **Depends on:** 006, 007

Let a payer attach a bill, invoice, or receipt to an expense while keeping
private files out of the public repository and public blockchain.

**Acceptance criteria**

- Upload accepts an allowlisted file type, enforces size limits, and scans or
  quarantines unsafe content according to the chosen provider.
- Files are stored privately and accessed by short-lived signed URLs only after
  membership authorization.
- Metadata includes uploader, timestamp, checksum, and optional caption; it is
  removable under the retention policy.
- Mobile upload, access denial, and expired-link cases are tested.

### 015 — Add recurring expenses and scheduled drafts

**Priority:** P1 · **Size:** L · **Depends on:** 008, 011

Rent, utilities, and subscriptions repeat. Create recurring templates that
generate reviewable drafts, never unexpected blockchain transactions.

**Acceptance criteria**

- A template defines cadence, start/end dates, members, split, amount rule,
  category, and reminder preference.
- A scheduled job creates one idempotent draft per occurrence and records its
  source template.
- Users can pause, resume, skip, and edit future occurrences without changing
  history.
- Generated expenses require normal review/save; no wallet signature is
  requested automatically.

### 016 — Add trip budgets and spending alerts

**Priority:** P1 · **Size:** M · **Depends on:** 013, 015

Give groups a way to set a total and per-category budget, then see spending
against it in the chosen display currency.

**Acceptance criteria**

- A trip supports an optional budget, category caps, currency, and alert
  thresholds.
- The dashboard reports committed, pending, and remaining spend without mixing
  settlement assets incorrectly.
- Alerts fire once per threshold crossing and can be muted per member.
- The UI explains when FX conversion makes totals approximate.

### 017 — Create trip templates and duplicate-from-history

**Priority:** P2 · **Size:** M · **Depends on:** 015

Repeated groups—flatmates, teams, annual trips—should not require recreating
members, rules, and common expenses from scratch.

**Acceptance criteria**

- Users can save a trip structure as a reusable template without copying past
  balances or historic payments.
- New trips can start from a template or an existing trip, with a preview of
  what will be copied.
- Names, dates, members, recurring rules, and permissions are editable before
  creation.
- Copy operations are idempotent and audited.

### 018 — Build a reusable contacts and member-profile layer

**Priority:** P2 · **Size:** L · **Depends on:** 006, 007

Avoid repeatedly entering names and wallet addresses while respecting the fact
that a wallet can change and some members may not yet have a wallet.

**Acceptance criteria**

- Users can maintain private contacts with a display name, optional verified
  wallet, and optional invite destination.
- A wallet owner can prove and claim their profile; unverified names never
  imply ownership of a wallet.
- Address changes retain historic payment attribution and notify affected
  active groups before use.
- Duplicate detection is based on canonical wallet address, not display name.

### 019 — Improve multi-currency entry and FX provenance

**Priority:** P1 · **Size:** L · **Depends on:** 016

The app records a quote when a fiat value is converted, but users need to see
and control that choice. Make display currency, locked quote, and settlement
asset explicit at expense creation and review.

**Acceptance criteria**

- The form clearly distinguishes entered currency, quote source/time, converted
  settlement amount, and Stellar settlement asset.
- Users can refresh a quote before saving; once saved, the original quote is
  immutable and visible in the expense history.
- Degraded/expired quote states block accidental conversion but still permit
  direct settlement-asset entry.
- Tests cover rounding, stale quotes, provider disagreement, and no conversion
  for native asset input.

### 020 — Deliver CSV/PDF export and a portable trip archive

**Priority:** P1 · **Size:** M · **Depends on:** 006, 012, 013

Users should be able to take their records with them for reimbursement,
accounting, or personal records.

**Acceptance criteria**

- CSV export includes expenses, shares, adjustments, categories, exchange-rate
  provenance, settlement asset, and transaction hash.
- A print-friendly PDF summary includes balances, receipts links when allowed,
  and explorer links.
- An archive export is scoped to the requesting user’s authorized trips and is
  rate-limited/audited.
- Amounts preserve precision and never coerce into floating-point notation.

---

## Phase 3 — Settlement, wallets, and blockchain capabilities

### 021 — Support partial and installment payments per share

**Priority:** P1 · **Size:** XL · **Depends on:** 008, 009, 012

One payment per share is too rigid for real groups. Allow a member to settle a
share over multiple on-chain payments while preserving exact remaining balance.

**Acceptance criteria**

- Shares have `owed`, `paid`, and `remaining` amounts in integer stroops/base
  units; an overpayment is rejected or requires an explicit credit flow.
- Each installment is independently verified and linked to its transaction and
  attestation.
- Net settlement never counts partial amounts as fully settled.
- Concurrent installment attempts and retry-after-submit behavior are covered
  by integration tests.

### 022 — Add reminder and payment-request delivery

**Priority:** P1 · **Size:** L · **Depends on:** 015, 021

Let a payer politely request a due amount through an in-app notification and
an opted-in external channel without leaking a trip’s details in a public URL.

**Acceptance criteria**

- Members can receive in-app reminders; email/push is opt-in and rate-limited.
- A payment request deep link identifies the recipient and requested share but
  requires authentication before showing private context.
- Reminder history records sender, time, state, and unsubscribe/mute choices.
- No reminder sends automatically without a user-configured schedule or action.

### 023 — Add QR and link payment requests for outstanding balances

**Priority:** P1 · **Size:** M · **Depends on:** 021, 022

Extend the existing SEP-0007 QR capability to generate a clear payment request
for a particular outstanding share or net settlement.

**Acceptance criteria**

- The QR/link includes destination, canonical asset, exact amount, safe memo or
  intent reference, expiry, and network context.
- The recipient sees a human-readable preview before their wallet signs.
- Expired, already-paid, and mismatched-network requests cannot be submitted.
- The request works with supported wallets and has a copyable fallback URI.

### 024 — Introduce settlement proposals and member confirmation

**Priority:** P2 · **Size:** L · **Depends on:** 021

For larger groups, present a frozen “proposed settlement” snapshot before
payments begin, so members agree which expenses and balances are included.

**Acceptance criteria**

- A proposal captures included expense versions, balances, asset(s), creator,
  expiry, and a deterministic content hash.
- Members can approve, reject with a reason, or request an edit; approval is
  invalidated by a material change.
- Paying from a proposal shows the snapshot reference in the UI and memo where
  feasible.
- Expired/revoked proposals cannot authorize a new payment.

### 025 — Add a dispute workflow with evidence and pause controls

**Priority:** P1 · **Size:** XL · **Depends on:** 012, 014, 024

Disagreement is a product state, not merely a support ticket. Give members a
non-custodial way to flag an item, attach evidence, and prevent accidental
inclusion in a fresh settlement proposal.

**Acceptance criteria**

- A member can open a dispute against an authorized expense/share with a
  category, comment, and permitted evidence.
- Disputed amounts are visibly excluded or flagged in settlement calculations;
  previously confirmed on-chain payments remain factual and immutable.
- Resolution requires recorded action/reason and restores eligibility only when
  appropriate.
- Abuse controls, privacy controls, and notification rules are documented.

### 026 — Provide wallet capability detection and safer fallback UX

**Priority:** P1 · **Size:** M · **Depends on:** 002

Wallet extensions differ in supported networks, signing APIs, QR handling, and
path-payment behavior. Detect capability before a user reaches a failing
signature dialog.

**Acceptance criteria**

- The connection screen shows supported wallets and the capabilities detected
  for the selected network.
- Unsupported actions offer a compatible wallet, QR/deep-link, or copy-XDR
  fallback rather than a generic failure.
- The app rechecks network and active address immediately before signing.
- A test matrix covers each supported wallet adapter and no-wallet mode.

### 027 — Finish multi-asset settlement-contract support

**Priority:** P1 · **Size:** XL · **Depends on:** 005, 009, 021

The pool is asset-aware, while the settlement contract still pins one
settlement asset. Extend the attestation and contract model only after a
security review and migration plan, so an expense can settle safely in approved
assets.

**Acceptance criteria**

- The contract cryptographically binds the canonical asset (code and issuer or
  native) to every claim and prevents cross-asset withdrawal.
- Asset allowlists, issuer verification, decimal precision, and trustline
  prerequisites are enforced end-to-end.
- Existing records remain readable and migration/redeployment is documented.
- Contract, oracle, UI, and reconciliation tests include same-expense,
  multi-asset and malicious-issuer cases.

### 028 — Add a balance, trustline, and asset-readiness screen

**Priority:** P1 · **Size:** M · **Depends on:** 026, 027

Before a member tries to pay, show whether their selected wallet has the
required balance, trustline, authorization, reserve, and supported asset.

**Acceptance criteria**

- The screen reports spendable balance, required amount plus fee estimate,
  trustline state, and issuer authorization in plain language.
- Users can build and sign an explicit trustline transaction where supported;
  nothing is created silently.
- The flow surfaces sponsored-account reserve constraints and network mismatch.
- Errors map to actionable remediation, not raw Horizon/Soroban messages.

### 029 — Harden path-payment quotes and price-impact disclosure

**Priority:** P1 · **Size:** L · **Depends on:** 019, 026

Path payments are valuable, but users need a clearer basis for conversion cost
and expiry than a single route comparison.

**Acceptance criteria**

- Show source amount, destination amount, route, network fee, quote expiry,
  slippage limit, and an independent reference-rate comparison when available.
- Require explicit confirmation when price impact exceeds a configurable
  threshold or reference data is unavailable.
- Re-quote immediately before signing if the original quote is stale.
- Record quote metadata with the intent for support/reconciliation; never
  misrepresent an estimate as a guaranteed price.

### 030 — Replace the single settlement oracle key with threshold control

**Priority:** P1 · **Size:** XL · **Depends on:** 005, 027

The current attestation model intentionally leaves one oracle key as a trust
concentration. Design and implement an M-of-N attestation scheme with safe key
rotation and failure handling.

**Acceptance criteria**

- Contract verification accepts a quorum of distinct valid signatures over the
  complete, domain-separated claim.
- Signers use independent custody/availability domains; no client receives a
  signing secret.
- Add/remove/rotate signer changes use a documented governance and recovery
  procedure with overlap between old and new quorums.
- Tests cover duplicate signers, insufficient quorum, expired signatures,
  replay, compromised-key removal, and signer outage.

---

## Phase 4 — Quality, accessibility, and platform scale

### 031 — Turn Stellar-star into an installable offline-aware PWA

**Priority:** P2 · **Size:** L · **Depends on:** 008, 009

Members often add expenses while travelling with poor connectivity. Support
safe offline viewing and queued non-financial drafts while preserving online
verification for money movement.

**Acceptance criteria**

- The app is installable and has an offline shell with a clear last-synced
  indicator.
- Read-only cached data is scoped to the authenticated wallet and is cleared on
  sign-out/wallet switch.
- Expense drafts can queue with idempotency keys and display conflict status on
  reconnect.
- Signing, payment submission, and authoritative settlement recording remain
  online-only and say so clearly.

### 032 — Reach WCAG 2.2 AA for core flows

**Priority:** P1 · **Size:** L · **Depends on:** 011, 023

Make wallet connection, authentication, trip creation, expense entry, payment,
and error recovery usable with keyboard, screen reader, zoom, and reduced
motion settings.

**Acceptance criteria**

- Complete an automated audit plus manual keyboard and screen-reader testing
  for each core flow.
- Fix focus management in modals, semantic labels/error messages, contrast,
  target size, live status updates, and reduced-motion behavior.
- Add accessibility tests for the highest-risk reusable components.
- Publish an accessibility statement and a feedback contact.

### 033 — Add internationalization and locale-aware amounts/dates

**Priority:** P2 · **Size:** L · **Depends on:** 019, 032

Support more users without changing the canonical on-chain values. Translation
and localized display must never alter the stored decimal representation.

**Acceptance criteria**

- UI copy is externalized and supports an initial set of locales selected by
  user preference.
- Dates, numeral grouping, and display currency use locale formatting, while
  calculation/storage remains exact and locale-independent.
- Input parsing clearly handles decimal separators and prevents ambiguous
  amounts.
- Pseudo-localization and RTL readiness are checked before adding more locales.

### 034 — Establish product analytics with explicit consent

**Priority:** P2 · **Size:** M · **Depends on:** 006, 032

Measure activation and friction without turning payment data into surveillance.
Analytics should help prioritize work such as wallet support and onboarding
failures while collecting the minimum necessary data.

**Acceptance criteria**

- Define a public event taxonomy for non-sensitive funnel events and a
  consent/opt-out experience appropriate to the deployment region.
- Never send wallet addresses, transaction XDR, receipt contents, or free-text
  descriptions to analytics by default.
- Product dashboards show aggregate activation, completion, and failure rates.
- Event payloads are reviewed, versioned, and tested for redaction.

### 035 — Publish a versioned developer API and webhook framework

**Priority:** P2 · **Size:** XL · **Depends on:** 007–010, 020

Allow trusted integrations—accounting tools, event organizers, or internal
systems—to consume permitted trip data and settlement events safely.

**Acceptance criteria**

- A versioned, documented API uses scoped tokens or signed OAuth-style grants,
  never a raw Supabase service key.
- API resources enforce the same authorization rules as the app and have
  pagination, rate limits, idempotency, and audit logs.
- Webhooks use signed payloads, retries, replay protection, delivery logs, and
  a test endpoint.
- A stable OpenAPI specification and sandbox examples are published.

---

## Phase 5 — Optional product expansions

These are deliberately separated from the core backlog. Validate user demand,
compliance impact, and operating cost before committing roadmap capacity.

### 036 — Receipt capture with OCR-assisted draft creation

**Priority:** P3 · **Size:** L · **Depends on:** 014, 019, 032

Offer a mobile camera flow that extracts merchant, date, total, currency, and
line items into an editable draft. OCR is assistance only, never accounting
truth.

**Acceptance criteria**

- The user explicitly selects/captures a receipt and reviews every extracted
  field before an expense is created.
- The original receipt follows issue 014’s storage and retention rules.
- Low-confidence fields are clearly marked; no total is inferred silently.
- OCR provider, regions, cost limits, and data-processing terms are reviewed
  before launch.

### 037 — Create a travel workspace around a trip

**Priority:** P3 · **Size:** L · **Depends on:** 017, 020

Expand a trip from a ledger into a lightweight shared travel workspace with an
itinerary, packing list, and booking references. Keep private booking details
out of public chain metadata.

**Acceptance criteria**

- A trip can contain dated itinerary items, collaborative checklists, optional
  reminders, and permission-controlled booking links/files.
- Items can link to related expenses without copying financial data.
- Calendar export uses a standard format and respects each member’s timezone.
- Members can export or delete travel-only content under the privacy policy.

### 038 — Add shared subscription management

**Priority:** P3 · **Size:** L · **Depends on:** 015, 021, 022

Make recurring services (streaming, utilities, software) first-class: track
renewal dates, allocation changes, price increases, and reminders while leaving
merchant billing outside the app.

**Acceptance criteria**

- A subscription records provider, renewal cadence/date, owner, share rule,
  expected amount/currency, and cancellation/contact notes.
- It can create a reviewable recurring expense draft and notify members before
  renewal.
- Users can record a price change and preserve historical amounts.
- The app never stores merchant credentials or attempts to charge a card/bank
  account.

### 039 — Explore a shared household coordination module

**Priority:** P3 · **Size:** M · **Depends on:** 017, 018, 032

For flatmates, value often includes chores and shared supplies as well as
settlement. Test whether lightweight coordination improves retention without
forcing it into the finance model.

**Acceptance criteria**

- A research prototype supports recurring chores, rotation, completion history,
  and optional links to supply expenses.
- Chore completion is not treated as a financial payment and cannot modify
  balances.
- Members can opt out; trip owners can disable the module completely.
- Pilot feedback defines success metrics before a general release.

### 040 — Explore community funds and milestone-based spending

**Priority:** P3 · **Size:** XL · **Depends on:** 005, 025, 030, 035

This is a separate product direction for clubs, events, or open-source teams:
members contribute to a shared fund and release money only after a documented
milestone. It introduces custody, governance, and regulatory risks and must
not be presented as a minor extension of split expenses.

**Acceptance criteria**

- Complete legal/compliance, custody, sanctions, consumer-protection, and
  jurisdiction review before implementation.
- A written product decision explains whether funds are non-custodial,
  multisignature-controlled, or out of scope.
- Milestones, voting/quorum, disputes, refunds, and emergency pause rules are
  explicit and independently audited.
- Build only as an isolated module/contract with separate threat model,
  deployment, monitoring, and user disclosures.

---

## Phase 6 — Reliability, collaboration, and ecosystem maturity

### 041 — Add database performance budgets and query observability

**Priority:** P1 · **Size:** L · **Depends on:** 007, 013

As trip histories and membership counts grow, slow or unbounded queries can
degrade the core experience and increase database cost. Establish measurable
performance expectations before scale makes regressions difficult to find.

**Acceptance criteria**

- Define p95 latency and row-scan budgets for the trip dashboard, expense
  history, balance calculation, and support-console queries.
- Add query tracing or database metrics that identify endpoint, query shape,
  duration, rows returned, and errors without recording private content.
- Add required indexes and cursor-based pagination where profiling shows a
  need; document the reasoning for each migration.
- Load tests cover a large trip and prove that authorized users receive only
  their permitted rows within the agreed budget.

### 042 — Implement rate limits and abuse protection for public entry points

**Priority:** P0 · **Size:** M · **Depends on:** 003, 007, 008

Invitation, authentication, upload, reminder, and payment-intent endpoints
need consistent protection against automated abuse without locking out normal
members during a time-sensitive settlement.

**Acceptance criteria**

- Apply documented per-wallet, per-IP, and endpoint-specific limits with safe
  burst allowances and server-side enforcement.
- Return actionable retry information and use progressive challenges only for
  suspicious traffic, never as the sole authorization control.
- Limit invitation creation, upload attempts, reminder sends, and idempotency
  key creation independently.
- Record redacted security events and alerts for sustained blocking, anomalous
  retries, and potential enumeration attempts.

### 043 — Provide a data-integrity audit and repair workflow

**Priority:** P1 · **Size:** L · **Depends on:** 009, 012, 041

Application records, aggregates, and independently verifiable chain events can
drift because of interrupted migrations or historic bugs. Operators need a
repeatable way to detect and repair that drift without silently changing
financial history.

**Acceptance criteria**

- A scheduled audit verifies foreign keys, share totals, balance aggregates,
  settlement states, and expected on-chain references.
- Each discrepancy receives a stable identifier, severity, evidence, and
  recommended remediation; results are retained for review.
- Repair actions are dry-run by default, require authorized approval, and
  create immutable audit records linking before/after state.
- Tests include malformed legacy rows, duplicate events, missing aggregates,
  and an ambiguous chain result that must remain unresolved.

### 044 — Add configurable trip roles and granular permissions

**Priority:** P2 · **Size:** L · **Depends on:** 007, 018

Small groups can share equal powers, but teams may need a distinct organizer,
treasurer, viewer, or expense contributor. Extend authorization deliberately
instead of adding one-off boolean flags.

**Acceptance criteria**

- Define a documented role matrix for owner, organizer, contributor, viewer,
  and custom role assignments where appropriate.
- Permissions control membership, trip settings, expenses, receipts, exports,
  reminders, and settlement proposals at both API and RLS layers.
- Role changes require the right authority, are visible to affected members,
  and preserve an auditable history.
- The system prevents removal or demotion of the final eligible trip owner
  without an explicit ownership-transfer flow.

### 045 — Support member lifecycle states and controlled offboarding

**Priority:** P1 · **Size:** M · **Depends on:** 012, 021, 044

Groups change. A member who leaves must retain accurate historic attribution
while gaining neither unintended access nor an impossible outstanding balance.

**Acceptance criteria**

- Members can be active, pending, departed, or removed, with a recorded actor,
  reason, and timestamp for each transition.
- A departure flow clearly displays unsettled obligations and offers an
  explicit settlement, transfer, or documented exception choice.
- Departed and removed members lose future-trip access and realtime visibility
  while history remains intelligible to authorized remaining members.
- Reinvitation, wallet changes, open disputes, and active recurring templates
  have tested, predictable behavior.

### 046 — Introduce notification preferences and a unified inbox

**Priority:** P2 · **Size:** L · **Depends on:** 022, 034, 045

Notifications should be useful context, not an unmanageable stream of alerts.
Create one place to review activity and control channel-level preferences.

**Acceptance criteria**

- An in-app inbox shows read/unread state, deep links, delivery status, and
  pagination for activity the current user may view.
- Users can configure channel and event preferences per account and, where
  relevant, per trip; legally required notices remain clearly distinguished.
- Grouped notifications prevent duplicate messages for repeated updates while
  retaining an accessible activity trail.
- Preference updates take effect before future sends and are tested for wallet
  switch, account deletion, and unsubscribe cases.

### 047 — Add collaborative comments and an immutable activity timeline

**Priority:** P2 · **Size:** L · **Depends on:** 007, 014, 044

Members need context around an expense or correction without taking discussion
into an unconnected channel. Add scoped collaboration while preserving a clear
line between conversation and financial facts.

**Acceptance criteria**

- Authorized members can add comments to trips, expenses, disputes, and
  settlement proposals, with edit/delete rules and visible timestamps.
- A system activity timeline records important financial and permission events
  separately from user commentary.
- Mentions and attachments respect membership, storage authorization, abuse
  controls, and notification preferences.
- Deleted or moderated comments follow the retention policy without rewriting
  financial audit entries.

### 048 — Create a guided onboarding and first-settlement checklist

**Priority:** P1 · **Size:** M · **Depends on:** 026, 028, 032, 034

The first trip and payment are the highest-friction moments. Give new members
a skippable, accessible path that explains the minimum steps and detects
incomplete setup before a payment request fails.

**Acceptance criteria**

- Onboarding adapts to whether a user is creating, joining, or only viewing a
  trip, and never blocks access to already-permitted information.
- A first-settlement checklist covers wallet connection, network, asset
  readiness, review, signature, confirmation, and recovery status.
- Help copy is plain-language, keyboard accessible, and linked to the relevant
  support article without exposing another trip's data.
- Consent-aware analytics measure step completion and abandonment without
  collecting wallet addresses or financial free text.

### 049 — Publish a searchable help center and operational status page

**Priority:** P1 · **Size:** M · **Depends on:** 003, 010, 048

Users should be able to understand routine wallet, payment, and recovery
states without waiting for manual support, and they need honest visibility when
the service itself is impaired.

**Acceptance criteria**

- Publish versioned, searchable articles for wallet setup, invitations,
  payments, transaction lookup, corrections, privacy, and safety practices.
- A public status page distinguishes app, database, notification, quote, and
  reconciliation components without exposing sensitive infrastructure detail.
- Incident updates use a documented cadence, owner, and resolved-postmortem
  template appropriate to impact.
- Help and status content has an owner and review date, with links checked in
  CI.

### 050 — Add automated dependency, secret, and supply-chain controls

**Priority:** P0 · **Size:** M · **Depends on:** 001, 005

The frontend, services, contracts, and deployment workflows rely on third-party
code and credentials. Make routine hygiene continuous rather than a prelaunch
audit-only activity.

**Acceptance criteria**

- CI scans committed code and build artifacts for secrets, vulnerable
  dependencies, and known malicious package indicators.
- Dependency updates are grouped, reviewed, and tested; critical findings have
  defined remediation targets and escalation owners.
- Releases record immutable source revision, dependency lockfile digest, build
  provenance, and deployed artifact hashes.
- Signing keys and deployment credentials are inventoried, least-privileged,
  rotated on a schedule, and never written to logs.

### 051 — Establish deployment environments and progressive delivery

**Priority:** P0 · **Size:** L · **Depends on:** 002, 003, 050

Separate preview, staging, and production behavior so risky changes can be
tested against realistic integrations and released gradually with a credible
rollback path.

**Acceptance criteria**

- Preview, staging, and production use isolated credentials, data boundaries,
  callback URLs, and clearly labeled network configuration.
- Every release passes automated smoke tests in staging, including a safe
  wallet/payment simulation where feasible.
- Production supports feature flags or phased rollout with owner, expiry, and
  rollback instructions for every flag.
- A failed rollout can be rolled back without data loss, and the procedure is
  rehearsed and documented.

### 052 — Build contract upgrade governance and compatibility checks

**Priority:** P0 · **Size:** XL · **Depends on:** 005, 027, 030, 051

Soroban contract changes may affect settled records and user funds. Define a
transparent upgrade path before future contract capabilities create an urgent
need to deploy one.

**Acceptance criteria**

- Document whether contracts are immutable or upgradeable, the authorized
  upgrade mechanism, timelock/review expectations, and emergency procedure.
- A compatibility suite validates new contract behavior against prior claims,
  assets, attestations, and client versions before deployment.
- Upgrade proposals include source hash, WASM hash, test evidence, signer
  approvals, rollout plan, and public change summary.
- Post-upgrade monitoring verifies expected events and supports a documented
  pause or remediation path if anomalies appear.

### 053 — Offer read-only shared balance views with privacy-safe sharing

**Priority:** P2 · **Size:** M · **Depends on:** 007, 020, 044

Some organizers need to share a balance snapshot with a sponsor or accountant
who should not receive wallet access or edit rights. Provide explicit, limited
sharing rather than exporting sensitive data manually.

**Acceptance criteria**

- Authorized roles can create a revocable, expiring read-only share limited to
  a selected trip, data scope, and optional date range.
- Shared views omit hidden notes, receipts, wallet data, and member details by
  default, with each inclusion chosen explicitly.
- Access is logged, cannot mutate records, and is invalidated immediately on
  revocation or trip deletion.
- Links resist guessing and do not place private data in URLs, metadata, or
  search indexes.

### 054 — Add configurable expense approval policies

**Priority:** P2 · **Size:** L · **Depends on:** 024, 044, 047

Groups with delegated spend may need a review before an expense affects their
balances. Make this an optional policy that complements, rather than rewrites,
the existing financial ledger.

**Acceptance criteria**

- A trip can require approval by role, amount threshold, category, or a
  configurable quorum before selected expenses become payable.
- The expense shows draft, pending approval, approved, rejected, and cancelled
  states with a recorded decision and reason.
- Edits to material fields invalidate outstanding approval, while approved
  history remains auditable.
- Settlement calculations clearly exclude or separately label unapproved
  expenses, and policy changes affect only future items unless explicitly
  migrated.

### 055 — Build a safe bulk import and validation workflow

**Priority:** P2 · **Size:** L · **Depends on:** 008, 013, 020, 041

Groups moving from a spreadsheet should not need to retype months of history.
Allow imports that are reviewable, reversible, and incapable of silently
creating incorrect balances or duplicate records.

**Acceptance criteria**

- Support a documented CSV template for historic expenses, members, amounts,
  currencies, categories, and optional external references.
- Import parsing validates exact money values, member matching, duplicate
  detection, authorization, and row-level errors before any write occurs.
- Users receive a review/diff screen and an idempotent import identifier; a
  completed import creates an auditable batch record.
- Failed or cancelled imports leave no partial financial data, and a completed
  import can be logically reversed through a documented corrective action.

### 056 — Add integration testing with Stellar testnet and wallet adapters

**Priority:** P1 · **Size:** L · **Depends on:** 009, 026, 029, 051

Unit tests cannot prove the complete signing and confirmation path. Maintain a
reliable, non-production test suite that exercises the app against Stellar
testnet and each supported wallet integration.

**Acceptance criteria**

- CI or a controlled scheduled environment runs critical flows against testnet:
  connect, create intent, sign, submit, confirm, reconcile, and display proof.
- Test accounts, funding, and cleanup are isolated from production credentials
  and rate-limited to avoid shared-network abuse.
- Adapter contract tests cover capability detection, rejected signature,
  network switch, timeout, and malformed callback scenarios.
- Failures retain sanitized diagnostics and are visible to release owners
  before a related production rollout.

### 057 — Establish service-level objectives and capacity planning

**Priority:** P1 · **Size:** M · **Depends on:** 003, 041, 051, 056

Reliability requires agreed targets, not only alerts. Define what availability
and latency mean for browsing, financial intent creation, reconciliation, and
support-critical data, then plan capacity against those targets.

**Acceptance criteria**

- Publish SLOs, error budgets, measurement windows, and owners for core
  customer journeys and background reconciliation.
- Dashboards distinguish app failures, dependency failures, user-cancelled
  wallet actions, and on-chain finality delay.
- Capacity tests model forecasted users, large trips, notification bursts, and
  reconciliation backlog with documented headroom assumptions.
- Error-budget exhaustion triggers a documented release or reliability review
  rather than an automatic claim that financial operations are healthy.

### 058 — Introduce retention-aware archival for inactive trips

**Priority:** P2 · **Size:** M · **Depends on:** 006, 020, 043

Long-inactive trips need lower-cost storage and a predictable user experience,
but archival must not break exports, legal obligations, or chain-linked proof.

**Acceptance criteria**

- Define inactivity thresholds, eligibility checks, notices, exceptions, and
  restoration expectations consistent with the published retention policy.
- Archived trips remain exportable to authorized users and preserve immutable
  financial/audit references.
- Restore access is authenticated, recorded, and tested for privacy and data
  integrity; no public-chain evidence is altered.
- Storage lifecycle jobs are idempotent, observable, and safe to retry after
  partial failure.

### 059 — Create an accessibility and localization regression program

**Priority:** P1 · **Size:** M · **Depends on:** 032, 033, 048

Accessibility and language quality can regress whenever shared components or
wallet flows change. Make inclusive behavior a release expectation instead of a
one-time remediation project.

**Acceptance criteria**

- CI runs automated accessibility checks on core screens and flags new serious
  violations with a documented exception process.
- Release checklists include keyboard, screen-reader, zoom, reduced-motion,
  locale, RTL-readiness, and decimal-input smoke tests for changed flows.
- Translation coverage, missing-key detection, and layout-overflow checks run
  before release for supported locales.
- A recurring manual test plan includes people using assistive technology and
  feeds prioritized findings into the backlog.

### 060 — Run a beta program with feedback-to-roadmap governance

**Priority:** P2 · **Size:** L · **Depends on:** 010, 048, 049, 057, 059

Before expanding the optional product surface, establish a controlled beta
program that gathers representative evidence without treating participants as
unconsented production testers for financial risk.

**Acceptance criteria**

- Define eligibility, cohort size, consent, support coverage, feature flags,
  success measures, and explicit exclusion criteria for beta participants.
- Feedback, support cases, reliability signals, and security findings are
  triaged into a transparent decision log with owner and due date.
- Beta exits are safe: users can export data, disable experimental features,
  and receive clear communication about changed or ended capabilities.
- A retrospective recommends promote, iterate, pause, or retire for each beta
  feature based on evidence, operating cost, and safety review.

---

## Recommended delivery order

1. Finish issues **001–010** before any public-network launch or feature that
   increases financial volume.
2. Deliver **011–016**, then test their value with active expense-sharing
   groups before moving to templates, contacts, and exports.
3. Treat **021**, **027**, and **030** as security-sensitive projects with
   design review and contract audit checkpoints, not normal UI tickets.
4. Schedule **031–035** alongside feature work, not as a final polish phase.
5. Run discovery for **036–040** first; they are opportunities, not promises.
6. Complete **041–043** and **050–052** before sustained growth or further
   contract changes; they protect performance, abuse resistance, and release
   safety.
7. Sequence collaboration work **044–047**, then validate onboarding and
   support improvements **048–049** with real users.
8. Treat **054–055** as opt-in group workflows, and use **056–060** to keep
   quality high while expanding through a controlled beta program.
