#!/bin/bash
set -e

# mise
eval "$(mise activate bash)"
mise fmt
mise install

# TypeScript
aube install --frozen-lockfile
aube licenses
aube audit --fix --ignore-unfixable
pnpm-override-prune --fix
biome migrate --write
aube run check:write
aube run typecheck
aube run test
aube run build

# Run shared lint tasks
mise run gha-lint

# Check for uncommitted changes
git diff --exit-code
