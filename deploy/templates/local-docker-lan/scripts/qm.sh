#!/usr/bin/env bash
set -euo pipefail
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"
cd "$deployment_dir"
python3 scripts/patch-cli-loopback.py
exec node node_modules/@yc-software/qm/dist/bin/qm.js "$@"
