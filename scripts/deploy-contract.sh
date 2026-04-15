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
echo "▸ Building contract (release)…"
stellar contract build \
  --manifest-path contract/Cargo.toml \
  --package settlex-contract \
  --optimize
echo "  ✓ Build succeeded: $WASM_PATH"
echo ""

# ── Step 2: Deploy ────────────────────────────────────────────────────────────
echo "▸ Deploying to testnet…"
CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source-account "$ACCOUNT" \
  --network   testnet \
  --inclusion-fee 1000000)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Deployment successful!"
echo ""
echo "  CONTRACT_ID:"
echo "  $CONTRACT_ID"
echo ""
echo "  Add this to your .env.local:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID"
echo ""
echo "  Verify on Stellar Expert:"
echo "  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
