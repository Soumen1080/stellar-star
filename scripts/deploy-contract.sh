#!/usr/bin/env bash
# =============================================================================
# deploy-contract.sh
#
# Builds and deploys the Stellar-star Soroban settlement contract to Stellar testnet.
#
# Prerequisites:
#   - Rust toolchain with wasm32v1-none target
#       rustup target add wasm32v1-none
#   - Stellar CLI (recent)
#       cargo install --locked stellar-cli
#   - A funded testnet account (get test XLM at friendbot.stellar.org)
#
# Usage:
#   chmod +x scripts/deploy-contract.sh
#   ./scripts/deploy-contract.sh <YOUR_SECRET_KEY_OR_ALIAS> <TOKEN_CONTRACT_ID> [ORACLE_SECRET]
#
# The third argument is the attestation oracle's Stellar secret seed (S...).
# `record_payment` will not accept a settlement without a signature from the
# matching key, so the contract has to be initialised with its public half.
# Omit it and the script generates a fresh keypair and prints the secret once —
# store it in the server-only SETTLEMENT_ORACLE_SECRET, never in a
# NEXT_PUBLIC_* variable, which would publish it to every browser.
#
# After successful deployment, copy the printed CONTRACT_ID to .env.local:
#   NEXT_PUBLIC_CONTRACT_ID=C...
# =============================================================================

set -euo pipefail

fail() {
  local message="${1:-Deployment failed.}"
  local code="${2:-1}"
  echo ""
  echo "❌ ${message}"
  exit "$code"
}

on_error() {
  local exit_code=$?
  echo ""
  echo "❌ Deployment failed."
  echo "Failed step: ${CURRENT_STEP}"
  exit "$exit_code"
}

CURRENT_STEP="Starting deployment"
START_TIME=$(date +%s)

trap on_error ERR

ACCOUNT="${1:-}"
TOKEN_CONTRACT_ID="${2:-}"
ORACLE_SECRET="${3:-}"
if [[ -z "$ACCOUNT" || -z "$TOKEN_CONTRACT_ID" ]]; then
  echo "❌  Usage: $0 <secret-key-or-stellar-cli-alias> <token-contract-id> [oracle-secret]"
  echo "   Example: $0 SDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX C..."
  exit 1
fi

echo "▸ Checking required dependencies..."

for cmd in stellar cargo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required dependency: $cmd"
  fi
done

if [[ "$ACCOUNT" =~ ^S[A-Z2-7]{55}$ ]]; then
  if ! command -v node >/dev/null 2>&1; then
    fail "Missing required dependency: node"
  fi
fi

echo "  [OK] All required dependencies found."
echo ""

WASM_PATH="contract/target/wasm32v1-none/release/settlex_contract.wasm"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Stellar-star Contract Deployment"
echo "  Network : Stellar Testnet"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build ─────────────────────────────────────────────────────────────
CURRENT_STEP="Building contract"

echo "▸ Building contract (release)..."
stellar contract build \
  --manifest-path contract/Cargo.toml \
  --package settlex-contract \
  --optimize
echo "  [OK] Build succeeded: $WASM_PATH"
echo ""

# ── Step 2: Resolve Deployer Address ──────────────────────────────────────────
CURRENT_STEP="Resolving deployer public address"

echo "▸ Resolving deployer public address..."
if [[ "$ACCOUNT" =~ ^S[A-Z2-7]{55}$ ]]; then
  # It is a secret key, derive public key using Node and stellar-sdk
  DEPLOYER_ADDRESS=$(node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.fromSecret(process.argv[1]).publicKey());" "$ACCOUNT")
else
  # It is an alias, get address using stellar CLI
  DEPLOYER_ADDRESS=$(stellar keys address "$ACCOUNT" | tr -d '\r' | tr -d '\n')
fi

if [[ -z "$DEPLOYER_ADDRESS" ]]; then
  fail "Failed to resolve deployer public address."
fi
echo "  [OK] Resolved deployer public address: $DEPLOYER_ADDRESS"
echo ""

# ── Step 2b: Resolve Attestation Oracle Key ───────────────────────────────────
CURRENT_STEP="Resolving attestation oracle key"

echo "▸ Resolving attestation oracle key..."
GENERATED_ORACLE=0
if [[ -z "$ORACLE_SECRET" ]]; then
  ORACLE_SECRET=$(node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.random().secret());")
  GENERATED_ORACLE=1
fi

if [[ ! "$ORACLE_SECRET" =~ ^S[A-Z2-7]{55}$ ]]; then
  fail "Oracle secret must be a Stellar secret seed (S...)."
fi

