//! Multi-asset settlement pool.
//!
//! ## Why one pool rather than one pool per asset
//!
//! Both shapes are defensible; this one is chosen deliberately.
//!
//! A pool-per-asset deployment keys nothing by token — each contract simply
//! *is* its asset — which makes the storage layout trivial and isolates a bug
//! in one asset from the others. Its cost is operational: adding an asset means
//! deploying and initialising another contract, registering its ID with the
//! settlement contract and the app config, and funding its TTL separately. The
//! settlement contract would need an asset→pool registry to route
//! `record_payment`, so the routing problem does not disappear — it moves into
//! a second mapping that can drift out of sync with reality, and a wrong entry
//! there is exactly the bug this issue is about.
//!
//! One multi-asset pool keyed by `(member, token)` puts the routing in the same
//! ledger entry as the balance it governs. `Balance(member, token)` cannot
//! point at the wrong asset, because the asset is half of its identity. That
//! makes invariant 2 — a settlement in asset A can never withdraw from a
//! balance in asset B — structural rather than something enforced by a check
//! that could be forgotten. It also keeps the inter-contract `withdraw` proof
//! the README advertises intact, against one known pool address.
//!
//! The trade-off accepted: a bug in this contract is a bug for every asset, and
//! one contract's instance storage TTL covers all of them. See
//! `docs/DESIGN_MULTI_ASSET_POOL.md`.
//!
//! ## Migration
//!
//! v1 stored `Balance(member)` against a single `cfg.token`. v2 stores
//! `Balance(member, token)`. Rather than a sweeping migration — impossible
//! anyway, since a contract cannot enumerate its own storage keys — each
//! member's v1 entry is migrated lazily, on first touch, by
//! `migrate_member_balance`. `migrate_balance` exposes the same operation for
//! anyone who wants to migrate an account without transacting.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    token, Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PoolError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,
    BalanceOverflow = 6,
    VersionMismatch = 7,
    InvalidActor = 8,
    AmountTooLarge = 9,
    /// The token is not on this pool's supported-asset list.
    UnsupportedAsset = 10,
    /// Storage carries a version this code has no migration path from.
    UnknownStorageVersion = 11,
    /// The asset list is at `MAX_SUPPORTED_ASSETS`.
    TooManyAssets = 12,
}

/// Pool configuration.
///
/// **The field names here are storage layout.** A `#[contracttype]` struct
/// serialises as an `ScMap` keyed by field-name symbols, so renaming `token`
/// would make every v1-stored `PoolConfig` fail to deserialise — bricking the
/// contract far more thoroughly than a version mismatch would. It keeps its v1
/// name and gains a v2 meaning: the asset v1 balances were denominated in,
/// which is exactly what the migration needs in order to re-key them, and the
/// default asset for this deployment.
#[contracttype]
#[derive(Clone)]
pub struct PoolConfig {
    pub admin: Address,
    pub settlement_contract: Address,
    pub token: Address,
}

