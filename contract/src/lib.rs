#![no_std]

pub mod attest;
pub mod pool;

use crate::attest::{verify_claim, Attestation, Claim};
use crate::pool::SettlementPoolContractClient;
use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, panic_with_error, symbol_short,
    Address, BytesN, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ContractError {
    InvalidAmount      = 1,
    AlreadyPaid        = 2,
    EmptyId            = 3,
    AlreadyInitialized = 4,
    NotInitialized     = 5,
    InvalidActor       = 6,
    IdTooLong          = 7,
    AmountTooLarge     = 8,
    VersionMismatch    = 9,
    TxHashTooLong      = 10,
    /// The attestation's `expires_at` is in the past.
    AttestationExpired = 11,
    /// The attestation's nonce has already been burned by an earlier call.
    AttestationReplayed = 12,
    /// `expires_at` is further out than `MAX_ATTESTATION_TTL_SECS` allows.
    AttestationTtlTooLong = 13,
    /// The attested asset is not this deployment's settlement asset.
    AssetMismatch      = 14,
    /// Storage carries a version newer than this code knows how to read.
    UnknownStorageVersion = 15,
}

#[contracttype]
#[derive(Clone)]
pub struct PaymentRecord {
    pub expense_id: String,
    pub payer:      Address,
    pub member:     Address,
    pub amount:     i128,
    pub tx_hash:    String,
    pub timestamp:  u64,
}

#[contracttype]
#[derive(Clone)]
pub struct PaymentEventV1 {
    pub version:     u32,
    pub expense_id:  String,
    pub payer:       Address,
    pub member:      Address,
    pub amount:      i128,
    pub tx_hash:     String,
    pub timestamp:   u64,
}

#[contracttype]
#[derive(Clone)]
pub struct PoolConfigEventV1 {
    pub version:      u32,
    pub pool_contract: Address,
    pub updated_by:   Address,
    pub timestamp:    u64,
}

#[contracttype]
#[derive(Clone)]
pub struct OracleConfigEventV1 {
    pub version:    u32,
    pub oracle_key: BytesN<32>,
    pub updated_by: Address,
    pub timestamp:  u64,
}

#[contracttype]
pub enum DataKey {
    TripPayments(String),
    ExpensePaid(String, Address),
    Admin,
    PoolContract,
    Version,
    /// Raw ed25519 public key of the attestation oracle.
    OracleKey,
    /// The asset this deployment settles in.
    ///
    /// The *pool* is multi-asset as of #145, so a balance can no longer be
    /// debited in the wrong denomination. This contract still pins one
    /// settlement asset, because the attestation oracle signs claims for one
    /// asset and widening that is a separate change; what #145 fixed is that
    /// the debit now follows the attested asset rather than the pool's default.
    SettlementAsset,
    /// Burned attestation nonces. Presence == already consumed.
    UsedNonce(BytesN<32>),
}

const LEDGERS_PER_DAY:        u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT:    u32 = LEDGERS_PER_DAY * 365;
/// Bumped from 1: `record_payment` gained a mandatory attestation argument and
/// instance storage gained the oracle key and settlement asset.
const CONTRACT_VERSION:       u32 = 2;
const MAX_ID_LEN:             u32 = 64;
const MAX_TX_HASH_LEN:        u32 = 128;
const MAX_AMOUNT_STROOPS:     i128 = 10_000_000_000_000_000;

/// Upper bound on an attestation's validity window.
///
/// Bounding this is what limits the blast radius of a stolen oracle key: an
/// attacker who signs a batch of claims still has only this long to land them
/// before every one of them is dead, and rotating the key via `set_oracle_key`
/// kills them immediately.
const MAX_ATTESTATION_TTL_SECS: u64 = 900;

/// Nonces must outlive any attestation that could still reference them, or a
/// replay would succeed after the burn record expired. A full storage bump is
/// wildly more than `MAX_ATTESTATION_TTL_SECS` requires, which is the point.
const NONCE_BUMP_AMOUNT: u32 = STORAGE_BUMP_AMOUNT;

#[contract]
pub struct SettleXContract;

#[contractimpl]
impl SettleXContract {

