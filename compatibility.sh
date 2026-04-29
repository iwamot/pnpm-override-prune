#!/bin/bash
set -euo pipefail

# mise
eval "$(mise activate bash)"
mise install

aube install --frozen-lockfile
aube run build

# Pack the package and install it in an isolated directory to exercise the
# publish path (validates "files" globs, bin shebang, deps resolution).
TARBALL="$PWD/$(npm pack --silent)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$TARBALL"' EXIT

cd "$TMP"
npm init --silent --yes >/dev/null
npm install --silent --no-audit --no-fund "$TARBALL"

./node_modules/.bin/pnpm-override-prune --version
./node_modules/.bin/pnpm-override-prune --help >/dev/null