/// Storage keys.
///
/// **Variant names are storage layout**, for the same reason as above: a
/// `#[contracttype]` enum serialises with the variant name as a symbol. So
/// `Balance(Address)` keeps its v1 name and v1 meaning — a single-asset balance
/// denominated in `cfg.token` — and the multi-asset layout gets a new name
/// rather than reusing that one with a second field.
#[contracttype]
pub enum PoolDataKey {
    Version,
    Config,
    /// v1 layout, denominated in `cfg.token`. Read and drained by the
    /// migration; never written by v2.
    Balance(Address),
    /// v2 layout: `member`'s balance denominated in `token`.
    AssetBalance(Address, Address),
    /// Marks a member whose v1 `Balance` has been migrated. Presence is what
    /// makes the migration idempotent.
    Migrated(Address),
    /// Tokens this pool accepts.
    SupportedAssets,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolConfigEventV1 {
    pub version: u32,
    pub settlement_contract: Address,
    pub updated_by: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolBalanceEventV1 {
    pub version: u32,
    pub member: Address,
    pub amount: i128,
    pub balance_after: i128,
    pub timestamp: u64,
}

/// Balance movements in v2 carry the asset, since the member alone no longer
/// identifies a balance. Emitted alongside the v1 event so existing indexers
/// keep working.
#[contracttype]
#[derive(Clone)]
pub struct PoolBalanceEventV2 {
    pub version: u32,
    pub member: Address,
    pub token: Address,
    pub amount: i128,
    pub balance_after: i128,
    pub timestamp: u64,
}

/// Emitted once per member when their v1 balance is re-keyed.
#[contracttype]
#[derive(Clone)]
pub struct PoolMigrationEventV1 {
    pub version: u32,
    pub member: Address,
    pub token: Address,
    pub amount_migrated: i128,
    pub timestamp: u64,
}

const LEDGERS_PER_DAY: u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT: u32 = LEDGERS_PER_DAY * 365;

/// Storage layout version this code writes.
const CONTRACT_VERSION: u32 = 2;

/// The oldest layout this code can read and migrate from.
///
/// The v1 code panicked with `VersionMismatch` whenever storage disagreed with
/// the compiled constant, so deploying a v2 wasm over v1 storage would have
/// bricked the contract — every entry point would trap before it could do
/// anything, including a migration. v2 accepts the range `[MIN, CONTRACT]` and
/// migrates forward, which is what makes invariant 4 hold.
const MIN_SUPPORTED_VERSION: u32 = 1;

const MAX_AMOUNT_STROOPS: i128 = 10_000_000_000_000_000;

/// Bounds the supported-asset list so `get_config`-style reads stay cheap and
/// an admin cannot grow instance storage without limit.
const MAX_SUPPORTED_ASSETS: u32 = 32;

#[contract]
pub struct SettlementPoolContract;

#[contractimpl]
impl SettlementPoolContract {
    pub fn init_pool(env: Env, admin: Address, settlement_contract: Address, token: Address) {
        if env.storage().instance().has(&PoolDataKey::Config) {
            panic_with_error!(&env, PoolError::AlreadyInitialized);
        }

        if admin == settlement_contract {
            panic_with_error!(&env, PoolError::InvalidActor);
        }

        admin.require_auth();

        let cfg = PoolConfig {
            admin: admin.clone(),
            settlement_contract: settlement_contract.clone(),
            token: token.clone(),
        };

        // A fresh deployment starts at v2 with the init token as its first
        // supported asset, so it never needs migrating.
        let mut assets = Vec::new(&env);
        assets.push_back(token);

        env.storage().instance().set(&PoolDataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().set(&PoolDataKey::Config, &cfg);
        env.storage().instance().set(&PoolDataKey::SupportedAssets, &assets);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pool_ini"),),
            PoolConfigEventV1 {
                version: CONTRACT_VERSION,
                settlement_contract,
                updated_by: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Reads the stored layout version, accepting anything this code can
    /// migrate from.
    ///
    /// This is the function that stops a v2 deployment over v1 storage from
    /// bricking the contract. The v1 equivalent demanded exact equality, which
    /// meant the first thing a newly deployed wasm did was trap — leaving no
    /// entry point through which to fix it, migration included.
    fn stored_version(env: &Env) -> u32 {
        let version: u32 = env
            .storage()
            .instance()
            .get(&PoolDataKey::Version)
            .unwrap_or_else(|| panic_with_error!(env, PoolError::NotInitialized));

        if version < MIN_SUPPORTED_VERSION || version > CONTRACT_VERSION {
            // A version from the future is genuinely unsafe to interpret —
            // unlike an older one, whose layout is known.
            panic_with_error!(env, PoolError::UnknownStorageVersion);
        }

        version
    }

    /// Brings instance storage up to the current layout.
    ///
    /// Only touches instance-level entries; per-member balances are migrated
    /// lazily on touch, because a contract cannot enumerate its own storage
    /// keys and so cannot sweep them.
    ///
    /// Idempotent: on already-v2 storage it is a no-op.
    fn upgrade_instance_storage(env: &Env) {
        if Self::stored_version(env) >= CONTRACT_VERSION {
            return;
        }

        // v1 → v2. The single `cfg.token` becomes the first supported asset.
        let cfg: PoolConfig = env
            .storage()
            .instance()
            .get(&PoolDataKey::Config)
            .unwrap_or_else(|| panic_with_error!(env, PoolError::NotInitialized));

        if !env.storage().instance().has(&PoolDataKey::SupportedAssets) {
            let mut assets = Vec::new(env);
            assets.push_back(cfg.token);
            env.storage().instance().set(&PoolDataKey::SupportedAssets, &assets);
        }

        env.storage().instance().set(&PoolDataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
    }

    /// Explicit migration entry point.
    ///
    /// Anyone may call it — it moves no value between accounts, it only re-keys
    /// what is already there, and gating it on the admin would mean a member
    /// whose admin has gone away could never reach their own balance. Callable
    /// with no member to upgrade instance storage alone.
    pub fn migrate(env: Env, member: Option<Address>) {
        Self::upgrade_instance_storage(&env);

        if let Some(member) = member {
            let cfg: PoolConfig = env
                .storage()
                .instance()
                .get(&PoolDataKey::Config)
                .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));
            Self::migrate_member_balance(&env, &member, &cfg.token);
        }
    }

    /// Re-keys one member's v1 balance to the v2 `(member, token)` layout.
    ///
    /// Idempotence comes from the `Migrated` marker rather than from the
    /// absence of a v1 entry, because those two states are not the same. A
    /// member with no v1 entry may simply never have deposited — or their entry
    /// may have been archived by TTL expiry, which reads identically. Marking
    /// the member either way means the ambiguity is resolved once and never
    /// revisited, so a v1 entry that gets restored after archival cannot be
    /// credited a second time.
    fn migrate_member_balance(env: &Env, member: &Address, legacy_token: &Address) {
        let marker = PoolDataKey::Migrated(member.clone());
        if env.storage().persistent().has(&marker) {
            return;
        }

        let legacy_key = PoolDataKey::Balance(member.clone());
        // `get` on an archived entry returns None exactly as it does for one
        // that never existed. Treating both as "nothing to move" is the
        // explicit handling invariant 5 asks for: the balance is not assumed
        // present, and its absence is recorded as a decision.
        let legacy_amount: i128 = env.storage().persistent().get(&legacy_key).unwrap_or(0_i128);

        if legacy_amount > 0 {
            let target = PoolDataKey::AssetBalance(member.clone(), legacy_token.clone());
            let current: i128 = env.storage().persistent().get(&target).unwrap_or(0_i128);
            let next = current
                .checked_add(legacy_amount)
                .unwrap_or_else(|| panic_with_error!(env, PoolError::BalanceOverflow));

            env.storage().persistent().set(&target, &next);
            env.storage()
                .persistent()
                .extend_ttl(&target, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

            // Zero the v1 entry as well as marking the member. Either alone
            // would prevent double-crediting; both together mean the old
            // balance is not merely unreachable but demonstrably spent.
            env.storage().persistent().set(&legacy_key, &0_i128);
            env.storage()
                .persistent()
                .extend_ttl(&legacy_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        }

        env.storage().persistent().set(&marker, &true);
        env.storage()
            .persistent()
            .extend_ttl(&marker, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        if legacy_amount > 0 {
            env.events().publish(
                (symbol_short!("pool_mig"), member.clone()),
                PoolMigrationEventV1 {
                    version: CONTRACT_VERSION,
                    member: member.clone(),
                    token: legacy_token.clone(),
                    amount_migrated: legacy_amount,
                    timestamp: env.ledger().timestamp(),
                },
            );
        }
    }

    /// True once `member`'s v1 balance has been accounted for.
    pub fn is_migrated(env: Env, member: Address) -> bool {
        env.storage().persistent().has(&PoolDataKey::Migrated(member))
    }

    /// The layout version currently in storage.
    pub fn get_version(env: Env) -> u32 {
        Self::stored_version(&env)
    }

    pub fn get_config(env: Env) -> PoolConfig {
        Self::upgrade_instance_storage(&env);

        let cfg = env.storage()
            .instance()
            .get(&PoolDataKey::Config)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::NotInitialized));

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        cfg
    }

    /// Tokens this pool accepts.
    pub fn get_supported_assets(env: Env) -> Vec<Address> {
        Self::upgrade_instance_storage(&env);

        env.storage()
            .instance()
            .get(&PoolDataKey::SupportedAssets)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Adds a token to the accepted list. Admin only, idempotent.
    pub fn add_supported_asset(env: Env, token: Address) {
        let cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();

        let mut assets: Vec<Address> = env
            .storage()
            .instance()
            .get(&PoolDataKey::SupportedAssets)
            .unwrap_or_else(|| Vec::new(&env));

        if assets.iter().any(|a| a == token) {
            return;
        }
        if assets.len() >= MAX_SUPPORTED_ASSETS {
            panic_with_error!(&env, PoolError::TooManyAssets);
        }

        assets.push_back(token);
        env.storage().instance().set(&PoolDataKey::SupportedAssets, &assets);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
    }

    /// Panics unless `token` is on the supported list.
    ///
    /// Deliberately not "any token works": an unsupported token could be a
    /// worthless contract a member deposits in order to inflate a balance the
    /// settlement path would then treat as real credit.
    fn require_supported(env: &Env, token: &Address) {
        let assets: Vec<Address> = env
            .storage()
            .instance()
            .get(&PoolDataKey::SupportedAssets)
            .unwrap_or_else(|| Vec::new(env));

        if !assets.iter().any(|a| a == *token) {
            panic_with_error!(env, PoolError::UnsupportedAsset);
        }
    }

    pub fn set_settlement_contract(env: Env, new_contract: Address) {
        // `get_config` upgrades instance storage first, so this works on a
        // contract that is still on the v1 layout.
        let mut cfg = Self::get_config(env.clone());
        cfg.admin.require_auth();

        if new_contract == cfg.admin {
            panic_with_error!(&env, PoolError::InvalidActor);
        }

        cfg.settlement_contract = new_contract;
        env.storage().instance().set(&PoolDataKey::Config, &cfg);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pool_cfg"),),
            PoolConfigEventV1 {
                version: CONTRACT_VERSION,
                settlement_contract: cfg.settlement_contract,
                updated_by: cfg.admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    /// Deposits `amount` of `token` into `member`'s pool credit.
    ///
    /// v1 callers passed no token. `deposit` keeps that arity so existing
    /// clients and the v1 ABI keep working, defaulting to `cfg.token`;
    /// `deposit_asset` is the multi-asset form.
    pub fn deposit(env: Env, member: Address, amount: i128) {
        let cfg = Self::get_config(env.clone());
        Self::deposit_asset(env, member, cfg.token, amount);
    }

    pub fn deposit_asset(env: Env, member: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, PoolError::InvalidAmount);
        }
        if amount > MAX_AMOUNT_STROOPS {
            panic_with_error!(&env, PoolError::AmountTooLarge);
        }

        // Pool credits are authenticated by the member depositing.
        let cfg = Self::get_config(env.clone());
        Self::require_supported(&env, &token);
        member.require_auth();

        // Fold any v1 balance in before touching the v2 entry, so a deposit
        // never races ahead of the migration and leaves the old credit behind.
        Self::migrate_member_balance(&env, &member, &cfg.token);

        // Transfer the token the caller named, not a token from config: those
        // must be the same value or the accounting is a lie.
        let contract_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &token);
        token_client.transfer(&member, &contract_address, &amount);

        let key = PoolDataKey::AssetBalance(member.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0_i128);
        let next = current
            .checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::BalanceOverflow));
        env.storage().persistent().set(&key, &next);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        Self::publish_balance_event(&env, symbol_short!("pool_dep"), &member, &token, amount, next);
    }

    /// v1-compatible withdraw, denominated in `cfg.token`.
    pub fn withdraw(env: Env, from: Address, amount: i128) {
        let cfg = Self::get_config(env.clone());
        Self::withdraw_asset(env, from, cfg.token, amount);
    }

    /// Withdraws `amount` of `token` from `from`'s credit.
    ///
    /// The key includes the token, so this cannot reach a balance denominated
    /// in any other asset — invariant 2 holds by construction rather than by a
    /// check that could be omitted.
    pub fn withdraw_asset(env: Env, from: Address, token: Address, amount: i128) {
        if amount <= 0 {
            panic_with_error!(&env, PoolError::InvalidAmount);
        }
        if amount > MAX_AMOUNT_STROOPS {
            panic_with_error!(&env, PoolError::AmountTooLarge);
        }

        // Ensure pool is initialized before allowing balance operations.
        let cfg = Self::get_config(env.clone());
        Self::require_supported(&env, &token);

        from.require_auth();

        // Migrate first: otherwise a member holding only a v1 balance would be
        // told they have insufficient credit for money they actually have.
        Self::migrate_member_balance(&env, &from, &cfg.token);

        let key = PoolDataKey::AssetBalance(from.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0_i128);

        if current < amount {
            panic_with_error!(&env, PoolError::InsufficientBalance);
        }

        let next = current
            .checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, PoolError::BalanceOverflow));
        env.storage().persistent().set(&key, &next);
        env.storage()
            .persistent()
            .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        // Transfer tokens from the contract back to the user's wallet.
        let contract_address = env.current_contract_address();
        let token_client = token::TokenClient::new(&env, &token);
        token_client.transfer(&contract_address, &from, &amount);

        Self::publish_balance_event(&env, symbol_short!("pool_wdr"), &from, &token, amount, next);
    }

    /// v1-compatible balance read, denominated in `cfg.token`.
    pub fn balance_of(env: Env, member: Address) -> i128 {
        let cfg = Self::get_config(env.clone());
        Self::balance_of_asset(env, member, cfg.token)
    }

    pub fn balance_of_asset(env: Env, member: Address, token: Address) -> i128 {
        let cfg = Self::get_config(env.clone());

        // A read must not be able to hide an unmigrated balance, or a member
        // would be shown zero for credit they still hold.
        Self::migrate_member_balance(&env, &member, &cfg.token);

        let key = PoolDataKey::AssetBalance(member, token);
        let balance: i128 = env.storage()
            .persistent()
            .get(&key)
            .unwrap_or(0_i128);

        // `extend_ttl` traps with MissingValue on a key that was never written,
        // so a read for an account with no balance in this asset must not bump
        // it. Invariant 5 again: absence is a case to handle, not to assume away.
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        }

        balance
    }

