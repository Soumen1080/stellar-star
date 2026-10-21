# Stellar Star — Data Boundary Authorization Matrix

**Document ID**: `SEC-AUTH-MATRIX-01`  
**Governing Issue**: Issue #311 (Product Backlog Item 007)  
**Target Release**: `v1.0.0-mainnet`  
**Audit Status**: VERIFIED & TESTED  

This document defines the comprehensive authorization matrix for all data boundaries across Stellar Star. It proves enforcement at the database (PostgREST RLS / stored procedures) and API layers across all user roles, details realtime subscription boundary rules, and documents all privileged service-role usage.

---

## 1. Role Definitions & Access Boundaries

| Role / Scenario | Identification Mechanism | Description |
| :--- | :--- | :--- |
| **Creator** | `created_by_wallet = current_wallet()` | Wallet that initialized the trip, expense, or invitation. Retains full administrative control. |
| **Member** | `member_wallets @> ARRAY[current_wallet()]` | Active participant recorded in the group roster. Authorized to read data, log expenses, and update shares. |
| **Invitee** | Holds 256-bit unguessable capability token | Prospective participant holding an invite link before joining. Can preview public metadata only. |
| **Revoked Member** | `revoked = true` or removed from `member_wallets` | Former participant whose invitation was revoked or who was removed from a group. All access severed. |
| **Unrelated Wallet** | Valid JWT, but `current_wallet()` not in group | Authenticated Stellar user who is not a participant in the targeted trip or expense. Must fail closed. |
| **Anonymous / Anon** | No JWT session (`current_wallet() IS NULL`) | Unauthenticated client. Strictly limited to challenge issuance and capability token verification. |

---

## 2. Comprehensive Data Boundary Authorization Matrix

| Action | Resource / Layer | Creator | Active Member | Invitee (Token) | Revoked Member | Unrelated Wallet | Anonymous / Anon | Enforcing Boundary |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Read Trips** | `SELECT trips` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RLS (`trips_select_members`) |
| **Create Trip** | `INSERT trips` | ✅ ALLOW | N/A | ❌ DENY | ❌ DENY | ✅ (as creator) | ❌ DENY | RLS (`trips_insert_creator`) |
| **Edit Trip Details** | `UPDATE trips` (name/notes) | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RLS (`trips_update_members`) |
| **Mutate Trip Roster** | `UPDATE trips.members` | ✅ ALLOW | ❌ DENY* | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | Trigger `trg_01_trips_freeze_identity` |
| **Delete Trip** | `DELETE trips` | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RLS (`trips_delete_creator`) |
| **Read Expenses** | `SELECT expenses` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RLS (`expenses_select_members`) |
| **Create Expense** | `INSERT expenses` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | API & RLS (`expenses_insert_creator`) |
| **Edit Expense** | `update_expense_versioned` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RPC check + `version` lock |
| **Mark Share Paid** | `mark_share_paid` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RPC check (`member_wallets @> v_caller`) |
| **Delete Expense** | `DELETE expenses` | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | RLS (`expenses_delete_creator`) |
| **Create Invite** | `POST /api/invitations/create` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | API route + RLS on `trip_invites` |
| **Verify Invite Preview**| `GET /api/invitations/verify` | ✅ ALLOW | ✅ ALLOW | ✅ ALLOW | ❌ DENY (410) | ✅ ALLOW | ✅ ALLOW | `verify_trip_invite` RPC |
| **Claim Member Slot**| `POST /api/invitations/claim` | ❌ N/A | ❌ (Already) | ✅ ALLOW | ❌ DENY (410) | ✅ ALLOW | ❌ DENY (401) | `claim_trip_invite` + session check |
| **Revoke Invite** | `POST /api/invitations/revoke` | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | API + `trip_invites_update_creator` |
| **Request Attestation** | `POST /api/settlement/attest` | ✅ (as debtor)| ✅ (as debtor)| ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | Session check (`session.wallet == member`) |
| **Reconcile Settlement**| `POST /api/settlement/reconcile`| ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | Horizon check + session participant check |
| **Realtime Stream** | WebSocket Postgres Changes | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | Supabase Realtime RLS scoping |
| **Read Receipts** | `GET /api/receipts/[id]` | ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | Storage signed URL + membership check |
| **Upload Receipt** | `POST /api/expenses/[id]/receipts`| ✅ ALLOW | ✅ ALLOW | ❌ DENY | ❌ DENY | ❌ DENY | ❌ DENY | API route + RLS validation |

