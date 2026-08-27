#!/usr/bin/env bash
# =============================================================================
# migrate-pool.sh
#
# Upgrades a live settlement pool from the v1 single-asset storage layout to
# the v2 multi-asset layout (issue #145).
#
# The contract does the actual work; this script only drives it. Two things
# are worth understanding before running it:
#
#   1. Instance storage upgrades itself on the first read. Deploying the v2
#      wasm over v1 storage is safe on its own — `get_config` accepts the older
#      version and rolls it forward, rather than trapping the way v1's exact
#      version check would have.
#
#   2. Per-member balances migrate lazily, on first touch. A contract cannot
#      enumerate its own storage keys, so there is no sweep to run: each
#      member's v1 balance is re-keyed the first time anything reads or writes
#      it. That happens automatically, and members need do nothing.
#
# So this script is a convenience, not a prerequisite. Its value is migrating
# known members eagerly — so balances are visible under the new layout before
# anyone goes looking — and confirming the instance upgrade landed.
#
# Migration is idempotent. Running it twice does not double-credit anyone.
#
# Usage:
#   ./scripts/migrate-pool.sh <secret-key-or-alias> <pool-contract-id> [member...]
#
#   # Instance storage only:
#   ./scripts/migrate-pool.sh stellar-star-deployer C_POOL
#
#   # Instance storage plus named members:
#   ./scripts/migrate-pool.sh stellar-star-deployer C_POOL GAAA... GBBB...
#
#   # Members from a file, one address per line:
#   MEMBER_FILE=members.txt ./scripts/migrate-pool.sh stellar-star-deployer C_POOL
# =============================================================================

set -euo pipefail

fail() {
  echo ""
  echo "❌ ${1:-Migration failed.}"
  exit "${2:-1}"
}

CURRENT_STEP="Starting migration"

on_error() {
  local exit_code=$?
  echo ""
  echo "❌ Migration failed."
  echo "Failed step: ${CURRENT_STEP}"
  echo ""
  echo "Migration is idempotent — it is safe to re-run after fixing the cause."
  exit "$exit_code"
}

trap on_error ERR

ACCOUNT="${1:-}"
POOL_CONTRACT_ID="${2:-}"
if [[ -z "$ACCOUNT" || -z "$POOL_CONTRACT_ID" ]]; then
  echo "❌  Usage: $0 <secret-key-or-alias> <pool-contract-id> [member-address...]"
  exit 1
fi
shift 2
MEMBERS=("$@")

if ! command -v stellar >/dev/null 2>&1; then
  fail "Missing required dependency: stellar"
fi

# Optional member list from a file, one address per line.
MEMBER_FILE="${MEMBER_FILE:-}"
if [[ -n "$MEMBER_FILE" ]]; then
  [[ -f "$MEMBER_FILE" ]] || fail "MEMBER_FILE not found: $MEMBER_FILE"
  while IFS= read -r line; do
    line="$(echo "$line" | tr -d '[:space:]')"
    [[ -z "$line" || "$line" == \#* ]] && continue
    MEMBERS+=("$line")
  done < "$MEMBER_FILE"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Settlement Pool Migration  (v1 → v2)"
echo "  Pool    : $POOL_CONTRACT_ID"
echo "  Members : ${#MEMBERS[@]}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Report the version we are starting from ───────────────────────────
CURRENT_STEP="Reading current storage version"

echo "▸ Reading current storage version..."
BEFORE_VERSION=$(stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  -- \
  get_version 2>/dev/null | tr -d '"[:space:]')

echo "  [OK] Storage version before: ${BEFORE_VERSION:-unknown}"
echo ""

if [[ "$BEFORE_VERSION" == "2" ]]; then
  echo "  Pool is already on the v2 layout. Member migrations below are still"
  echo "  safe to run — they are idempotent — and will pick up any member whose"
  echo "  balance has not yet been touched."
  echo ""
fi

# ── Step 2: Upgrade instance storage ──────────────────────────────────────────
CURRENT_STEP="Upgrading instance storage"

echo "▸ Upgrading instance storage..."
stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  -- \
  migrate \
  --member null
echo "  [OK] Instance storage upgraded."
echo ""

# ── Step 3: Migrate named member balances ─────────────────────────────────────
MIGRATED=0
SKIPPED=0

if [[ ${#MEMBERS[@]} -gt 0 ]]; then
  echo "▸ Migrating member balances..."
  for member in "${MEMBERS[@]}"; do
    CURRENT_STEP="Migrating member $member"

    if [[ ! "$member" =~ ^G[A-Z2-7]{55}$ ]]; then
      echo "  [SKIP] Not a Stellar address: $member"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    ALREADY=$(stellar contract invoke \
      --id "$POOL_CONTRACT_ID" \
      --source-account "$ACCOUNT" \
      --network testnet \
      -- \
      is_migrated \
      --member "$member" 2>/dev/null | tr -d '"[:space:]')

    if [[ "$ALREADY" == "true" ]]; then
      echo "  [SKIP] Already migrated: $member"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    stellar contract invoke \
      --id "$POOL_CONTRACT_ID" \
      --source-account "$ACCOUNT" \
      --network testnet \
      -- \
      migrate \
      --member "$member"

    echo "  [OK] Migrated: $member"
    MIGRATED=$((MIGRATED + 1))
  done
  echo ""
fi

# ── Step 4: Verify ────────────────────────────────────────────────────────────
CURRENT_STEP="Verifying migration"

AFTER_VERSION=$(stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  -- \
  get_version 2>/dev/null | tr -d '"[:space:]')

if [[ "$AFTER_VERSION" != "2" ]]; then
  fail "Storage version is '$AFTER_VERSION' after migration; expected 2."
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Migration complete"
echo ""
echo "Storage version : ${BEFORE_VERSION:-unknown} → ${AFTER_VERSION}"
echo "Members migrated: ${MIGRATED}"
echo "Members skipped : ${SKIPPED}"
echo ""
echo "Supported assets:"
stellar contract invoke \
  --id "$POOL_CONTRACT_ID" \
  --source-account "$ACCOUNT" \
  --network testnet \
  -- \
  get_supported_assets
echo ""
echo "Members not listed here migrate automatically on their next deposit,"
echo "withdrawal, or balance read. No balance is lost in the meantime."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