# The contract stores the raw 32-byte ed25519 public key; the app config uses
# the G... form of the same key. Stellar keys are ed25519 keys, so one seed
# gives us both.
ORACLE_PUBLIC=$(node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.fromSecret(process.argv[1]).publicKey());" "$ORACLE_SECRET")
ORACLE_RAW_HEX=$(node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.fromSecret(process.argv[1]).rawPublicKey().toString('hex'));" "$ORACLE_SECRET")

if [[ -z "$ORACLE_PUBLIC" || -z "$ORACLE_RAW_HEX" ]]; then
  fail "Failed to derive the oracle public key."
fi
echo "  [OK] Oracle public key: $ORACLE_PUBLIC"
echo ""

# ── Step 3: Deploy ────────────────────────────────────────────────────────────
CURRENT_STEP="Deploying Settlement Pool contract"

echo "▸ Deploying Settlement Pool contract to testnet..."
POOL_CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  --inclusion-fee 1000000)
echo "  [OK] Settlement Pool contract deployed: $POOL_CONTRACT_ID"
if [[ -z "$POOL_CONTRACT_ID" ]]; then
  fail "Pool contract deployment returned an empty contract ID."
fi
echo ""

CURRENT_STEP="Deploying Settlement contract"

echo "▸ Deploying Stellar-star Settlement contract to testnet..."
SETTLEMENT_CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  --inclusion-fee 1000000)
echo "  [OK] Stellar-star Settlement contract deployed: $SETTLEMENT_CONTRACT_ID"
if [[ -z "$SETTLEMENT_CONTRACT_ID" ]]; then
  fail "Settlement contract deployment returned an empty contract ID."
fi
echo ""

# ── Step 4: Initialize ────────────────────────────────────────────────────────
CURRENT_STEP="Initializing Settlement Pool contract"

echo "▸ Initializing Settlement Pool contract reference..."
stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  -- \
  init_pool \
  --admin "$DEPLOYER_ADDRESS" \
  --settlement-contract "$SETTLEMENT_CONTRACT_ID" \
  --token "$TOKEN_CONTRACT_ID"
echo "  [OK] Pool contract initialized."
echo ""

CURRENT_STEP="Initializing Settlement contract"

echo "▸ Initializing Stellar-star Settlement contract reference..."
stellar contract invoke \
  --id "$SETTLEMENT_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  -- \
  init \
  --admin "$DEPLOYER_ADDRESS" \
  --pool-contract "$POOL_CONTRACT_ID" \
  --oracle-key "$ORACLE_RAW_HEX" \
  --settlement-asset "$TOKEN_CONTRACT_ID"
echo "  [OK] Settlement contract initialized."
echo ""

END_TIME=$(date +%s)
ELAPSED_TIME=$((END_TIME - START_TIME))

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Deployment & Initialization successful!"
echo ""

echo "Settlement Contract"
echo "-------------------"
echo "ID:"
echo "$SETTLEMENT_CONTRACT_ID"
echo ""
echo "Explorer:"
echo "https://stellar.expert/explorer/testnet/contract/$SETTLEMENT_CONTRACT_ID"
echo ""

echo "Pool Contract"
echo "-------------"
echo "ID:"
echo "$POOL_CONTRACT_ID"
echo ""
echo "Explorer:"
echo "https://stellar.expert/explorer/testnet/contract/$POOL_CONTRACT_ID"
echo ""

echo "Environment Variables"
echo "---------------------"
echo "NEXT_PUBLIC_CONTRACT_ID=$SETTLEMENT_CONTRACT_ID"
echo "NEXT_PUBLIC_SETTLEMENT_CONTRACT_ID=$SETTLEMENT_CONTRACT_ID"
echo "NEXT_PUBLIC_POOL_CONTRACT_ID=$POOL_CONTRACT_ID"
echo "NEXT_PUBLIC_POOL_TOKEN_ID=$TOKEN_CONTRACT_ID"
echo "NEXT_PUBLIC_SETTLEMENT_ASSET_ID=$TOKEN_CONTRACT_ID"
echo "NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY=$ORACLE_PUBLIC"
echo ""

echo "Attestation Oracle (SERVER-ONLY SECRET)"
echo "---------------------------------------"
if [[ "$GENERATED_ORACLE" -eq 1 ]]; then
  echo "A new oracle keypair was generated. This secret is shown once —"
  echo "store it now, and never in a NEXT_PUBLIC_* variable."
  echo ""
  echo "SETTLEMENT_ORACLE_SECRET=$ORACLE_SECRET"
else
  echo "SETTLEMENT_ORACLE_SECRET=<the secret you passed as argument 3>"
fi
echo ""
echo "Anyone holding this key can mint proof of a payment that never happened."
echo "To rotate: generate a new keypair, invoke set_oracle_key on the contract"
echo "with its raw hex public key, then update SETTLEMENT_ORACLE_SECRET."
echo ""

echo "Completed in ${ELAPSED_TIME} seconds."

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