*\*Note: Non-creator members cannot mutate the trip roster directly; new participants must join via capability-backed invite claim flow (`claim_trip_invite`).*

---

## 3. Realtime Subscription Boundary Isolation

Supabase Realtime enforces PostgREST Row Level Security policies directly at the subscription boundary:

1. **Authentication Binding**:
   When the client opens a Realtime channel (`client.channel(...)`), the client supplies the authenticated JWT (`Authorization: Bearer <token>`). Supabase Realtime extracts the verified `wallet_address` claim.
2. **Subscription Filtering**:
   Before Postgres change notifications (`INSERT`, `UPDATE`, `DELETE`) are dispatched over WebSocket, PostgREST evaluates the table's `SELECT` RLS policy:
   - `expenses`: `member_wallets @> ARRAY[current_wallet()]`
   - `trips`: `member_wallets @> ARRAY[current_wallet()]`
3. **Leakage Prevention**:
   - An **unrelated wallet** receives **zero events** for trips or expenses they do not participate in.
   - An **anonymous client** receives **zero events** because `current_wallet()` evaluates to `NULL`.
   - A **deleted or revoked account** immediately stops receiving events as `deleted_accounts` causes `current_wallet()` to evaluate to `NULL`.

---

## 4. Privileged Service-Role Usage Audit

Privileged service-role execution (`SUPABASE_SERVICE_ROLE_KEY`) bypasses RLS and must be strictly confined to server-only code with explicit operational reasons.

### 4.1 Server-Only Enforcement
Every module with access to the service role is protected by runtime guards:
```typescript
if (typeof window !== "undefined") {
  throw new Error("lib/supabase/server.ts must not be imported from client code.");
}
```
Client bundles built via Next.js dead-code eliminate all server-only modules. In addition, `scripts/validate-config.js` enforces in CI that `SUPABASE_SERVICE_ROLE_KEY` is never exposed under any `NEXT_PUBLIC_*` variable.

### 4.2 Documented Usage Inventory

| # | Location | Purpose | Authorization / Protection |
| :--- | :--- | :--- | :--- |
| **SR-01** | `app/api/auth/verify/route.ts` | Accelerated user profile provisioning on cryptographic sign-in | Protected by Ed25519 cryptographic signature verification over server nonce |
| **SR-02** | `app/api/invitations/verify/route.ts` | Resolves single invite capability metadata for prospective joiners | Scoped strictly to the hashed token pre-image; returns only `/join` preview fields |
| **SR-03** | `app/api/recurring/run/route.ts` | Scheduled recurring expense draft generation | Gated by `Authorization: Bearer $CRON_SECRET` using timing-safe comparison |
| **SR-04** | `app/api/receipts/retention/route.ts` | Purges expired private receipt attachment files | Gated by `Authorization: Bearer $CRON_SECRET` using timing-safe comparison |
| **SR-05** | `lib/auth/challengeStore.ts` | Multi-instance rate limiting and nonce registration | Internal server-side storage; rate-limited per IP and address |
| **SR-06** | `lib/settlement/attestationLedger.ts`| Multi-instance attestation double-claim prevention ledger | Read/write strictly keyed by transaction hash and verified Horizon record |
| **SR-07** | `lib/onboarding/sponsorshipLedger.ts`| Gas sponsorship ledger & capacity reserve | Rate-limited by inviter abuse-resistance controls |
| **SR-08** | `lib/privacy/accountDeletion.ts` | Executes off-chain account deletion and anonymization | Requires verified session JWT from the account owner |

---

## 5. Automated Verification & Regression Testing

The authorization matrix is validated automatically in CI via `__tests__/security/authorizationMatrix.test.ts`. Tests assert that every allowed role succeeds and every unauthorized role is rejected with `401 Unauthorized`, `403 Forbidden`, or empty row sets.