    /// Emits both the v1 and v2 balance events.
    ///
    /// The v1 event is kept so indexers built against it keep working; it is
    /// ambiguous under multi-asset (it cannot say which asset moved), which is
    /// why the v2 event exists rather than the v1 one being extended in place.
    fn publish_balance_event(
        env: &Env,
        topic: soroban_sdk::Symbol,
        member: &Address,
        token: &Address,
        amount: i128,
        balance_after: i128,
    ) {
        let timestamp = env.ledger().timestamp();

        env.events().publish(
            (topic.clone(), member.clone()),
            PoolBalanceEventV1 {
                version: CONTRACT_VERSION,
                member: member.clone(),
                amount,
                balance_after,
                timestamp,
            },
        );

        env.events().publish(
            (topic, member.clone(), token.clone()),
            PoolBalanceEventV2 {
                version: CONTRACT_VERSION,
                member: member.clone(),
                token: token.clone(),
                amount,
                balance_after,
                timestamp,
            },
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    macro_rules! setup_pool {
        ($env:ident, $client:ident, $admin:ident, $settlement:ident, $token_addr:ident, $token_admin_client:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettlementPoolContractClient::new(&$env, &contract_id);
            let $admin = Address::generate(&$env);
            let $settlement = Address::generate(&$env);
            let $token_addr = $env.register_stellar_asset_contract($admin.clone());
            let $token_admin_client = token::StellarAssetClient::new(&$env, &$token_addr);
        };
    }

    #[test]
    fn test_init_and_get_config() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, _token_admin_client);

        client.init_pool(&admin, &settlement_contract, &token_addr);
        let cfg = client.get_config();

        assert_eq!(cfg.admin, admin);
        assert_eq!(cfg.settlement_contract, settlement_contract);
    }

