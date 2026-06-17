#!/usr/bin/env bash
set -euo pipefail

# ytsejam quality gate.
# Single authoritative check — agents and deploy verify the EXIT CODE, not output.
# Run from the repo root with deps already installed (this gate validates; it does
# not install). `env -u NODE_ENV` clears an inherited NODE_ENV=production so npm
# doesn't skip the devDependencies (vitest/vite/tsc) the checks need.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== gate: contrib script tests ==="
bash scripts/test/bottega-api.test.sh

echo "=== gate: server typecheck (tsc --noEmit) ==="
env -u NODE_ENV npm run check

echo "=== gate: server tests (vitest) ==="
env -u NODE_ENV npm test --workspace server

echo "=== gate: ltm tests (vitest) ==="
env -u NODE_ENV npm test --workspace ltm

echo "=== gate: web build + typecheck (tsc -b && vite build) ==="
env -u NODE_ENV npm run build --workspace web

echo "=== gate: web tests ==="
env -u NODE_ENV npm test --workspace web

echo ""
echo "=== gate: PASSED ==="