    pub fn init(
        env:              Env,
        admin:            Address,
        pool_contract:    Address,
        oracle_key:       BytesN<32>,
        settlement_asset: Address,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, ContractError::AlreadyInitialized);
        }

        if admin == pool_contract {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        admin.require_auth();
        env.storage().instance().set(&DataKey::Version, &CONTRACT_VERSION);
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::PoolContract, &pool_contract);
        env.storage().instance().set(&DataKey::OracleKey, &oracle_key);
        env.storage().instance().set(&DataKey::SettlementAsset, &settlement_asset);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish((symbol_short!("stx_ini"),), CONTRACT_VERSION);
    }

    /// Rotates the attestation oracle key.
    ///
    /// This is the compromise response: every attestation signed by the old key
    /// stops verifying on the next ledger, without touching any recorded
    /// payment. Deliberately admin-gated and deliberately not the oracle's own
    /// privilege — a compromised oracle must not be able to re-anchor trust in
    /// itself.
    pub fn set_oracle_key(env: Env, oracle_key: BytesN<32>) {
        let admin = Self::require_admin(&env);

        env.storage().instance().set(&DataKey::OracleKey, &oracle_key);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("orcl_cfg"),),
            OracleConfigEventV1 {
                version: CONTRACT_VERSION,
                oracle_key,
                updated_by: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    pub fn get_oracle_key(env: Env) -> BytesN<32> {
        Self::require_version(&env);
        env.storage()
            .instance()
            .get(&DataKey::OracleKey)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized))
    }

    pub fn get_settlement_asset(env: Env) -> Address {
        Self::require_version(&env);
        env.storage()
            .instance()
            .get(&DataKey::SettlementAsset)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized))
    }

    /// True once the attestation's nonce has been burned, so a client can tell
    /// "my submission landed" from "my submission never arrived" after a
    /// timeout, without guessing.
    pub fn is_nonce_used(env: Env, nonce: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::UsedNonce(nonce))
    }

    /// Checks the stored layout version, accepting anything this code can read.
    ///
    /// Exact equality — what this used to demand — means a newly deployed wasm
    /// traps at every entry point when it meets older storage, leaving no way
    /// in to fix it. Older versions are refused here rather than migrated
    /// because a v1 settlement contract has no oracle key and no settlement
    /// asset, so there is nothing to migrate *from*: it must be re-initialised.
    /// A version from the future is refused because its layout is unknowable.
    fn require_version(env: &Env) {
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized));
        if version > CONTRACT_VERSION {
            panic_with_error!(env, ContractError::UnknownStorageVersion);
        }
        if version != CONTRACT_VERSION {
            panic_with_error!(env, ContractError::VersionMismatch);
        }
    }

    /// Checks the version, loads the admin, and requires its authorisation.
    fn require_admin(env: &Env) -> Address {
        Self::require_version(env);
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, ContractError::NotInitialized));
        admin.require_auth();
        admin
    }

    pub fn set_pool_contract(env: Env, pool_contract: Address) {
        let admin = Self::require_admin(&env);

        if pool_contract == admin {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        env.storage().instance().set(&DataKey::PoolContract, &pool_contract);
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pool_cfg"),),
            PoolConfigEventV1 {
                version: CONTRACT_VERSION,
                pool_contract,
                updated_by: admin,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    pub fn get_pool_contract(env: Env) -> Address {
        Self::require_version(&env);

        let pool = env.storage()
            .instance()
            .get(&DataKey::PoolContract)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        pool
    }

    /// Records a settlement, and will only do so against a valid attestation.
    ///
    /// The `attestation` argument is mandatory. Without it there is no way for
    /// this contract to distinguish a real payment from a string a caller made
    /// up, which was the entire trust hole: `stellar contract invoke` with a
    /// fabricated `tx_hash` used to succeed. It cannot now — the oracle's
    /// signature covers every argument below, so a tampered field produces a
    /// different message and the signature stops verifying.
    ///
    /// Ordering matters here. Attestation checks and the nonce burn happen
    /// *before* the inter-contract pool withdraw, so an unattested call can
    /// never move a member's pool credit, not even transiently.
    pub fn record_payment(
        env:         Env,
        trip_id:     String,
        expense_id:  String,
        payer:       Address,
        member:      Address,
        amount:      i128,
        tx_hash:     String,
        attestation: Attestation,
    ) {
        member.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, ContractError::InvalidAmount);
        }
        if amount > MAX_AMOUNT_STROOPS {
            panic_with_error!(&env, ContractError::AmountTooLarge);
        }
        if payer == member {
            panic_with_error!(&env, ContractError::InvalidActor);
        }
        if trip_id.len() == 0 || expense_id.len() == 0 || tx_hash.len() == 0 {
            panic_with_error!(&env, ContractError::EmptyId);
        }
        if trip_id.len() > MAX_ID_LEN || expense_id.len() > MAX_ID_LEN {
            panic_with_error!(&env, ContractError::IdTooLong);
        }
        if tx_hash.len() > MAX_TX_HASH_LEN {
            panic_with_error!(&env, ContractError::TxHashTooLong);
        }

        Self::require_version(&env);

        let paid_key = DataKey::ExpensePaid(expense_id.clone(), member.clone());
        if env.storage().persistent().has(&paid_key) {
            panic_with_error!(&env, ContractError::AlreadyPaid);
        }

        // ── Attestation gate ──────────────────────────────────────────────────
        // Everything below this comment must pass before any state changes or
        // value moves.

        // Single-asset deployment: the attested asset must be the one this
        // contract settles in, otherwise an attestation minted for some other
        // asset would authorise a debit denominated in this one. Multi-asset
        // routing is #43; until then the check is an equality, not a lookup.
        let settlement_asset = Self::get_settlement_asset(env.clone());
        if attestation.asset != settlement_asset {
            panic_with_error!(&env, ContractError::AssetMismatch);
        }

        let now = env.ledger().timestamp();
        if attestation.expires_at <= now {
            panic_with_error!(&env, ContractError::AttestationExpired);
        }
        if attestation.expires_at - now > MAX_ATTESTATION_TTL_SECS {
            panic_with_error!(&env, ContractError::AttestationTtlTooLong);
        }

        // Rebuilt from the call's own arguments, never from anything the
        // caller could restate independently of what gets stored.
        let claim = Claim {
            trip_id:    &trip_id,
            expense_id: &expense_id,
            payer:      &payer,
            member:     &member,
            amount,
            tx_hash:    &tx_hash,
            asset:      &attestation.asset,
            nonce:      &attestation.nonce,
            expires_at: attestation.expires_at,
        };
        let oracle_key = Self::get_oracle_key(env.clone());
        verify_claim(&env, &oracle_key, &claim, &attestation.signature);

        // Burn the nonce. `has`-then-`set` is atomic with respect to other
        // submissions because it happens inside one ledger entry's footprint:
        // two transactions racing on the same nonce conflict, and the loser is
        // re-simulated against the burned entry and rejected here. This holds
        // regardless of how many oracle instances minted attestations, since
        // the contract — not the oracle — is what makes consumption final.
        let nonce_key = DataKey::UsedNonce(attestation.nonce.clone());
        if env.storage().persistent().has(&nonce_key) {
            panic_with_error!(&env, ContractError::AttestationReplayed);
        }
        env.storage().persistent().set(&nonce_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, STORAGE_BUMP_THRESHOLD, NONCE_BUMP_AMOUNT);

        // ── Attested from here on. ────────────────────────────────────────────

        // Inter-contract call: settlement contract consumes member funds from
        // pool balance, denominated in the attested asset.
        //
        // This is the fix for #145. It used to call `withdraw`, which was
        // hard-wired to the pool's single `cfg.token` — so a settlement in one
        // asset would debit a balance in another. `withdraw_asset` keys the
        // debit by the asset the attestation names, and that asset was already
        // checked against this deployment's settlement asset above.
        let pool_contract = Self::get_pool_contract(env.clone());
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract);
        pool_client.withdraw_asset(&member, &attestation.asset, &amount);

        let record = PaymentRecord {
            expense_id: expense_id.clone(),
            payer: payer.clone(),
            member:    member.clone(),
            amount,
            tx_hash: tx_hash.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let trip_key = DataKey::TripPayments(trip_id.clone());
        let mut payments: Vec<PaymentRecord> = env
            .storage()
            .persistent()
            .get(&trip_key)
            .unwrap_or_else(|| Vec::new(&env));
        payments.push_back(record);
        env.storage().persistent().set(&trip_key, &payments);
        env.storage()
            .persistent()
            .extend_ttl(&trip_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.storage().persistent().set(&paid_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&paid_key, STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("pmt_rec"), trip_id),
            PaymentEventV1 {
                version: CONTRACT_VERSION,
                expense_id,
                payer,
                member,
                amount,
                tx_hash,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    pub fn get_payments(env: Env, trip_id: String) -> Vec<PaymentRecord> {
        let key = DataKey::TripPayments(trip_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn is_paid(env: Env, expense_id: String, member: Address) -> bool {
        let key = DataKey::ExpensePaid(expense_id, member);
        env.storage().persistent().has(&key)
    }
}


#[cfg(test)]
mod test {
    use super::*;
    use crate::attest::{claim_message, Attestation, Claim};
    use crate::pool::{SettlementPoolContract, SettlementPoolContractClient};
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Address, Bytes, BytesN, Env, String,
    };

    /// Deterministic stand-in for the off-chain oracle's signing key.
    fn oracle_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn oracle_public_key(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &oracle_signing_key().verifying_key().to_bytes())
    }

    fn sign_message(env: &Env, key: &SigningKey, message: &Bytes) -> BytesN<64> {
        let mut buf = [0u8; 2048];
        let len = message.len() as usize;
        message.copy_into_slice(&mut buf[..len]);
        BytesN::from_array(env, &key.sign(&buf[..len]).to_bytes())
    }

    /// Everything a `record_payment` call needs, so tests can tamper with one
    /// field at a time and re-derive (or deliberately not re-derive) the
    /// signature.
    struct ClaimFixture {
        trip_id: String,
        expense_id: String,
        payer: Address,
        member: Address,
        amount: i128,
        tx_hash: String,
        asset: Address,
        nonce: BytesN<32>,
        expires_at: u64,
    }

    impl ClaimFixture {
        fn as_claim(&self) -> Claim<'_> {
            Claim {
                trip_id: &self.trip_id,
                expense_id: &self.expense_id,
                payer: &self.payer,
                member: &self.member,
                amount: self.amount,
                tx_hash: &self.tx_hash,
                asset: &self.asset,
                nonce: &self.nonce,
                expires_at: self.expires_at,
            }
        }
    }

    /// Signs the fixture *as the settlement contract would rebuild it*.
    ///
    /// `claim_message` reads `env.current_contract_address()`, so it has to run
    /// inside the contract's own context — hence `as_contract`.
    fn attest(
        env: &Env,
        contract_id: &Address,
        fixture: &ClaimFixture,
        key: &SigningKey,
    ) -> Attestation {
        let signature = env.as_contract(contract_id, || {
            let message = claim_message(env, &fixture.as_claim());
            sign_message(env, key, &message)
        });

        Attestation {
            asset: fixture.asset.clone(),
            nonce: fixture.nonce.clone(),
            expires_at: fixture.expires_at,
            signature,
        }
    }

    fn record(client: &SettleXContractClient, f: &ClaimFixture, a: &Attestation) {
        client.record_payment(
            &f.trip_id,
            &f.expense_id,
            &f.payer,
            &f.member,
            &f.amount,
            &f.tx_hash,
            a,
        );
    }

    macro_rules! setup {
        ($env:ident, $client:ident, $contract_id:ident, $pool_client:ident, $token_addr:ident, $token_admin_client:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            $env.ledger().with_mut(|l| l.timestamp = 1_000_000);

            let settlement_contract_id = $env.register_contract(None, SettleXContract);
            let pool_contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettleXContractClient::new(&$env, &settlement_contract_id);
            let $pool_client = SettlementPoolContractClient::new(&$env, &pool_contract_id);
            let $contract_id = settlement_contract_id.clone();

            let admin = Address::generate(&$env);
            let $token_addr = $env.register_stellar_asset_contract(admin.clone());
            let $token_admin_client =
                soroban_sdk::token::StellarAssetClient::new(&$env, &$token_addr);

            $pool_client.init_pool(&admin, &settlement_contract_id, &$token_addr);
            $client.init(
                &admin,
                &pool_contract_id,
                &oracle_public_key(&$env),
                &$token_addr,
            );
        };
    }

    /// A funded member with a well-formed claim, ready to be tampered with.
    fn fixture(
        env: &Env,
        pool_client: &SettlementPoolContractClient,
        token_admin_client: &soroban_sdk::token::StellarAssetClient,
        asset: &Address,
        trip: &str,
        expense: &str,
        tx: &str,
        amount: i128,
        nonce_seed: u8,
    ) -> ClaimFixture {
        let member = Address::generate(env);
        token_admin_client.mint(&member, &(amount * 10));
        pool_client.deposit(&member, &(amount * 2));

        ClaimFixture {
            trip_id: String::from_str(env, trip),
            expense_id: String::from_str(env, expense),
            payer: Address::generate(env),
            member,
            amount,
            tx_hash: String::from_str(env, tx),
            asset: asset.clone(),
            nonce: BytesN::from_array(env, &[nonce_seed; 32]),
            expires_at: env.ledger().timestamp() + 300,
        }
    }

    // ── Happy path ───────────────────────────────────────────────────────────

    #[test]
    fn test_record_and_query() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-123", "exp-456", "abc123def456", 10_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        assert!(!client.is_paid(&f.expense_id, &f.member));
        assert_eq!(client.get_payments(&f.trip_id).len(), 0);
        assert!(!client.is_nonce_used(&f.nonce));

        record(&client, &f, &a);

        assert!(client.is_paid(&f.expense_id, &f.member));
        assert!(client.is_nonce_used(&f.nonce));

        let payments = client.get_payments(&f.trip_id);
        assert_eq!(payments.len(), 1);
        let rec = payments.get(0).unwrap();
        assert_eq!(rec.amount, 10_000_000_i128);
        assert_eq!(rec.expense_id, f.expense_id);
        assert_eq!(pool_client.balance_of(&f.member), 10_000_000_i128);
    }

    #[test]
    fn test_multiple_members() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let a1 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-multi", "exp-multi", "hash_a", 5_000_000, 1,
        );
        let mut b1 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-multi", "exp-multi", "hash_b", 7_500_000, 2,
        );
        b1.payer = a1.payer.clone();

        let att_a = attest(&env, &contract_id, &a1, &oracle_signing_key());
        let att_b = attest(&env, &contract_id, &b1, &oracle_signing_key());
        record(&client, &a1, &att_a);
        record(&client, &b1, &att_b);

        assert!(client.is_paid(&a1.expense_id, &a1.member));
        assert!(client.is_paid(&b1.expense_id, &b1.member));
        assert_eq!(client.get_payments(&a1.trip_id).len(), 2);
    }

    #[test]
    fn test_multiple_expenses_same_trip() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f1 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-abc", "exp-001", "tx_001", 3_000_000, 1,
        );
        let mut f2 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-abc", "exp-002", "tx_002", 4_500_000, 2,
        );
        f2.member = f1.member.clone();
        f2.payer = f1.payer.clone();
        // `fixture` funded f2's own generated member; top up the one it now uses.
        pool_client.deposit(&f2.member, &(f2.amount * 2));

        record(&client, &f1, &attest(&env, &contract_id, &f1, &oracle_signing_key()));
        record(&client, &f2, &attest(&env, &contract_id, &f2, &oracle_signing_key()));

        assert!(client.is_paid(&f1.expense_id, &f1.member));
        assert!(client.is_paid(&f2.expense_id, &f2.member));
        assert_eq!(client.get_payments(&f1.trip_id).len(), 2);
    }

    // ── Adversarial: forgery ─────────────────────────────────────────────────

    /// A signature from a key that is not the configured oracle's.
    #[test]
    #[should_panic]
    fn test_forged_signature_from_wrong_key_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-forge", "exp-forge", "tx-forge", 1_000_000, 1,
        );
        let attacker_key = SigningKey::from_bytes(&[9u8; 32]);
        let a = attest(&env, &contract_id, &f, &attacker_key);

        record(&client, &f, &a);
    }

    /// The original hole: a fabricated tx_hash with no attestation behind it.
    /// There is no longer a call shape that expresses this, so the closest a
    /// direct invoker can get is garbage bytes in the signature field.
    #[test]
    #[should_panic]
    fn test_unattested_fabricated_tx_hash_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-fab", "exp-fab", "totally-made-up-hash", 1_000_000, 1,
        );
        let _ = contract_id;

        let a = Attestation {
            asset: f.asset.clone(),
            nonce: f.nonce.clone(),
            expires_at: f.expires_at,
            signature: BytesN::from_array(&env, &[0u8; 64]),
        };
        record(&client, &f, &a);
    }

    /// An attestation signed against a *different* settlement contract must not
    /// verify here — `claim_message` binds `current_contract_address`.
    #[test]
    #[should_panic]
    fn test_attestation_for_other_contract_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let other_contract = env.register_contract(None, SettleXContract);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-cross", "exp-cross", "tx-cross", 1_000_000, 1,
        );
        let _ = contract_id;

        let a = attest(&env, &other_contract, &f, &oracle_signing_key());
        record(&client, &f, &a);
    }

    // ── Adversarial: replay ──────────────────────────────────────────────────

    /// The same attestation submitted twice. Blocked by the nonce burn — note
    /// this is a *different* guard from `AlreadyPaid`, and the next test proves
    /// the nonce guard stands on its own.
    #[test]
    #[should_panic]
    fn test_attestation_replay_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-replay", "exp-replay", "tx-replay", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        record(&client, &f, &a);
        record(&client, &f, &a);
    }

    /// Nonce reuse across two claims that `AlreadyPaid` would happily allow:
    /// different expense, different everything except the nonce. The second
    /// call carries a correctly signed attestation, so only the burn stops it.
    #[test]
    #[should_panic]
    fn test_nonce_reuse_across_distinct_claims_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f1 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-n", "exp-n-1", "tx-n-1", 1_000_000, 1,
        );
        let mut f2 = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-n", "exp-n-2", "tx-n-2", 1_000_000, 2,
        );
        f2.nonce = f1.nonce.clone();

        record(&client, &f1, &attest(&env, &contract_id, &f1, &oracle_signing_key()));
        record(&client, &f2, &attest(&env, &contract_id, &f2, &oracle_signing_key()));
    }

    // ── Adversarial: cross-expense / cross-trip reuse ────────────────────────

    /// One attestation, applied to a different expense. This is the "reuse one
    /// attestation across the trip" attack.
    #[test]
    #[should_panic]
    fn test_cross_expense_reuse_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-x", "exp-x-1", "tx-x", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let mut other = f;
        other.expense_id = String::from_str(&env, "exp-x-2");
        record(&client, &other, &a);
    }

    /// The same, one level up: same expense id, different trip.
    #[test]
    #[should_panic]
    fn test_cross_trip_reuse_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-y-1", "exp-y", "tx-y", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let mut other = f;
        other.trip_id = String::from_str(&env, "trip-y-2");
        record(&client, &other, &a);
    }

    // ── Adversarial: field tampering ─────────────────────────────────────────

    /// Inflating the amount after the oracle signed it.
    #[test]
    #[should_panic]
    fn test_tampered_amount_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-t", "exp-t", "tx-t", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let mut tampered = f;
        tampered.amount = 5_000_000;
        record(&client, &tampered, &a);
    }

    /// Swapping in a tx_hash the oracle never saw.
    #[test]
    #[should_panic]
    fn test_tampered_tx_hash_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-th", "exp-th", "tx-real", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let mut tampered = f;
        tampered.tx_hash = String::from_str(&env, "tx-substituted");
        record(&client, &tampered, &a);
    }

    /// Redirecting the credit to a different payer.
    #[test]
    #[should_panic]
    fn test_tampered_payer_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-tp", "exp-tp", "tx-tp", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let mut tampered = f;
        tampered.payer = Address::generate(&env);
        record(&client, &tampered, &a);
    }

    /// Claiming someone else's attested payment as your own settlement.
    #[test]
    #[should_panic]
    fn test_tampered_member_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-tm", "exp-tm", "tx-tm", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let other = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-tm", "exp-tm", "tx-tm", 1_000_000, 2,
        );
        let mut tampered = f;
        tampered.member = other.member;
        record(&client, &tampered, &a);
    }

    /// Extending the validity window after signing.
    #[test]
    #[should_panic]
    fn test_tampered_expiry_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-te", "exp-te", "tx-te", 1_000_000, 1,
        );
        let mut a = attest(&env, &contract_id, &f, &oracle_signing_key());
        a.expires_at = f.expires_at + 60;

        record(&client, &f, &a);
    }

    /// Swapping the nonce for a fresh one to dodge the burn.
    #[test]
    #[should_panic]
    fn test_tampered_nonce_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-tn", "exp-tn", "tx-tn", 1_000_000, 1,
        );
        let mut a = attest(&env, &contract_id, &f, &oracle_signing_key());
        a.nonce = BytesN::from_array(&env, &[42u8; 32]);

        record(&client, &f, &a);
    }

    // ── Adversarial: expiry, asset, rotation ─────────────────────────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #11)")]
    fn test_expired_attestation_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-exp", "exp-exp", "tx-exp", 1_000_000, 1,
        );
        f.expires_at = env.ledger().timestamp() + 60;
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        env.ledger().with_mut(|l| l.timestamp += 120);
        record(&client, &f, &a);
    }

    /// A signature that is valid but promises a window longer than the contract
    /// is willing to honour.
    #[test]
    #[should_panic(expected = "Error(Contract, #13)")]
    fn test_overlong_attestation_ttl_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-ttl", "exp-ttl", "tx-ttl", 1_000_000, 1,
        );
        f.expires_at = env.ledger().timestamp() + MAX_ATTESTATION_TTL_SECS + 1;
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        record(&client, &f, &a);
    }

    /// An attestation for some other asset must not authorise a debit here.
    #[test]
    #[should_panic(expected = "Error(Contract, #14)")]
    fn test_asset_mismatch_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let other_admin = Address::generate(&env);
        let other_asset = env.register_stellar_asset_contract(other_admin);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-as", "exp-as", "tx-as", 1_000_000, 1,
        );
        f.asset = other_asset;
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        record(&client, &f, &a);
    }

    /// After rotation, attestations from the retired key stop working.
    #[test]
    #[should_panic]
    fn test_rotated_oracle_key_invalidates_old_attestations() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-rot", "exp-rot", "tx-rot", 1_000_000, 1,
        );
        let a = attest(&env, &contract_id, &f, &oracle_signing_key());

        let next_key = SigningKey::from_bytes(&[11u8; 32]);
        client.set_oracle_key(&BytesN::from_array(
            &env,
            &next_key.verifying_key().to_bytes(),
        ));

        record(&client, &f, &a);
    }

    #[test]
    fn test_rotated_oracle_key_accepts_new_attestations() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let next_key = SigningKey::from_bytes(&[11u8; 32]);
        client.set_oracle_key(&BytesN::from_array(
            &env,
            &next_key.verifying_key().to_bytes(),
        ));

        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-rot2", "exp-rot2", "tx-rot2", 1_000_000, 1,
        );
        record(&client, &f, &attest(&env, &contract_id, &f, &next_key));

        assert!(client.is_paid(&f.expense_id, &f.member));
    }

    /// No pool credit is consumed by a call that fails the attestation gate.
    /// The withdraw sits after the gate precisely so this holds.
    #[test]
    fn test_rejected_attestation_leaves_pool_balance_untouched() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-pool", "exp-pool", "tx-pool", 1_000_000, 1,
        );
        let _ = contract_id;
        let before = pool_client.balance_of(&f.member);

        let forged = Attestation {
            asset: f.asset.clone(),
            nonce: f.nonce.clone(),
            expires_at: f.expires_at,
            signature: BytesN::from_array(&env, &[0u8; 64]),
        };
        assert!(client.try_record_payment(
            &f.trip_id, &f.expense_id, &f.payer, &f.member,
            &f.amount, &f.tx_hash, &forged,
        ).is_err());

        assert_eq!(pool_client.balance_of(&f.member), before);
        assert!(!client.is_paid(&f.expense_id, &f.member));
        assert!(!client.is_nonce_used(&f.nonce));
    }

    // ── Pre-existing argument validation, now with attestations ──────────────

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_duplicate_payment_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-dup", "exp-dup", "hash_dup", 1_000_000, 1,
        );
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));

        // A genuinely fresh attestation for the same expense — proves the
        // AlreadyPaid guard is not doing the nonce's job or vice versa.
        let mut second = f;
        second.nonce = BytesN::from_array(&env, &[2u8; 32]);
        record(&client, &second, &attest(&env, &contract_id, &second, &oracle_signing_key()));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_zero_amount_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-zero", "exp-zero", "hash_zero", 1_000_000, 1,
        );
        f.amount = 0;
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_negative_amount_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-neg", "exp-neg", "hash_neg", 1_000_000, 1,
        );
        f.amount = -1;
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_empty_tx_hash_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-empty-tx", "exp-empty-tx", "placeholder", 1_000_000, 1,
        );
        f.tx_hash = String::from_str(&env, "");
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #6)")]
    fn test_payer_cannot_equal_member() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-role", "exp-role", "hash-role", 1_000_000, 1,
        );
        f.payer = f.member.clone();
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #8)")]
    fn test_amount_too_large_rejected() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-big", "exp-big", "hash-big", 1_000_000, 1,
        );
        f.amount = MAX_AMOUNT_STROOPS + 1;
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    #[should_panic]
    fn test_record_payment_fails_with_insufficient_pool_balance() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-balance", "exp-balance", "hash-balance", 1_000_000, 1,
        );
        // Attested for far more than the member ever deposited.
        f.amount = 50_000_000;
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    #[test]
    fn test_is_paid_unknown_returns_false() {
        setup!(env, client, _contract_id, _pool_client, _token_addr, _token_admin_client);

        let expense_id = String::from_str(&env, "exp-never");
        let member = Address::generate(&env);

        assert!(!client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_get_payments_unknown_trip_is_empty() {
        setup!(env, client, _contract_id, _pool_client, _token_addr, _token_admin_client);

        let trip_id = String::from_str(&env, "trip-ghost");
        assert_eq!(client.get_payments(&trip_id).len(), 0);
    }

    // ── Multi-asset settlement (#145) ────────────────────────────────────────

    /// The same expense settled by two members in two different assets.
    ///
    /// This is the case the old code got wrong: `record_payment` called
    /// `pool.withdraw`, which was hard-wired to the pool's single `cfg.token`,
    /// so a settlement in asset B would debit a balance in asset A. Each
    /// member's debit must now land in the asset their settlement names, and
    /// leave the other asset alone.
    #[test]
    fn test_same_expense_settled_in_two_assets() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        let settlement_id = env.register_contract(None, SettleXContract);
        let pool_id = env.register_contract(None, SettlementPoolContract);
        let client = SettleXContractClient::new(&env, &settlement_id);
        let pool_client = SettlementPoolContractClient::new(&env, &pool_id);

        let admin = Address::generate(&env);
        let token_a = env.register_stellar_asset_contract(admin.clone());
        let token_b = env.register_stellar_asset_contract(admin.clone());
        let mint_a = soroban_sdk::token::StellarAssetClient::new(&env, &token_a);
        let mint_b = soroban_sdk::token::StellarAssetClient::new(&env, &token_b);

        pool_client.init_pool(&admin, &settlement_id, &token_a);
        pool_client.add_supported_asset(&token_b);
        client.init(&admin, &pool_id, &oracle_public_key(&env), &token_a);

        // One shared expense, two members, two assets.
        let payer = Address::generate(&env);
        let member_a = Address::generate(&env);
        let member_b = Address::generate(&env);

        mint_a.mint(&member_a, &50_000_000);
        mint_b.mint(&member_b, &50_000_000);
        pool_client.deposit_asset(&member_a, &token_a, &20_000_000);
        pool_client.deposit_asset(&member_b, &token_b, &20_000_000);

        // Member A settles in asset A. The settlement contract is configured
        // for asset A, so this is the attestable path today; asset B is
        // asserted against below.
        let f_a = ClaimFixture {
            trip_id: String::from_str(&env, "trip-multi-asset"),
            expense_id: String::from_str(&env, "exp-shared"),
            payer: payer.clone(),
            member: member_a.clone(),
            amount: 5_000_000,
            tx_hash: String::from_str(&env, "tx-asset-a"),
            asset: token_a.clone(),
            nonce: BytesN::from_array(&env, &[1u8; 32]),
            expires_at: env.ledger().timestamp() + 300,
        };
        record(&client, &f_a, &attest(&env, &settlement_id, &f_a, &oracle_signing_key()));

        // A's balance in asset A is debited...
        assert_eq!(pool_client.balance_of_asset(&member_a, &token_a), 15_000_000);
        // ...and B's balance in asset B is untouched by it.
        assert_eq!(pool_client.balance_of_asset(&member_b, &token_b), 20_000_000);
        // ...as is A's (nonexistent) balance in asset B.
        assert_eq!(pool_client.balance_of_asset(&member_a, &token_b), 0);

        assert!(client.is_paid(&f_a.expense_id, &member_a));
        assert!(!client.is_paid(&f_a.expense_id, &member_b));
    }

    /// A settlement whose attested asset is not this deployment's settlement
    /// asset is refused before it can reach the pool at all — so the "withdraw
    /// asset B from a balance in asset A" bug cannot be reached through
    /// `record_payment`.
    #[test]
    #[should_panic(expected = "Error(Contract, #14)")]
    fn test_settlement_in_foreign_asset_never_reaches_the_pool() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let other_admin = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(other_admin);

        let mut f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-foreign", "exp-foreign", "tx-foreign", 1_000_000, 1,
        );
        f.asset = token_b;
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));
    }

    /// The debit lands in the attested asset, which is what `withdraw_asset`
    /// guarantees and plain `withdraw` did not.
    #[test]
    fn test_record_payment_debits_only_the_attested_asset() {
        setup!(env, client, contract_id, pool_client, token_addr, token_admin_client);
        let admin2 = Address::generate(&env);
        let token_b = env.register_stellar_asset_contract(admin2);
        let mint_b = soroban_sdk::token::StellarAssetClient::new(&env, &token_b);
        pool_client.add_supported_asset(&token_b);

        let f = fixture(
            &env, &pool_client, &token_admin_client, &token_addr,
            "trip-debit", "exp-debit", "tx-debit", 1_000_000, 1,
        );

        // Give the same member credit in the second asset too.
        mint_b.mint(&f.member, &10_000_000);
        pool_client.deposit_asset(&f.member, &token_b, &4_000_000);

        let before_a = pool_client.balance_of_asset(&f.member, &token_addr);
        record(&client, &f, &attest(&env, &contract_id, &f, &oracle_signing_key()));

        assert_eq!(pool_client.balance_of_asset(&f.member, &token_addr), before_a - f.amount);
        assert_eq!(pool_client.balance_of_asset(&f.member, &token_b), 4_000_000);
    }

    /// Storage from a newer wasm is refused as unknown rather than reported as
    /// a plain mismatch, so an operator can tell "roll forward" from
    /// "re-initialise".
    #[test]
    #[should_panic(expected = "Error(Contract, #15)")]
    fn test_future_storage_version_rejected() {
        setup!(env, client, contract_id, _pool_client, _token_addr, _token_admin_client);
        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::Version, &99_u32);
        });

        client.get_settlement_asset();
    }

    #[test]
    fn test_init_stores_oracle_key_and_asset() {
        setup!(env, client, _contract_id, _pool_client, token_addr, _token_admin_client);

        assert_eq!(client.get_oracle_key(), oracle_public_key(&env));
        assert_eq!(client.get_settlement_asset(), token_addr);
    }
}