    #[test]
    #[should_panic]
    fn test_double_init_rejected() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, _token_admin_client);

        client.init_pool(&admin, &settlement_contract, &token_addr);
        client.init_pool(&admin, &settlement_contract, &token_addr);
    }

    #[test]
    fn test_deposit_and_balance() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, token_admin_client);

        let member = Address::generate(&env);
        token_admin_client.mint(&member, &100_000_000_i128);
        client.init_pool(&admin, &settlement_contract, &token_addr);

        client.deposit(&member, &1_500_000_i128);
        assert_eq!(client.balance_of(&member), 1_500_000_i128);
    }

    #[test]
    fn test_withdraw_reduces_balance() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, token_admin_client);

        let member = Address::generate(&env);
        token_admin_client.mint(&member, &100_000_000_i128);
        client.init_pool(&admin, &settlement_contract, &token_addr);

        client.deposit(&member, &2_000_000_i128);
        client.withdraw(&member, &700_000_i128);

        assert_eq!(client.balance_of(&member), 1_300_000_i128);
    }

    #[test]
    #[should_panic]
    fn test_withdraw_insufficient_rejected() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, token_admin_client);

        let member = Address::generate(&env);
        token_admin_client.mint(&member, &100_000_000_i128);
        client.init_pool(&admin, &settlement_contract, &token_addr);

        client.deposit(&member, &100_000_i128);
        client.withdraw(&member, &200_000_i128);
    }

    #[test]
    fn test_update_settlement_contract() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, _token_admin_client);

        let next_contract = Address::generate(&env);
        client.init_pool(&admin, &settlement_contract, &token_addr);
        client.set_settlement_contract(&next_contract);

        let cfg = client.get_config();
        assert_eq!(cfg.settlement_contract, next_contract);
    }

    #[test]
    #[should_panic]
    fn test_init_rejects_same_admin_and_settlement() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SettlementPoolContract);
        let client = SettlementPoolContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let token = Address::generate(&env);
        client.init_pool(&admin, &admin, &token);
    }

    #[test]
    #[should_panic]
    fn test_deposit_amount_too_large_rejected() {
        setup_pool!(env, client, admin, settlement_contract, token_addr, _token_admin_client);
        let member = Address::generate(&env);

        client.init_pool(&admin, &settlement_contract, &token_addr);
        client.deposit(&member, &(MAX_AMOUNT_STROOPS + 1));
    }

    #[test]
    #[should_panic]
    fn test_deposit_requires_init() {
        setup_pool!(env, client, _admin, _settlement_contract, _token_addr, _token_admin_client);

        let member = Address::generate(&env);
        client.deposit(&member, &1_i128);
    }
}

