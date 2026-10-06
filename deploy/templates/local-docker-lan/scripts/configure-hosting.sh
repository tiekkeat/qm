#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
python3 "$deployment_dir/scripts/configure-hosting.py"
