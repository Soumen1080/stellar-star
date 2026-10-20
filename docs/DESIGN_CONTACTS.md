# Reusable contacts & member profiles (#322)

A private address book so names and wallets are not retyped for every trip
(`/contacts`, plus "Add from contacts" in the new-trip form).

## Rules

1. **Private.** `contacts` RLS is `owner_wallet = current_wallet()` for every
   operation.
2. **Identity is the canonical wallet, not the name.** Wallets are upper-cased
   and trimmed by the `guard_contact_row` trigger, and
   `contacts_owner_wallet_unique_idx (owner_wallet, wallet_address)` rejects a
   second contact with the same wallet. Two "Sam"s with different wallets are two
   people.
3. **Unverified names never imply ownership.** A wallet typed by the owner is
   shown as *Unverified — entered by you*. It becomes *Verified by owner* only
   when the wallet's owner opens a one-time claim link (`/claim/<token>`, only the
   SHA-256 is stored, valid 7 days) while signed in with that wallet.
   `claim_contact_profile` binds the session's `current_wallet()`. The guard
   trigger resets `wallet_verified` / `claimed_by_wallet` on any direct write.
4. **Address changes keep history and notify first.** A saved wallet cannot be
   edited in place (`CONTACT_WALLET_CHANGE_REQUIRES_NOTICE`).
   `request_contact_wallet_change` records a pending change listing the owner's
   *unsettled* trips that include the old wallet. Members of those trips can read
   the change (RLS) and see a banner on the trip page. `apply_contact_wallet_change`
   refuses until the 24-hour notice period has passed, or applies immediately when
   no active trip is affected. Expenses, shares, payments and trip member lists are
   never rewritten, so historic payment attribution stays with the old address.
   A claim from a different wallet than the one on file goes through the same
   notice flow, marked as verified.

## Schema

Migration `0009_contacts_member_profiles.sql` (mirrored in `supabase-setup.sql`):
`contacts`, `contact_wallet_changes`, the guard trigger, and the
`request_/apply_/cancel_contact_wallet_change` and `claim_contact_profile`
functions (`SECURITY DEFINER`, each checking `current_wallet()` explicitly).
