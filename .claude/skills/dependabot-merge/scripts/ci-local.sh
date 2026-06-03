#!/usr/bin/env bash
# Run the repo's CI gate locally, in CI order, stopping at the first failure.
# Mirrors .github/workflows/ci.yml so a green run here means a green run there.
#
# Usage: bash .claude/skills/dependabot-merge/scripts/ci-local.sh
# Run from the repo root, on the Dependabot branch you're validating.
set -uo pipefail

run() {
  local name="$1"; shift
  echo "=== ${name} ==="
  if ! "$@"; then
    echo "::FAIL:: ${name} failed — fix this, then re-run the gate." >&2
    exit 1
  fi
}

run "install"        pnpm install --frozen-lockfile
run "lint"           pnpm biome ci .
run "typecheck"      pnpm typecheck
run "test"           pnpm test
run "generate-types" pnpm generate-types
run "build"          pnpm build

echo "=== verify generated/ and dist/ in sync ==="
if ! git diff --exit-code generated/ dist/; then
  echo "::FAIL:: generated/ or dist/ is out of sync." >&2
  echo "        The rebuild above changed committed artifacts — 'git add' them and commit." >&2
  exit 1
fi

echo
echo "ALL GREEN — safe to commit/push and merge once CI confirms."
