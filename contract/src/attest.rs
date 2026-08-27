//! Settlement attestation: the on-chain half of the trust anchor.
//!
//! A Soroban contract cannot read Horizon, so it cannot know whether a
//! `tx_hash` corresponds to a real payment. Instead an off-chain oracle does
//! that check and signs a claim; this module rebuilds the exact same claim
//! bytes from the arguments the caller actually passed and verifies the
//! oracle's ed25519 signature over them.
//!
//! The security property this buys: the signature is over *every* field the
//! contract is about to store, so a caller who tampers with any argument gets
//! a different message and the signature no longer verifies. There is nothing
//! for a hostile client to lie about — it can only relay an attestation
//! verbatim, and only once (see the nonce burn in `lib.rs`).
//!
//! ## Canonical message encoding
//!
//! The signed message is the concatenation of the XDR encoding of each field's
//! `ScVal`, in the fixed order below. XDR `ScVal`s are self-delimiting and the
//! field order and types are fixed, so plain concatenation is unambiguous — no
//! separate length framing is needed, and there is no map-key-ordering
//! ambiguity of the kind a `#[contracttype]` struct serialisation would have.
//!
//! ```text
//!   ScVal::String  DOMAIN                (domain separation tag)
//!   ScVal::Address settlement contract   (binds to this deployment + network)
//!   ScVal::String  trip_id
//!   ScVal::String  expense_id
//!   ScVal::Address payer
//!   ScVal::Address member
//!   ScVal::I128    amount (stroops)
//!   ScVal::Address asset                 (settlement asset contract)
//!   ScVal::String  tx_hash
//!   ScVal::Bytes   nonce (32 bytes)
//!   ScVal::U64     expires_at (unix seconds)
//! ```
//!
//! The off-chain side reproduces this byte-for-byte with
//! `nativeToScVal(...).toXDR()` — see `lib/settlement/attestationMessage.ts`.

use soroban_sdk::{contracttype, xdr::ToXdr, Address, Bytes, BytesN, Env, String};

/// Domain separation tag. Any change to the claim layout must change this
/// string, so attestations minted for an older layout stop verifying.
pub const ATTESTATION_DOMAIN: &str = "stellarstar.settlement.attestation.v1";

/// The oracle's signature over one settlement claim, plus the two fields that
/// exist only to make it single-use and short-lived.
///
/// `asset` is part of the signed claim rather than a separate argument because
/// the contract must be able to reject an attestation minted for a different
/// asset than the one it is about to debit.
#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    /// Settlement asset contract address (single-asset today; see #43).
    pub asset: Address,
    /// Random 32 bytes chosen by the oracle. Burned on use.
    pub nonce: BytesN<32>,
    /// Unix seconds after which the contract refuses the attestation.
    pub expires_at: u64,
    /// ed25519 signature by the oracle key over `claim_message(..)`.
    pub signature: BytesN<64>,
}

/// The full claim, as the contract sees it. Built from the arguments actually
/// passed to `record_payment` — never from anything inside `Attestation`
/// except the nonce and expiry, which are the oracle's own choices.
pub struct Claim<'a> {
    pub trip_id: &'a String,
    pub expense_id: &'a String,
    pub payer: &'a Address,
    pub member: &'a Address,
    pub amount: i128,
    pub tx_hash: &'a String,
    pub asset: &'a Address,
    pub nonce: &'a BytesN<32>,
    pub expires_at: u64,
}

/// Rebuilds the canonical signed message for a claim.
pub fn claim_message(env: &Env, claim: &Claim) -> Bytes {
    let mut msg = Bytes::new(env);

    // `to_xdr` takes `self` by value, hence the clones — these are cheap
    // handle copies, not deep copies of host objects.
    msg.append(&String::from_str(env, ATTESTATION_DOMAIN).to_xdr(env));
    msg.append(&env.current_contract_address().to_xdr(env));
    msg.append(&claim.trip_id.clone().to_xdr(env));
    msg.append(&claim.expense_id.clone().to_xdr(env));
    msg.append(&claim.payer.clone().to_xdr(env));
    msg.append(&claim.member.clone().to_xdr(env));
    msg.append(&claim.amount.to_xdr(env));
    msg.append(&claim.asset.clone().to_xdr(env));
    msg.append(&claim.tx_hash.clone().to_xdr(env));
    msg.append(&claim.nonce.clone().to_xdr(env));
    msg.append(&claim.expires_at.to_xdr(env));

    msg
}

/// Verifies the oracle's signature over the claim.
///
/// Traps (rather than returning an error code) when the signature does not
/// verify: `ed25519_verify` is a host function that panics on mismatch and
/// there is no fallible variant. Callers get a host error rather than a
/// `ContractError`, which is why the adversarial tests assert `should_panic`
/// rather than a specific code for forgery.
pub fn verify_claim(env: &Env, oracle_key: &BytesN<32>, claim: &Claim, signature: &BytesN<64>) {
    let message = claim_message(env, claim);
    env.crypto().ed25519_verify(oracle_key, &message, signature);
}

#[cfg(test)]
mod encoding_test {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Pins the `ScMap` key order the host uses for `Attestation`.
    ///
    /// `lib/stellar/contract.ts` hand-builds this map to pass the struct as a
    /// contract argument, and the host requires an `ScMap`'s keys in sorted
    /// order. This asserts the order rather than leaving the TypeScript side to
    /// guess it: if a field is ever renamed or added, this fails and says so.
    #[test]
    fn attestation_scmap_key_order_is_alphabetical() {
        let env = Env::default();
        let a = Attestation {
            asset: Address::generate(&env),
            nonce: BytesN::from_array(&env, &[1u8; 32]),
            expires_at: 42,
            signature: BytesN::from_array(&env, &[2u8; 64]),
        };

        let bytes = a.to_xdr(&env);
        let len = bytes.len() as usize;
        let mut buf = std::vec![0u8; len];
        bytes.copy_into_slice(&mut buf);

        // Field-name symbols appear in the serialised map in key order.
        let ascii: std::string::String = buf
            .iter()
            .map(|b| if b.is_ascii_lowercase() || *b == b'_' { *b as char } else { ' ' })
            .collect();
        let positions: std::vec::Vec<usize> = ["asset", "expires_at", "nonce", "signature"]
            .iter()
            .map(|field| ascii.find(field).expect("field name missing from XDR"))
            .collect();

        let mut sorted = positions.clone();
        sorted.sort();
        assert_eq!(
            positions, sorted,
            "Attestation ScMap keys must appear in the order attestationToScVal writes them: \
             asset, expires_at, nonce, signature",
        );
    }
}
