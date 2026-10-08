#!/usr/bin/env bash
set -euo pipefail
umask 077
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${1:-$HOME/qm-reinstall-kit.tar.gz}"
[[ ! -e "$destination" ]] || { echo "Destination already exists: $destination" >&2; exit 1; }
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT
mkdir "$temporary_dir/qm-deployment"
for name in .env.example .gitignore README.md hosting.env.example package.json package-lock.json qm.config.jsonc scripts system sandbox; do
    cp -a "$deployment_dir/$name" "$temporary_dir/qm-deployment/$name"
done
python3 - "$temporary_dir/qm-deployment" <<'PY'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
path = root / 'qm.config.jsonc'
config = json.loads(path.read_text())
config['publicUrl'] = 'https://qm.example.com'
config['env']['core']['DEPLOY_APPS_DOMAIN'] = 'apps.qm.example.com'
config['env']['portal']['PORTAL_APPS_DOMAIN'] = 'apps.qm.example.com'
path.write_text(json.dumps(config, indent=2) + '\n')
PY
if [[ -f "$deployment_dir/hosting.env" ]]; then
    source "$deployment_dir/scripts/hosting.sh"
    git -C "$QM_SOURCE_DIR" rev-parse HEAD > "$temporary_dir/qm-deployment/SOURCE_REVISION"
fi
find "$temporary_dir/qm-deployment" -type d -name __pycache__ -prune -exec rm -rf -- {} +
tar -czf "$destination" -C "$temporary_dir" qm-deployment
sha256sum "$destination" > "$destination.sha256"
echo "Installer kit: $destination"
echo 'No .env, hosting.env, certificates, runtime data, node_modules, or deployment logs are included.'
