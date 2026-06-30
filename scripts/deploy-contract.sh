#!/usr/bin/env bash
# =============================================================================
# deploy-contract.sh
#
# Builds and deploys the SettleX Soroban settlement contract to Stellar testnet.
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
#   ./scripts/deploy-contract.sh <YOUR_SECRET_KEY_OR_ALIAS>
#
# After successful deployment, copy the printed CONTRACT_ID to .env.local:
#   NEXT_PUBLIC_CONTRACT_ID=C...
# =============================================================================

set -euo pipefail

ACCOUNT="${1:-}"
if [[ -z "$ACCOUNT" ]]; then
  echo "❌  Usage: $0 <secret-key-or-stellar-cli-alias>"
  echo "   Example: $0 SDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  exit 1
fi

WASM_PATH="contract/target/wasm32v1-none/release/settlex_contract.wasm"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SettleX Contract Deployment"
echo "  Network : Stellar Testnet"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build ─────────────────────────────────────────────────────────────
echo "▸ Building contract (release)..."
stellar contract build \
  --manifest-path contract/Cargo.toml \
  --package settlex-contract \
  --optimize
echo "  [OK] Build succeeded: $WASM_PATH"
echo ""

# ── Step 2: Resolve Deployer Address ──────────────────────────────────────────
echo "▸ Resolving deployer public address..."
if [[ "$ACCOUNT" =~ ^S[A-Z2-7]{55}$ ]]; then
  # It is a secret key, derive public key using Node and stellar-sdk
  DEPLOYER_ADDRESS=$(node -e "const {Keypair} = require('@stellar/stellar-sdk'); console.log(Keypair.fromSecret(process.argv[1]).publicKey());" "$ACCOUNT")
else
  # It is an alias, get address using stellar CLI
  DEPLOYER_ADDRESS=$(stellar keys address "$ACCOUNT" | tr -d '\r' | tr -d '\n')
fi

if [[ -z "$DEPLOYER_ADDRESS" ]]; then
  echo "❌ Failed to resolve deployer public address."
  exit 1
fi
echo "  [OK] Resolved deployer public address: $DEPLOYER_ADDRESS"
echo ""

# ── Step 3: Deploy ────────────────────────────────────────────────────────────
echo "▸ Deploying Settlement Pool contract to testnet..."
POOL_CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  --inclusion-fee 1000000)
echo "  [OK] Settlement Pool contract deployed: $POOL_CONTRACT_ID"
echo ""

echo "▸ Deploying SettleX Settlement contract to testnet..."
SETTLEMENT_CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  --inclusion-fee 1000000)
echo "  [OK] SettleX Settlement contract deployed: $SETTLEMENT_CONTRACT_ID"
echo ""

# ── Step 4: Initialize ────────────────────────────────────────────────────────
echo "▸ Initializing Settlement Pool contract reference..."
stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  -- \
  init_pool \
  --admin "$DEPLOYER_ADDRESS" \
  --settlement-contract "$SETTLEMENT_CONTRACT_ID"
echo "  [OK] Pool contract initialized."
echo ""

echo "▸ Initializing SettleX Settlement contract reference..."
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

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Deployment & Initialization successful!"
echo ""
echo "  SETTLEMENT_CONTRACT_ID:"
echo "  $SETTLEMENT_CONTRACT_ID"
echo "  Verify on Stellar Expert:"
echo "  https://stellar.expert/explorer/testnet/contract/$SETTLEMENT_CONTRACT_ID"
echo ""
echo "  POOL_CONTRACT_ID:"
echo "  $POOL_CONTRACT_ID"
echo "  Verify on Stellar Expert:"
echo "  https://stellar.expert/explorer/testnet/contract/$POOL_CONTRACT_ID"
echo ""
echo "  Add this to your .env.local:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$SETTLEMENT_CONTRACT_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
