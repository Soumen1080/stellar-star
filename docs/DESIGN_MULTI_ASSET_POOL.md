# Design Note: Multi-Asset Settlement Pool

Issue #197 / #145 (epic #43). Builds on the attestation work in #144.

## The problem

`contract/src/pool.rs` held exactly one token — `cfg.token: Address` — and
`record_payment` called `pool_client.withdraw(&member, &amount)`
unconditionally. So a settlement denominated in USDC would withdraw that many
units from a balance denominated in something else. Not a rounding error: a
silent debit of the wrong asset.

Fixing it means changing the storage layout of a contract that already holds
real testnet balances, which is where the difficulty actually lives.

## Decision 1: one multi-asset pool, not one pool per asset

Both are defensible. This one is chosen for a specific reason.

**Pool-per-asset** keys nothing by token — each contract simply *is* its asset.
The storage layout stays trivial and a bug in one asset cannot touch another.
But the routing problem does not disappear; it moves. The settlement contract
would need an asset→pool registry to know which contract to call, and a wrong
entry in that registry is *exactly the bug this issue is about*, just relocated
somewhere with less scrutiny. It also multiplies operational surface: each new
asset means another deploy, another init, another contract ID in config, and
another instance TTL to keep alive.

**One multi-asset pool** keyed by `(member, token)` puts the routing in the same
ledger entry as the balance it governs. `AssetBalance(member, token)` cannot
point at the wrong asset, because the asset is half of its identity. Invariant 2
— a settlement in asset A can never withdraw from a balance in asset B — becomes
structural rather than a check somebody has to remember to write. It also keeps
the inter-contract `withdraw` proof the README advertises pointing at one known
pool address.

**Trade-off accepted:** a bug in this contract is a bug for every asset, and one
instance TTL covers all of them. Given that the alternative's failure mode is
the precise bug being fixed, concentrating the risk somewhere heavily tested is
the better trade.

## Decision 2: names are storage layout

The single most dangerous thing in this change, and the one that nearly went
wrong: a `#[contracttype]` struct serialises as an `ScMap` keyed by field-name
symbols, and a `#[contracttype]` enum serialises with the variant name as a
symbol.

So renaming `PoolConfig.token` to `legacy_token` would make every v1-stored
config fail to deserialise, and renaming `PoolDataKey::Balance` would make every
v1 balance entry unreachable — bricking the contract far more thoroughly than a
version mismatch. Both keep their v1 names:

- `PoolConfig.token` keeps its name, and gains a v2 meaning: the asset v1
  balances were denominated in (exactly what the migration needs) and the
  default asset for this deployment.
- `PoolDataKey::Balance(Address)` keeps its name and its v1 meaning. The new
  layout is a *new* variant, `AssetBalance(Address, Address)`.

## Decision 3: lazy migration, not a sweep

A Soroban contract cannot enumerate its own storage keys. There is no `for key
in storage` — so a sweeping migration is not merely expensive, it is
unwritable. Each member's v1 balance is therefore re-keyed on first touch, by
`migrate_member_balance`, called from every deposit, withdrawal, and balance
read. `migrate(member)` exposes the same operation explicitly, so a dormant
member's balance can be brought forward by anyone.

Anyone, deliberately: migration moves no value between parties, it only re-keys
what is already there. Gating it on the admin would mean a member whose admin
had gone away could never reach their own money.

**Idempotence** (invariant 3) comes from a `Migrated(member)` marker, not from
the absence of a v1 entry — because those two states are not the same thing.
A member with no v1 entry may never have deposited, *or* their entry may have
been archived by TTL expiry. Both read as `None`. Marking the member either way
resolves the ambiguity once and never revisits it, so a v1 entry restored after
archival cannot be credited a second time. `test_restored_legacy_entry_is_not_recredited`
covers exactly that sequence.

The v1 entry is also zeroed when drained. Either the marker or the zeroing
would prevent double-crediting on its own; together they mean the old balance is
not merely unreachable but demonstrably spent.

## Decision 4: version tolerance, so a deploy cannot brick

v1's check was `if version != CONTRACT_VERSION { panic }`. Deploying a v2 wasm
over v1 storage would therefore trap at *every* entry point — including any
migration entry point, leaving no way in to fix it. That is invariant 4's
failure mode precisely.

v2 accepts the range `[MIN_SUPPORTED_VERSION, CONTRACT_VERSION]` and rolls
forward. `upgrade_instance_storage` runs on the first read and is a no-op on
already-current storage. A version *newer* than the code is still refused —
`UnknownStorageVersion` — because an older layout is knowable and a newer one is
not.

The settlement contract gets the same treatment, but rejects older versions
rather than migrating them: a v1 settlement contract has no oracle key and no
settlement asset, so there is nothing to migrate *from*. It must be
re-initialised. The distinction is surfaced as two different error codes so an
operator can tell "roll forward" from "re-initialise".

