#![no_std]

pub mod pool;

use crate::pool::SettlementPoolContractClient;
use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, panic_with_error, symbol_short,
    Address, Env, String, Vec,
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
pub enum DataKey {
    TripPayments(String),
    ExpensePaid(String, Address),
    Admin,
    PoolContract,
    Version,
}

const LEDGERS_PER_DAY:        u32 = 17_280;
const STORAGE_BUMP_THRESHOLD: u32 = LEDGERS_PER_DAY * 30;
const STORAGE_BUMP_AMOUNT:    u32 = LEDGERS_PER_DAY * 365;
const CONTRACT_VERSION:       u32 = 1;
const MAX_ID_LEN:             u32 = 64;
const MAX_TX_HASH_LEN:        u32 = 128;
const MAX_AMOUNT_STROOPS:     i128 = 10_000_000_000_000_000;

#[contract]
pub struct SettleXContract;

#[contractimpl]
impl SettleXContract {

    pub fn init(env: Env, admin: Address, pool_contract: Address) {
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
        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);

        env.events().publish((symbol_short!("stx_ini"),), CONTRACT_VERSION);
    }

    pub fn set_pool_contract(env: Env, pool_contract: Address) {
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));
        if version != CONTRACT_VERSION {
            panic_with_error!(&env, ContractError::VersionMismatch);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));

        if pool_contract == admin {
            panic_with_error!(&env, ContractError::InvalidActor);
        }

        admin.require_auth();
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
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));
        if version != CONTRACT_VERSION {
            panic_with_error!(&env, ContractError::VersionMismatch);
        }

        let pool = env.storage()
            .instance()
            .get(&DataKey::PoolContract)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));

        env.storage().instance().extend_ttl(STORAGE_BUMP_THRESHOLD, STORAGE_BUMP_AMOUNT);
        pool
    }

    pub fn record_payment(
        env:        Env,
        trip_id:    String,
        expense_id: String,
        payer:      Address,
        member:     Address,
        amount:     i128,
        tx_hash:    String,
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

        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or_else(|| panic_with_error!(&env, ContractError::NotInitialized));
        if version != CONTRACT_VERSION {
            panic_with_error!(&env, ContractError::VersionMismatch);
        }

        let paid_key = DataKey::ExpensePaid(expense_id.clone(), member.clone());
        if env.storage().persistent().has(&paid_key) {
            panic_with_error!(&env, ContractError::AlreadyPaid);
        }

        // Inter-contract call: settlement contract consumes member funds from pool balance.
        let pool_contract = Self::get_pool_contract(env.clone());
        let pool_client = SettlementPoolContractClient::new(&env, &pool_contract);
        pool_client.withdraw(&member, &amount);

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
    use crate::pool::{SettlementPoolContract, SettlementPoolContractClient};
    use soroban_sdk::{testutils::Address as _, Address, Env, String};

    macro_rules! setup {
        ($env:ident, $client:ident, $pool_client:ident) => {
            let $env = Env::default();
            $env.mock_all_auths();
            let settlement_contract_id = $env.register_contract(None, SettleXContract);
            let pool_contract_id = $env.register_contract(None, SettlementPoolContract);
            let $client = SettleXContractClient::new(&$env, &settlement_contract_id);
            let $pool_client = SettlementPoolContractClient::new(&$env, &pool_contract_id);

            let admin = Address::generate(&$env);
            let settlement_address = settlement_contract_id.clone();
            let pool_address = pool_contract_id.clone();

            $pool_client.init_pool(&admin, &settlement_address);
            $client.init(&admin, &pool_address);
        };
    }

    #[test]
    fn test_record_and_query() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-123");
        let expense_id = String::from_str(&env, "exp-456");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "abc123def456");

        pool_client.deposit(&member, &10_000_000_i128);

        assert!(!client.is_paid(&expense_id, &member));
        assert_eq!(client.get_payments(&trip_id).len(), 0);

        client.record_payment(
            &trip_id, &expense_id, &payer, &member,
            &10_000_000_i128,
            &tx_hash,
        );

        assert!(client.is_paid(&expense_id, &member));

        let payments = client.get_payments(&trip_id);
        assert_eq!(payments.len(), 1);
        let rec = payments.get(0).unwrap();
        assert_eq!(rec.amount,     10_000_000_i128);
        assert_eq!(rec.expense_id, expense_id);
        assert_eq!(pool_client.balance_of(&member), 0_i128);
    }

    #[test]
    fn test_multiple_members() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-multi");
        let expense_id = String::from_str(&env, "exp-multi");
        let payer      = Address::generate(&env);
        let member_a   = Address::generate(&env);
        let member_b   = Address::generate(&env);
        let tx_a       = String::from_str(&env, "hash_a");
        let tx_b       = String::from_str(&env, "hash_b");

        pool_client.deposit(&member_a, &5_000_000_i128);
        pool_client.deposit(&member_b, &7_500_000_i128);

        client.record_payment(&trip_id, &expense_id, &payer, &member_a, &5_000_000_i128, &tx_a);
        client.record_payment(&trip_id, &expense_id, &payer, &member_b, &7_500_000_i128, &tx_b);

        assert!(client.is_paid(&expense_id, &member_a));
        assert!(client.is_paid(&expense_id, &member_b));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    fn test_multiple_expenses_same_trip() {
        setup!(env, client, pool_client);

        let trip_id  = String::from_str(&env, "trip-abc");
        let exp_1    = String::from_str(&env, "exp-001");
        let exp_2    = String::from_str(&env, "exp-002");
        let payer    = Address::generate(&env);
        let member   = Address::generate(&env);
        let tx_1     = String::from_str(&env, "tx_001");
        let tx_2     = String::from_str(&env, "tx_002");

        pool_client.deposit(&member, &7_500_000_i128);

        client.record_payment(&trip_id, &exp_1, &payer, &member, &3_000_000_i128, &tx_1);
        client.record_payment(&trip_id, &exp_2, &payer, &member, &4_500_000_i128, &tx_2);

        assert!(client.is_paid(&exp_1, &member));
        assert!(client.is_paid(&exp_2, &member));
        assert_eq!(client.get_payments(&trip_id).len(), 2);
    }

    #[test]
    #[should_panic]
    fn test_duplicate_payment_rejected() {
        setup!(env, client, pool_client);

        let trip_id    = String::from_str(&env, "trip-dup");
        let expense_id = String::from_str(&env, "exp-dup");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_dup");

        pool_client.deposit(&member, &1_000_000_i128);

        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_zero_amount_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-zero");
        let expense_id = String::from_str(&env, "exp-zero");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_zero");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &0_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_negative_amount_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-neg");
        let expense_id = String::from_str(&env, "exp-neg");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash_neg");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &-1_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_empty_tx_hash_rejected() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-empty-tx");
        let expense_id = String::from_str(&env, "exp-empty-tx");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "");

        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_i128, &tx_hash);
    }

    #[test]
    fn test_is_paid_unknown_returns_false() {
        setup!(env, client, _pool_client);

        let expense_id = String::from_str(&env, "exp-never");
        let member     = Address::generate(&env);

        assert!(!client.is_paid(&expense_id, &member));
    }

    #[test]
    fn test_get_payments_unknown_trip_is_empty() {
        setup!(env, client, _pool_client);

        let trip_id = String::from_str(&env, "trip-ghost");
        assert_eq!(client.get_payments(&trip_id).len(), 0);
    }

    #[test]
    #[should_panic]
    fn test_record_payment_fails_with_insufficient_pool_balance() {
        setup!(env, client, _pool_client);

        let trip_id    = String::from_str(&env, "trip-balance");
        let expense_id = String::from_str(&env, "exp-balance");
        let payer      = Address::generate(&env);
        let member     = Address::generate(&env);
        let tx_hash    = String::from_str(&env, "hash-balance");

        // No deposit for member, inter-contract withdraw must fail.
        client.record_payment(&trip_id, &expense_id, &payer, &member, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_payer_cannot_equal_member() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-role");
        let expense_id = String::from_str(&env, "exp-role");
        let actor = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-role");

        pool_client.deposit(&actor, &1_000_000_i128);
        client.record_payment(&trip_id, &expense_id, &actor, &actor, &1_000_000_i128, &tx_hash);
    }

    #[test]
    #[should_panic]
    fn test_amount_too_large_rejected() {
        setup!(env, client, pool_client);

        let trip_id = String::from_str(&env, "trip-big");
        let expense_id = String::from_str(&env, "exp-big");
        let payer = Address::generate(&env);
        let member = Address::generate(&env);
        let tx_hash = String::from_str(&env, "hash-big");

        pool_client.deposit(&member, &(MAX_AMOUNT_STROOPS + 1));
        client.record_payment(&trip_id, &expense_id, &payer, &member, &(MAX_AMOUNT_STROOPS + 1), &tx_hash);
    }
}
