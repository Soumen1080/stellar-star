# Design Note: Capability-Based Invitations & Placeholder Member Claims

> **Issue**: #171 (mapped from Issue #65 in `Issue.md`)  
> **Directory**: `app/`, `components/`, `supabase-setup.sql`, `lib/supabase/`, `lib/invitations/`  
> **Status**: Implemented

---

## 1. Context & Problem

Previously, `hooks/useExpenseForm.ts` and `components/trips/TripForm.tsx` required a valid 56-character `G...` Stellar address for every member before saving a trip or expense. This created a severe adoption blocker: users could not add friends by name and settle up later without forcing everyone to install a wallet, create an account, and paste their public key upfront.

### Core Architectural Dilemma
- The whole authorization model in StellarStar assumes wallet addresses: `member_wallets` is maintained by a database trigger and checked by Row Level Security (RLS) via `@>` containment queries against GIN indexes.
- A placeholder member without a wallet cannot be represented in `member_wallets`.
- Creating a secondary authorization bypass mechanism (e.g. separate token tables or permissive RLS policies) would create authorization fragmentation and privilege escalation vulnerabilities.

---

## 2. Invariants & Security Guarantees

| Invariant | Guarantee | Mechanism |
|---|---|---|
| **1. Exact Share Preservation** | Members can be added with no wallet address; shares assigned to them are preserved exactly down to the stroop until claimed. | Largest Remainder apportionment calculates shares from member IDs; claiming only updates the `walletAddress` field on existing share records. |
| **2. Capability Security** | Holding an invite link grants access *only* to the intended group and slot. | 256-bit high-entropy unguessable tokens. Only SHA-256 hashes are stored in the database. |
| **3. Single Winner on Races** | A member slot can be claimed at most once. Concurrent claims resolve to exactly one winner. | PostgreSQL atomic stored procedure `public.claim_trip_invite` uses `SELECT ... FOR UPDATE` row-level locks on the invite and trip rows. |
| **4. Verified Wallet Control** | Claiming is verified against authenticated wallet sessions, never asserted by the client. | Claim endpoints derive identity from `current_wallet()` (JWT `wallet_address` claim) via `verifyWalletSession`. |
| **5. Immediate Revocation & Expiry** | Invites expire (default 7 days) and are revocable; revocation takes effect immediately. | Checked on every verify/claim attempt with immediate rejection if `revoked = true` or `expires_at <= NOW()`. |
| **6. Single Authorization Mechanism** | Authorization remains a single unified mechanism; RLS policies remain index-usable. | Claiming updates the member's `walletAddress`, which re-fires the `sync_member_wallets()` trigger. No secondary RLS bypass exists. |
| **7. Non-blocking Settlement** | Wallet-less members never block other wallet-holding members from settling among themselves. | `simplifyDebts` and `computeNetBalances` isolate pairwise transfers; payable pairs can settle on-chain immediately. |

---

## 3. Architecture & Data Flow

```
[Trip Creator / Member]
         │
         ▼
  Generate Invite (256-bit token T)
         │
         ├──► Store SHA-256(T) in `trip_invites` table
         └──► Share URL `https://.../join/[T]`
                  │
                  ▼
         [Invited Friend opens URL]
                  │
                  ├──► GET /api/invitations/verify?token=T
                  │      (validates hash, returns trip name + unclaimed slots)
                  │
                  ├──► Connects Stellar Wallet (Freighter/Albedo)
                  │
                  └──► POST /api/invitations/claim
                         │
                         ▼
               `public.claim_trip_invite` (SECURITY DEFINER)
                         │
                         ├── 1. SELECT * FROM trip_invites WHERE token_hash = ... FOR UPDATE
                         ├── 2. SELECT * FROM trips WHERE id = ... FOR UPDATE
                         ├── 3. Assert member slot unclaimed
                         ├── 4. Update trip.members (set walletAddress)
                         ├── 5. Update linked expenses & shares (set walletAddress)
                         ├── 6. Auto-fire sync_member_wallets() trigger
                         └── 7. Increment invite.uses
```

---

## 4. Concurrency & Double-Claim Resolution

When two users concurrently attempt to claim the same invitation token or the same placeholder member slot:
1. Both requests invoke `claim_trip_invite`.
2. The first transaction to acquire the `FOR UPDATE` lock on `public.trip_invites` and `public.trips` proceeds.
3. The winner attaches their wallet address, updates the member slot, and increments `uses`.
4. The second transaction unblocks after the lock releases:
   - If the invite had `max_uses = 1`, it fails immediately with `INVITE_EXHAUSTED`.
   - If the slot was already claimed, it checks if the caller is the same wallet (idempotent retry success) or a different wallet (aborts with `SLOT_ALREADY_CLAIMED`).

---

## 5. Alternatives Considered

1. **Client-side claim assertion**:
   - *Rejected*: Allowing the client to pass arbitrary wallet addresses to update a trip would allow any authenticated user to claim any member's slot or hijack ownership.
2. **Secondary RLS policy for invite tokens**:
   - *Rejected*: Creating an RLS policy that grants read access if a token matches would require joining against the `trip_invites` table on every `trips` and `expenses` query, turning fast GIN index scans into costly sequential joins.
3. **Storing plaintext tokens**:
   - *Rejected*: Storing plaintext capability tokens makes database backups or read leaks capable of compromising access. Storing SHA-256 hashes ensures zero-knowledge capability lookup.