#[cfg(test)]
mod migration_test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Builds a pool whose storage looks exactly like a live v1 deployment:
    /// `Version = 1`, a `PoolConfig`, and `Balance(member)` entries — and no
    /// `SupportedAssets`, which v1 never wrote.
    ///
    /// This is the "pre-existing state" case the issue asks for. Without it the
    /// migration would only ever be tested against storage it wrote itself,
    /// which is the one case that cannot go wrong.
    fn seed_v1_storage(
        env: &Env,
        contract_id: &Address,
        admin: &Address,
        settlement: &Address,
        token: &Address,
        balances: &[(Address, i128)],
    ) {
        env.as_contract(contract_id, || {
            let cfg = PoolConfig {
                admin: admin.clone(),
                settlement_contract: settlement.clone(),
                token: token.clone(),
            };
            env.storage().instance().set(&PoolDataKey::Version, &1_u32);
            env.storage().instance().set(&PoolDataKey::Config, &cfg);

            for (member, amount) in balances {
                env.storage()
                    .persistent()
                    .set(&PoolDataKey::Balance(member.clone()), amount);
            }
        });
    }

    macro_rules! v1_pool {
        ($env:ident, $client:ident, $contract_id:ident, $admin:ident, $token:ident, $token_admin:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let $contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettlementPoolContractClient::new(&$env, &$contract_id);
            let $admin = Address::generate(&$env);
            let settlement = Address::generate(&$env);
            let $token = $env.register_stellar_asset_contract($admin.clone());
            let $token_admin = token::StellarAssetClient::new(&$env, &$token);
            let _ = &settlement;
        };
    }

    // ── Invariant 4: deploying v2 over v1 storage must not brick ────────────

    /// The headline risk. v1's `get_config` demanded `version == CONTRACT_VERSION`
    /// and trapped otherwise, so a v2 wasm over v1 storage would have failed at
    /// every entry point — including any migration.
    #[test]
    fn test_v2_reads_v1_storage_without_bricking() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[]);

        let cfg = client.get_config();

        assert_eq!(cfg.admin, admin);
        assert_eq!(cfg.token, token);
        assert_eq!(client.get_version(), 2);
    }

    /// Reading config is enough to bring instance storage forward.
    #[test]
    fn test_reading_config_upgrades_instance_storage() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[]);

        client.get_config();

        assert_eq!(client.get_version(), 2);
        // The v1 token becomes the first supported asset, so a migrated pool
        // can still take deposits in the asset it already held.
        assert_eq!(client.get_supported_assets().len(), 1);
        assert_eq!(client.get_supported_assets().get(0).unwrap(), token);
    }

    /// Storage from a version this code does not know is refused rather than
    /// misinterpreted — an older layout is knowable, a newer one is not.
    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_future_storage_version_rejected() {
        v1_pool!(env, client, contract_id, _admin, _token, _token_admin);
        env.as_contract(&contract_id, || {
            env.storage().instance().set(&PoolDataKey::Version, &99_u32);
        });

        client.get_version();
    }

    // ── Invariant 1: no balance lost, unreachable, or double-counted ────────

    #[test]
    fn test_v1_balance_survives_migration() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(member.clone(), 7_500_000)]);

        // Reading through the v1-shaped entry point must surface the old credit.
        assert_eq!(client.balance_of(&member), 7_500_000);
        assert_eq!(client.balance_of_asset(&member, &token), 7_500_000);
        assert!(client.is_migrated(&member));
    }

    /// The money must still be spendable, not merely visible.
    #[test]
    fn test_migrated_balance_is_withdrawable() {
        v1_pool!(env, client, contract_id, admin, token, token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(member.clone(), 5_000_000)]);

        // The pool must actually hold the tokens a v1 deposit would have moved.
        token_admin.mint(&contract_id, &5_000_000);

        client.withdraw(&member, &5_000_000);

        assert_eq!(client.balance_of(&member), 0);
        assert_eq!(token::TokenClient::new(&env, &token).balance(&member), 5_000_000);
    }

    // ── Invariant 3: idempotence ────────────────────────────────────────────

    #[test]
    fn test_migration_is_idempotent() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(member.clone(), 3_000_000)]);

        client.migrate(&Some(member.clone()));
        client.migrate(&Some(member.clone()));
        client.migrate(&Some(member.clone()));

        // Three runs, one credit.
        assert_eq!(client.balance_of_asset(&member, &token), 3_000_000);
    }

    /// Balance reads run the migration too, so the repeat path has to be
    /// exercised through them as well as through the explicit entry point.
    #[test]
    fn test_repeated_reads_do_not_double_credit() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(member.clone(), 2_000_000)]);

        for _ in 0..5 {
            assert_eq!(client.balance_of(&member), 2_000_000);
        }
    }

    /// A deposit landing on an unmigrated account must add to the old balance,
    /// not replace it.
    #[test]
    fn test_deposit_after_migration_accumulates() {
        v1_pool!(env, client, contract_id, admin, token, token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(member.clone(), 1_000_000)]);
        token_admin.mint(&member, &10_000_000);

        client.deposit(&member, &4_000_000);

        assert_eq!(client.balance_of(&member), 5_000_000);
    }

    /// Re-appearance of a v1 entry after the member was marked migrated must
    /// not be credited again. This is the archival-restore case: an entry that
    /// read as absent during migration could come back.
    #[test]
    fn test_restored_legacy_entry_is_not_recredited() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[]);

        // Migrate while the entry is absent — indistinguishable from archived.
        client.migrate(&Some(member.clone()));
        assert!(client.is_migrated(&member));

        // The entry reappears. The marker is what stops it being counted.
        env.as_contract(&contract_id, || {
            env.storage()
                .persistent()
                .set(&PoolDataKey::Balance(member.clone()), &9_999_999_i128);
        });

        assert_eq!(client.balance_of_asset(&member, &token), 0);
    }

    // ── Invariant 5: archived entries handled explicitly ────────────────────

    /// A member who never deposited, and a member whose entry was archived,
    /// read identically. Both must migrate cleanly to zero rather than trap.
    #[test]
    fn test_absent_legacy_entry_migrates_to_zero() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let never_seen = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[]);

        client.migrate(&Some(never_seen.clone()));

        assert!(client.is_migrated(&never_seen));
        assert_eq!(client.balance_of_asset(&never_seen, &token), 0);
    }

    /// A member who never interacts again is not required to: anyone can
    /// migrate any account, since it moves no value between parties.
    #[test]
    fn test_third_party_can_migrate_a_dormant_member() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        let dormant = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[(dormant.clone(), 6_000_000)]);

        client.migrate(&Some(dormant.clone()));

        assert_eq!(client.balance_of_asset(&dormant, &token), 6_000_000);
    }

    #[test]
    fn test_migrate_with_no_member_upgrades_instance_only() {
        v1_pool!(env, client, contract_id, admin, token, _token_admin);
        let settlement = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token, &[]);

        client.migrate(&None);

        assert_eq!(client.get_version(), 2);
    }

    // ── Invariant 2: assets cannot cross ────────────────────────────────────

    #[test]
    fn test_balances_are_keyed_by_asset() {
        v1_pool!(env, client, _contract_id, admin, token_a, token_admin_a);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(admin.clone());
        let token_admin_b = token::StellarAssetClient::new(&env, &token_b);

        client.init_pool(&admin, &settlement, &token_a);
        client.add_supported_asset(&token_b);

        token_admin_a.mint(&member, &10_000_000);
        token_admin_b.mint(&member, &10_000_000);
        client.deposit_asset(&member, &token_a, &4_000_000);
        client.deposit_asset(&member, &token_b, &6_000_000);

        assert_eq!(client.balance_of_asset(&member, &token_a), 4_000_000);
        assert_eq!(client.balance_of_asset(&member, &token_b), 6_000_000);
    }

    /// The bug this issue exists to fix: a withdraw in asset B must not be able
    /// to reach a balance held in asset A.
    #[test]
    #[should_panic(expected = "Error(Contract, #5)")]
    fn test_withdraw_cannot_cross_assets() {
        v1_pool!(env, client, _contract_id, admin, token_a, token_admin_a);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(admin.clone());

        client.init_pool(&admin, &settlement, &token_a);
        client.add_supported_asset(&token_b);

        token_admin_a.mint(&member, &10_000_000);
        client.deposit_asset(&member, &token_a, &5_000_000);

        // Funded in A only. Withdrawing B must fail on insufficient balance,
        // not silently drain the A balance.
        client.withdraw_asset(&member, &token_b, &5_000_000);
    }

    #[test]
    fn test_withdraw_in_one_asset_leaves_the_other_untouched() {
        v1_pool!(env, client, contract_id, admin, token_a, token_admin_a);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(admin.clone());
        let token_admin_b = token::StellarAssetClient::new(&env, &token_b);

        client.init_pool(&admin, &settlement, &token_a);
        client.add_supported_asset(&token_b);

        token_admin_a.mint(&member, &10_000_000);
        token_admin_b.mint(&member, &10_000_000);
        let _ = &contract_id;
        client.deposit_asset(&member, &token_a, &5_000_000);
        client.deposit_asset(&member, &token_b, &5_000_000);

        client.withdraw_asset(&member, &token_a, &2_000_000);

        assert_eq!(client.balance_of_asset(&member, &token_a), 3_000_000);
        assert_eq!(client.balance_of_asset(&member, &token_b), 5_000_000);
    }

    /// An arbitrary token must not be depositable: otherwise a member could
    /// mint a worthless contract and have the settlement path treat the
    /// resulting credit as real.
    #[test]
    #[should_panic(expected = "Error(Contract, #10)")]
    fn test_unsupported_asset_rejected() {
        v1_pool!(env, client, _contract_id, admin, token_a, _token_admin_a);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        let rogue = env.register_stellar_asset_contract(admin.clone());

        client.init_pool(&admin, &settlement, &token_a);
        client.deposit_asset(&member, &rogue, &1_000_000);
    }

    #[test]
    fn test_add_supported_asset_is_idempotent() {
        v1_pool!(env, client, _contract_id, admin, token_a, _token_admin_a);
        let settlement = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(admin.clone());

        client.init_pool(&admin, &settlement, &token_a);
        client.add_supported_asset(&token_b);
        client.add_supported_asset(&token_b);

        assert_eq!(client.get_supported_assets().len(), 2);
    }

    /// A v1 pool that migrates must be able to take on a second asset.
    #[test]
    fn test_migrated_pool_accepts_a_second_asset() {
        v1_pool!(env, client, contract_id, admin, token_a, _token_admin_a);
        let settlement = Address::generate(&env);
        let member = Address::generate(&env);
        seed_v1_storage(&env, &contract_id, &admin, &settlement, &token_a, &[(member.clone(), 1_000_000)]);

        let token_b = env.register_stellar_asset_contract(admin.clone());
        let token_admin_b = token::StellarAssetClient::new(&env, &token_b);
        client.add_supported_asset(&token_b);

        token_admin_b.mint(&member, &10_000_000);
        client.deposit_asset(&member, &token_b, &2_000_000);

        // Old credit in A intact, new credit in B alongside it.
        assert_eq!(client.balance_of_asset(&member, &token_a), 1_000_000);
        assert_eq!(client.balance_of_asset(&member, &token_b), 2_000_000);
    }
}
