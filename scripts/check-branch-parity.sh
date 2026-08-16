#!/usr/bin/env bash
# Guards against feature/03-euro-pegged-stablecoin and feature/06-aave-v4 silently
# drifting: both branches back a distinct, permanent product (EUR-pegged vs
# USD-pegged/Aave-V4), but must otherwise share one codebase. Product differences
# belong in scripts/deploy_core_contracts.ts config (token branding, whether the
# optional EUR/USD feed is configured), never in contracts/contracts/ itself.
#
# Usage: scripts/check-branch-parity.sh
# No-ops (exit 0) unless running on one of the two paired branches.
set -euo pipefail

EURO_BRANCH="feature/03-euro-pegged-stablecoin"
USD_BRANCH="feature/06-aave-v4"

# Deploy-time branding fixtures — legitimate per-product differences, not drift.
TEST_ALLOWLIST=(
  "test/FrgmntUserActions.test.ts"
  "test/PoolLogic.test.ts"
  "test/PoolLogicAutoCompounding.test.ts"
  "test/TokenLogic.test.ts"
)

# On a pull_request event, GITHUB_REF_NAME is "<pr-number>/merge", not the real branch
# name — GITHUB_HEAD_REF carries the actual source branch there instead. On a push
# event, GITHUB_HEAD_REF is unset and GITHUB_REF_NAME is the real branch name.
current_branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}}"

case "$current_branch" in
  "$EURO_BRANCH") other_branch="$USD_BRANCH" ;;
  "$USD_BRANCH") other_branch="$EURO_BRANCH" ;;
  *)
    echo "check-branch-parity: '$current_branch' is not a paired branch, skipping."
    exit 0
    ;;
esac

git fetch --depth=1 origin "$other_branch:refs/remotes/origin/$other_branch" --quiet 2>/dev/null \
  || git fetch --depth=1 origin "$other_branch" --quiet

other_ref="origin/$other_branch"

# 1) contracts/contracts/: zero tolerance. Any difference here is unintended drift.
contract_diffs="$(git diff --name-only "$other_ref" HEAD -- contracts/contracts/)"
if [ -n "$contract_diffs" ]; then
  echo "FAIL: contracts/contracts/ differs from $other_branch (must be byte-identical):"
  echo "$contract_diffs" | sed 's/^/  /'
  echo
  echo "If this is a legitimate product-specific change, it belongs in deploy-time"
  echo "config (scripts/deploy_core_contracts.ts), not in the shared contract source."
  echo "Otherwise, port the fix to $other_branch too."
  exit 1
fi

# 2) test/: allow only the known branding fixtures; fail on anything else.
test_diffs="$(git diff --name-only "$other_ref" HEAD -- test/)"
unexpected_test_diffs=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  allowed=false
  for allowed_file in "${TEST_ALLOWLIST[@]}"; do
    if [ "$f" = "$allowed_file" ]; then
      allowed=true
      break
    fi
  done
  if [ "$allowed" = false ]; then
    unexpected_test_diffs="$unexpected_test_diffs$f\n"
  fi
done <<< "$test_diffs"

if [ -n "$unexpected_test_diffs" ]; then
  echo "FAIL: test/ files differ from $other_branch outside the known branding allowlist:"
  printf '%b' "$unexpected_test_diffs" | sed 's/^/  /'
  echo
  echo "Either port the test change to $other_branch, or add the file to"
  echo "TEST_ALLOWLIST in scripts/check-branch-parity.sh if the difference is"
  echo "genuinely product-specific."
  exit 1
fi

echo "check-branch-parity: OK — contracts/contracts/ is byte-identical to $other_branch,"
echo "and test/ differs only in the known branding fixtures."
