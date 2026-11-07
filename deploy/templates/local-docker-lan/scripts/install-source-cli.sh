#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
export PATH="$HOME/.local/bin:$PATH"
cd "$deployment_dir"
mkdir -p .generated
npm ci --prefix "$QM_SOURCE_DIR/cli" --no-audit --no-fund
npm run build --prefix "$QM_SOURCE_DIR/cli"
archive="$(npm pack "$QM_SOURCE_DIR/cli" --ignore-scripts --pack-destination "$deployment_dir/.generated" --silent)"
mv ".generated/$archive" .generated/qm-cli.tgz
npm install --save-exact ./.generated/qm-cli.tgz --no-audit --no-fund
python3 scripts/patch-cli-loopback.py
