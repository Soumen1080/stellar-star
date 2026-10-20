# Stellar-star Supabase Backup, Retention & Disaster Recovery Guide

This document establishes the official backup policy, encryption standards, retention schedules, access controls, staging rebuild procedures, disaster recovery objectives (RPO/RTO), and customer-facing incident communications for Stellar-star (Issue #308).

---

## 1. Architectural Invariants

1. **Blockchain Truth is Immutable ($RPO = 0$ On-Chain)**:
   All financial movements (XLM payments, multi-asset settlements, and Soroban contract attestations) occur on the public Stellar ledger. Even if a total catastrophic database loss occurs, no user funds are lost. Supabase database recovery converges off-chain application state to on-chain truth via `lib/settlement/reconcile.ts`.
2. **Zero Plaintext at Rest**:
   All database backups are encrypted client-side using **AES-256-GCM** prior to export and storage.
3. **Authenticated Encryption with Tamper Detection**:
   Every backup archive carries a 128-bit authentication tag (`authTag`) and unique initialization vector (`iv`). Any bit-level modification or tampering immediately halts restoration.
4. **Reproducible Staging Rebuild**:
   The ordered migration pipeline (`migrations/*.sql`), cumulative schema (`supabase-setup.sql`), and environment configuration can rebuild a clean staging environment deterministically from scratch without manual intervention.

---

## 2. Backup Retention & Access Controls

### 2.1 Backup Retention Schedule

| Tier | Frequency | Retention Window | Storage Class | Encryption |
|------|-----------|------------------|---------------|------------|
| **Continuous PITR** | WAL streaming | 7 Days | Hot / Replicated | AES-256-GCM / TLS 1.3 |
| **Daily Snapshots** | Automated (02:00 UTC) | 30 Days | Standard Encrypted Storage | AES-256-GCM |
| **Weekly Snapshots** | Sundays (03:00 UTC) | 90 Days | Standard Encrypted Storage | AES-256-GCM |
| **Monthly Archives** | 1st of month | 365 Days | Cold Archive / Object Lock | AES-256-GCM |

### 2.2 Access Controls & Key Management

- **Least Privilege Access**:
  Access to production database backups is restricted strictly to designated **Disaster Recovery Owners** and **Infrastructure Leads**.
- **Multi-Factor Authentication (MFA)**:
  Hardware security keys (FIDO2/WebAuthn) or time-based one-time passwords (TOTP) are mandatory for accessing backup storage buckets and Supabase management consoles.
- **Key Separation**:
  The backup encryption key (`BACKUP_ENCRYPTION_KEY`) is stored in an isolated secret management system (e.g. AWS Secrets Manager, GCP Secret Manager, or Vault) and is strictly decoupled from database operational credentials (`SUPABASE_SERVICE_ROLE_KEY`).
- **Audit Logging**:
  All backup generation, export, download, and decryption operations generate immutable audit log entries with operator identity, timestamp, and IP address.

---

## 3. Automated Backup & Verification CLI

Stellar-star provides automated scripts for creating and verifying encrypted backups:

### 3.1 Creating an Encrypted Backup

```bash
# Sourced from BACKUP_ENCRYPTION_KEY in .env.local
npm run db:backup
```

The script exports and encrypts the following core tables:
- `schema_migrations` (applied migrations & checksums)
- `users` (profiles & wallet associations)
- `trips` (groups, memberships, and wallet access arrays)
- `expenses` (expense history, split modes, shares, and versions)
- `trip_invites` (hashed tokens, roles, and expiration dates)
- `settlement_intents` (correlation IDs, status, txHash, and ledger proofs)
- `auth_challenges` & `auth_rate_limits` (session state)

### 3.2 Verifying an Encrypted Backup

```bash
node scripts/backup-supabase.mjs --verify backups/backup-YYYY-MM-DDTHH-MM-SS.enc.json
```

Verifies the cryptographic authentication tag, checks salt/IV integrity, and inspects table row manifests without loading data into the database.

### 3.3 Restoring from an Encrypted Backup

```bash
node scripts/backup-supabase.mjs --restore backups/backup-YYYY-MM-DDTHH-MM-SS.enc.json
```

Decrypts the authenticated payload and merges records into the target Supabase environment.

---

## 4. Rebuilding a Clean Staging Environment

To rebuild a clean staging or development database from scratch:

```bash
# Validate staging environment readiness
npm run db:staging:rebuild
```

### Step-by-Step Staging Rebuild Procedure:

1. **Configure Staging Environment**:
   Copy `.env.local.example` to `.env.local` and set staging Supabase credentials:
   ```bash
   cp .env.local.example .env.local
   ```
2. **Apply Base Schema & RLS Policies**:
   In the target Supabase instance SQL editor or via CLI, run `supabase-setup.sql`. This idempotently creates all tables, functions (`current_wallet`, `verify_trip_invite`), indexes, and enables Row Level Security (RLS) on all user-facing tables.
3. **Execute Ordered Migrations**:
   Run the migration engine to verify or apply pending migrations:
   ```bash
   npm run db:migrate
   npm run db:status
   ```
4. **Validate Trigger Order & Schema Integrity**:
   Run the comprehensive database integrity test suites:
   ```bash
   npm run db:check
   ```

---

## 5. Recovery Rehearsal Drill

A recovery rehearsal drill proves that a sampled dataset containing trips, expense history, invitations, and settlement intents recovers with 100% fidelity.

### Running the Drill:

```bash
npm run db:drill
```

### Drill Verification Steps:
1. **Sampled Trip**: Proves that trip metadata, member arrays, and wallet permissions recover identically.
2. **Expense History**: Proves that multi-share expenses, custom/equal splits, version numbers, and settlement flags recover identically.
3. **Trip Invitation**: Proves that token hashes, member roles, and expiration timestamps recover identically.
4. **Settlement Intent**: Proves that correlation IDs (`request_id`), Stellar transaction hashes (`tx_hash`), ledger sequence numbers, and on-chain verification flags recover identically.
5. **Cross-Referential Integrity**: Asserts foreign key consistency between intents, expenses, invites, and trips.
6. **Tamper Detection**: Deliberately mutates encrypted ciphertext and confirms that AES-256-GCM authentication tag validation halts restore immediately.

---

## 6. Recovery Objectives (RPO & RTO)

### 6.1 Recovery Point Objective (RPO)

- **Target Database RPO**: $\le 1\text{ hour}$ for scheduled snapshots; $\le 5\text{ minutes}$ for Point-in-Time Recovery (PITR).
- **On-Chain Financial RPO**: $\mathbf{0\text{ seconds}}$ (Zero data loss). All payments confirmed on Stellar Horizon are permanent and immutable.
- **Reconciliation Invariant**: Following a database restore, the reconciliation engine (`lib/settlement/reconcile.ts`) queries Stellar Horizon and Soroban contracts to restore any in-flight settlement intents that occurred between the last backup and the outage.

### 6.2 Recovery Time Objective (RTO)

- **Target Staging / Production RTO**: $\le 30\text{ minutes}$ from disaster declaration to service restoration.
- **RTO Breakdown**:
  - Disaster declaration & standby activation: 5 minutes
  - Decryption & backup payload verification: 3 minutes
  - Database schema provision & restore: 12 minutes
  - Blockchain reconciliation & integrity drill: 5 minutes
  - DNS / Traffic cutover & verification: 5 minutes

---

## 7. Customer-Facing Incident Communication Templates

In the event of an unscheduled outage requiring database recovery, the on-call team follows these pre-approved communication templates across the status page, in-app banner, and communication channels.

### Phase 1: Initial Acknowledgment (Target: Within 15 Minutes)

> **Headline:** Stellar-star Service Degradation & Scheduled Maintenance
>
> **Status:** Investigating
>
> **Customer Message:**
> We are currently investigating an issue impacting access to trip and expense history. During this time, creating new expenses and signing settlements are temporarily paused.
>
> **Important Note on User Funds:**
> All settled payments and wallet balances are stored directly on the Stellar blockchain and remain completely safe and untouched. No funds are at risk.
>
> Our engineering team is actively working on restoring full service. Next update in 30 minutes.

---

### Phase 2: Restoration In Progress (Target: T + 30 Minutes)

> **Headline:** Database Maintenance and Data Restoration in Progress
>
> **Status:** Identified & Restoring
>
> **Customer Message:**
> We have identified a database service disruption and have initiated our automated recovery process.
>
> **Progress:**
> - Secure, encrypted database backups have been verified.
> - Data restoration to our standby environment is underway.
> - On-chain transaction state on the Stellar network is intact.
>
> We anticipate completing restoration and running consistency checks within the next 20 minutes. Next update at [Insert Time UTC].

---

### Phase 3: Service Restored & Reconciled (Target: T + 45 Minutes)

> **Headline:** All Systems Operational — Data Synchronized
>
> **Status:** Resolved
>
> **Customer Message:**
> Database services have been fully restored and verified.
>
> **What Was Done:**
> - Database state was restored from our latest authenticated backup.
> - Automated reconciliation verified all recent settlements against the Stellar blockchain to ensure 100% accuracy.
> - Trip memberships, expenses, and invitation links are fully accessible.
>
> If you notice any discrepancy or require assistance, please contact our support team with your wallet address or request ID. Thank you for your patience.

---

### Phase 4: Post-Incident Review (PIR) Summary (Target: Within 48 Hours)

> **Headline:** Post-Incident Review (PIR): Incident Reference [INC-XXXX]
>
> **Summary:**
> On [Date], between [Start Time UTC] and [End Time UTC], Stellar-star experienced a database service disruption lasting [X] minutes.
>
> **Impact:**
> Users were unable to access trip details or record new expenses. No on-chain funds or private keys were compromised or impacted.
>
> **Root Cause:**
> [Brief explanation of primary cause, e.g., upstream database host failure / storage corruption].
>
> **Recovery Actions Taken:**
> - Automated disaster recovery runbook invoked.
> - Encrypted backup decrypted and restored within [X] minutes (achieving RTO target).
> - On-chain reconciliation synchronized [N] in-flight settlement intents without data loss.
>
> **Preventative Measures:**
> [List 2-3 engineering actions implemented to prevent recurrence].
