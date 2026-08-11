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
#   ./scripts/deploy-contract.sh <YOUR_SECRET_KEY_OR_ALIAS> <TOKEN_CONTRACT_ID>
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
if [[ -z "$ACCOUNT" || -z "$TOKEN_CONTRACT_ID" ]]; then
  echo "❌  Usage: $0 <secret-key-or-stellar-cli-alias> <token-contract-id>"
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
  --pool-contract "$POOL_CONTRACT_ID"
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
echo ""

echo "Completed in ${ELAPSED_TIME} seconds."

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
