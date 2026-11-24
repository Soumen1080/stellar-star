# Stellar Star — Privacy Notice & Data Retention Policy

**Effective Date**: 2026-10-21  
**Target Release**: `v1.0.0-mainnet`  
**Governing Standard**: Issue #310 (Product Backlog Item 006)  

Stellar Star is a non-custodial, collaborative expense-sharing and settlement application built on the Stellar blockchain. This document clearly distinguishes **immutable public blockchain records** from **mutable off-chain application data**, defines the **retention schedule** across all data stores, and explains the **account deletion and data export process**.

---

## 1. Dual Data Architecture: Blockchain vs. Off-Chain

Stellar Star operates on a hybrid architecture designed to minimize data exposure while ensuring provable, verifiable financial settlements.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DATA PRIVACY BOUNDARIES                         │
├─────────────────────────────────────┬──────────────────────────────────┤
│    IMMUTABLE PUBLIC BLOCKCHAIN      │      MUTABLE OFF-CHAIN DATA      │
│          (Stellar Network)          │       (Supabase / Storage)       │
├─────────────────────────────────────┼──────────────────────────────────┤
│ • Public Key Addresses (G...)       │ • Profile Display Names          │
│ • Contract IDs (C...)               │ • Trip Names & Descriptions      │
│ • Transaction Hashes & Signatures   │ • Expense Categories & Tags      │
│ • Payment Amounts & Asset Codes     │ • Receipt Attachment Files       │
│ • Ledger Sequence Timestamps        │ • Invitation Links & Tokens      │
│ • Smart Contract Settlement State   │ • Contact Address Books          │
│ • Ed25519 Cryptographic Proofs      │ • Server Session Auth Tokens     │
├─────────────────────────────────────┼──────────────────────────────────┤
│ ❌ Permanent & Non-Erasable         │ ✅ Fully Mutable & Deletable     │
│ ❌ Publicly Auditable by Anyone     │ ✅ Row-Level Security Protected  │
└─────────────────────────────────────┴──────────────────────────────────┘
```

### 1.1 Immutable Public-Chain Records
When you interact with the Stellar network (including making direct transfers, signing payments, depositing into the settlement pool, or invoking the Soroban settlement contract):
- **Permanent Ledger**: Stellar is a decentralized, public ledger. Every transaction hash, source account, destination account, transacted asset, stroop amount, and transaction memo is permanently committed to public ledgers.
- **No Deletion Mechanism**: Neither Stellar Star, nor node validators, nor any third party possesses the technical ability to delete, edit, redact, or rewind transactions once confirmed by the network.
- **Pseudonymity**: Public keys (`G...`) identify ledger accounts. Stellar Star never writes real names, email addresses, phone numbers, or physical addresses to transaction memos or on-chain contract state.

### 1.2 Mutable Off-Chain Application Data
To provide friendly group accounting, Stellar Star stores operational data in Postgres (Supabase) and private object storage:
- **User Profiles**: Display name, wallet address mapping, last login timestamp.
- **Trip & Expense Data**: Group names, trip notes, expense titles, split apportionments, exchange-rate conversion provenance.
- **Household Coordination (optional pilot)**: Chore titles/details, due dates, member rotation, completion timestamps, opt-out preferences, and optional references to existing trip expenses. This is off-chain trip data and is hidden when the trip owner disables the module.
- **Private Address Book**: Custom contact names and invite tags.
- **Receipt Attachments**: Scanned receipt images and invoices stored in private buckets.
- **Capability Tokens**: Unguessable invitation tokens and authentication challenge nonces.

All off-chain data is protected by **PostgREST Row Level Security (RLS)**: only verified wallets participating in a group can read or write that group's rows.

---

## 2. Retention Schedule

Stellar Star retains off-chain data only as long as necessary to fulfill product functionality and regulatory integrity.

| Data Category | Specific Storage | Retention Period | Deletion Trigger / Mechanism |
| :--- | :--- | :--- | :--- |
| **User Account & Profile** | `public.users` | Retained while active | Immediate deletion upon authenticated user request (`/api/account/delete`). |
| **Address Book & Contacts** | `public.contacts` | Retained while active | Deleted immediately upon account deletion or manual contact removal. |
| **Receipt Attachments** | Supabase Storage & `expense_receipts` | Up to 730 days (2 years) | Purged via automated retention cron (`/api/receipts/retention`) or account deletion. |
| **Trip Invitations** | `public.trip_invites` | 7 days default TTL | Expired links rendered unusable immediately; tombstoned records purged after 30 days. |
| **Household Chores** | `household_chores`, `household_chore_completions`, `household_chore_preferences` | Retained with the trip | Deleted with the trip; disabling the module hides records but preserves history. |
| **Audit Logs** | `export_audit_events`, error logs | 90 days | Automated rolling purge; client IP addresses are salted and hashed with SHA-256. |
| **Auth Challenges & Nonces** | `public.auth_challenges` | 5 minutes | Purged immediately upon verification; expired entries sweep every minute. |
| **Rate Limit Counters** | `public.auth_rate_limits` | 60 seconds rolling window | Expired window records automatically overwritten. |
| **Database Backups** | Encrypted S3/Cloud Storage | 30 days rolling cycle | AES-256-GCM encrypted backups rotated out after 30 days per disaster recovery runbook. |
| **Analytics & Telemetry** | Server Logs / Webhooks | 180 days | Zero PII; wallet addresses and transaction XDR payloads are strictly redacted. |

---

## 3. Account Deletion & Right to Erasure

### 3.1 Authenticated Deletion Flow
Users can request immediate erasure of their personal off-chain data by providing a cryptographically signed request from their connected wallet:

1. **Request Endpoint**: `POST /api/account/delete` (or `DELETE /api/account`)
2. **Authentication**: Requires a valid, active session token (`Authorization: Bearer <token>`) minted from the wallet challenge response.
3. **Execution**:
   - The wallet address is registered in `public.deleted_accounts`.
   - The user profile in `public.users` is deleted or anonymized (`display_name = 'Deleted User'`).
   - Private contacts in `public.contacts` owned by the wallet are deleted.
   - Any active invitations generated by the wallet in `public.trip_invites` are revoked.
   - Private receipt attachments uploaded by the wallet are scheduled for immediate storage purge.
   - In shared trips and expenses, the user's display name is sanitized to `"Former Member"`. The canonical wallet address and historical share math remain in the ledger record to maintain financial integrity for surviving trip participants.

### 3.2 What Deletion CANNOT Do
Deletion **does not and cannot remove on-chain Stellar transactions**. Any Stellar transfer, Soroban contract settlement attestation, or pool deposit recorded on the Stellar ledger remains on-chain forever.

---

## 4. Invalidation of Stale Sessions, Realtime, & Storage URLs

When an account is deleted, multiple defensive layers prevent subsequent unauthorized access:

1. **Database RLS Fail-Closed (`public.current_wallet()`)**:
   `public.current_wallet()` checks `public.deleted_accounts`. If a wallet is listed as deleted, the function returns `NULL`. As a result, all RLS policies fail closed: PostgREST returns empty sets and rejects all mutations.
2. **Realtime Subscription Invalidation**:
   Supabase Realtime enforces the same RLS policies as PostgREST. A deleted account's subscriptions immediately stop receiving row change events.
3. **Storage URL Expiration**:
   Receipt links are short-lived signed URLs (15-minute expiry). Once an account is deleted, subsequent URL generation is rejected because the user fails the group membership check.
4. **Token Refresh Denial**:
   `POST /api/auth/refresh` checks `public.deleted_accounts` and refuses to issue renewed JWTs for deleted wallets.

---

## 5. Contact & Privacy Officer

For questions regarding this privacy policy or to submit manual inquiries:
- **Email**: [privacy@stellarstar.app](mailto:privacy@stellarstar.app)
- **Security & Incident Contact**: [security@stellarstar.app](mailto:security@stellarstar.app)