## Decision 5: an allowlist, not any token

`deposit_asset` and `withdraw_asset` require the token to be on
`SupportedAssets`. Without it, a member could deploy a worthless token contract,
deposit a large amount of it, and hold a pool credit the settlement path would
treat as real. The list is admin-managed, idempotent, and bounded at 32.

## Decision 6: keeping the inter-contract proof

The README advertises a `record_payment` → pool `withdraw` inter-contract call
as verified on-chain. That proof is preserved: `record_payment` still makes an
inter-contract call to the same pool contract, now via `withdraw_asset`. Had the
design gone pool-per-asset, the call would target a different contract per
asset and the single advertised proof link would no longer represent the general
case.

## Alternatives considered and rejected

**A. Fresh contract ID, no migration.** Deploy v2 clean and point the app at it.
Trivially correct and trivially unacceptable: it strands every existing balance
and every historical `PaymentRecord`, violating invariant 1 outright. Rejected.

**B. Admin-driven bulk migration with an off-chain member list.** Have the admin
submit every known member address for migration in a batch, then flip a flag.
Rejected because the contract cannot verify the list is complete — a member
missing from it would be silently stranded, and nothing on-chain would say so.
Lazy migration needs no list to be correct, and the script's eager mode gives
the same operational convenience without making correctness depend on the
list's completeness.

**C. Migrate on read only, leaving writes to fail until then.** Simpler control
flow. Rejected because a member holding only a v1 balance would be told they
have insufficient credit for money they demonstrably have — the withdraw path
has to migrate before it checks the balance, or the check is against the wrong
number.

**D. Extend `PoolBalanceEventV1` with a token field instead of adding V2.**
Rejected: changing an event's shape breaks indexers built against it just as
surely as changing a storage key breaks storage. Both events are emitted; the
v1 event is ambiguous under multi-asset, which is why V2 exists rather than V1
being rewritten.

## Residual weaknesses, stated plainly

- **A member is only migrated once something touches them.** Until then their
  balance reads correctly through `balance_of` (which migrates first) but their
  `AssetBalance` entry does not yet exist. Nothing is lost; the entry is just
  created later than an eager sweep would have.
- **TTL archival is handled but not undone.** If a v1 balance entry is archived
  before migration, the migration records zero and marks the member. That is the
  explicit handling invariant 5 asks for, but it does not restore an archived
  entry — restoring archived state requires a ledger-level restore operation,
  outside this contract's reach. The bounded-restore case is covered by the
  marker, which prevents a late-restored entry from being double-credited.
- **The supported-asset list is admin-controlled.** A malicious or compromised
  admin can add a worthless token. This is the same trust already placed in the
  admin by `set_settlement_contract`.
- **One contract, all assets.** Accepted above.

## Test coverage

64 contract tests, all passing. The ones this issue turns on:

| Invariant | Tests |
|---|---|
| 1 — no balance lost or double-counted | `test_v1_balance_survives_migration`, `test_migrated_balance_is_withdrawable`, `test_deposit_after_migration_accumulates` |
| 2 — assets cannot cross | `test_withdraw_cannot_cross_assets`, `test_balances_are_keyed_by_asset`, `test_withdraw_in_one_asset_leaves_the_other_untouched`, `test_record_payment_debits_only_the_attested_asset` |
| 3 — idempotence | `test_migration_is_idempotent`, `test_repeated_reads_do_not_double_credit`, `test_restored_legacy_entry_is_not_recredited` |
| 4 — no bricking | `test_v2_reads_v1_storage_without_bricking`, `test_reading_config_upgrades_instance_storage`, `test_future_storage_version_rejected` (both contracts) |
| 5 — archived entries explicit | `test_absent_legacy_entry_migrates_to_zero`, `test_third_party_can_migrate_a_dormant_member` |

Plus the same-expense-two-assets case the issue names directly:
`test_same_expense_settled_in_two_assets`.

The pre-existing-state tests do not use `init_pool`. They write v1-shaped
storage directly via `seed_v1_storage` — `Version = 1`, a `PoolConfig`, raw
`Balance(member)` entries, and no `SupportedAssets` — because a migration tested
only against storage it wrote itself is tested against the one case that cannot
go wrong.

## Deployment

**Fresh:** `./scripts/deploy-contract.sh <deployer> <token-id> [oracle-secret]`,
optionally with `EXTRA_POOL_ASSETS="C... C..."` to register more assets.

**Existing v1 pool:** deploy the v2 wasm to the same contract ID, then
`./scripts/migrate-pool.sh <deployer> <pool-id> [member...]`. The script is a
convenience — instance storage upgrades on first read and member balances
migrate on first touch either way. It is idempotent.
