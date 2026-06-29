#!/usr/bin/env bash
# =============================================================================
# deploy-contract.sh
#
# Builds, deploys, and initializes both SettleX settlement and pool contracts
# on Stellar testnet.
#
# The script deploys the same compiled WASM twice, then initializes the pool
# contract with a settlement contract reference and the settlement contract
# with the deployed pool contract reference.
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
# After successful deployment, add the settlement contract ID to .env.local:
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

extract_contract_id() {
  printf '%s\n' "$1" | grep -oE '\bC[A-Z2-7]{55}\b' | head -n1 || true
}

extract_tx_hash() {
  printf '%s\n' "$1" | grep -oE '\b[A-F0-9]{64}\b' | head -n1 || true
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SettleX Contract Deployment"
echo "  Network : Stellar Testnet"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build ─────────────────────────────────────────────────────────────
echo "▸ Building contract (release)…"
stellar contract build \
  --manifest-path contract/Cargo.toml \
  --package settlex-contract \
  --optimize

echo "  ✓ Build succeeded: $WASM_PATH"
echo ""

# ── Step 2: Deploy settlement contract ─────────────────────────────────────────
echo "▸ Deploying settlement contract…"
SETTLEMENT_OUTPUT=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network testnet \
  --inclusion-fee 1000000 2>&1)
SETTLEMENT_CONTRACT_ID=$(extract_contract_id "$SETTLEMENT_OUTPUT")
SETTLEMENT_DEPLOY_TX_HASH=$(extract_tx_hash "$SETTLEMENT_OUTPUT")

if [[ -z "$SETTLEMENT_CONTRACT_ID" ]]; then
  echo "❌  Failed to parse settlement contract id from deploy output."
  printf '%s\n' "$SETTLEMENT_OUTPUT"
  exit 1
fi

echo "  ✓ Settlement contract deployed: $SETTLEMENT_CONTRACT_ID"
echo ""

# ── Step 3: Deploy pool contract ───────────────────────────────────────────────
echo "▸ Deploying pool contract…"
POOL_OUTPUT=$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network testnet \
  --inclusion-fee 1000000 2>&1)
POOL_CONTRACT_ID=$(extract_contract_id "$POOL_OUTPUT")
POOL_DEPLOY_TX_HASH=$(extract_tx_hash "$POOL_OUTPUT")

if [[ -z "$POOL_CONTRACT_ID" ]]; then
  echo "❌  Failed to parse pool contract id from deploy output."
  printf '%s\n' "$POOL_OUTPUT"
  exit 1
fi

echo "  ✓ Pool contract deployed: $POOL_CONTRACT_ID"
echo ""

# ── Step 4: Initialize pool contract ──────────────────────────────────────────
echo "▸ Initializing pool contract…"
POOL_INIT_OUTPUT=$(stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  --inclusion-fee 1000000 \
  -- init_pool --admin "$ACCOUNT" --settlement-contract "$SETTLEMENT_CONTRACT_ID" 2>&1)
POOL_INIT_TX_HASH=$(extract_tx_hash "$POOL_INIT_OUTPUT")

echo "  ✓ Pool contract initialization completed."
echo ""

# ── Step 5: Initialize settlement contract ──────────────────────────────────────
echo "▸ Initializing settlement contract…"
SETTLEMENT_INIT_OUTPUT=$(stellar contract invoke \
  --id "$SETTLEMENT_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  --inclusion-fee 1000000 \
  -- init --admin "$ACCOUNT" --pool-contract "$POOL_CONTRACT_ID" 2>&1)
SETTLEMENT_INIT_TX_HASH=$(extract_tx_hash "$SETTLEMENT_INIT_OUTPUT")

echo "  ✓ Settlement contract initialization completed."
echo ""

# ── Step 6: Summary ───────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Deployment and initialization complete!"
echo ""
echo "  Settlement contract ID:"
echo "  $SETTLEMENT_CONTRACT_ID"
echo ""
echo "  Pool contract ID:"
echo "  $POOL_CONTRACT_ID"
echo ""
echo "  Contract explorer URLs:"
echo "  Settlement: https://stellar.expert/explorer/testnet/contract/$SETTLEMENT_CONTRACT_ID"
echo "  Pool:       https://stellar.expert/explorer/testnet/contract/$POOL_CONTRACT_ID"
echo ""
if [[ -n "$SETTLEMENT_DEPLOY_TX_HASH" ]]; then
  echo "  Settlement deploy tx: https://stellar.expert/explorer/testnet/tx/$SETTLEMENT_DEPLOY_TX_HASH"
fi
if [[ -n "$POOL_DEPLOY_TX_HASH" ]]; then
  echo "  Pool deploy tx:       https://stellar.expert/explorer/testnet/tx/$POOL_DEPLOY_TX_HASH"
fi
if [[ -n "$POOL_INIT_TX_HASH" ]]; then
  echo "  Pool init tx:         https://stellar.expert/explorer/testnet/tx/$POOL_INIT_TX_HASH"
fi
if [[ -n "$SETTLEMENT_INIT_TX_HASH" ]]; then
  echo "  Settlement init tx:   https://stellar.expert/explorer/testnet/tx/$SETTLEMENT_INIT_TX_HASH"
fi

echo ""
echo "  Add this to your .env.local:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$SETTLEMENT_CONTRACT_ID"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
