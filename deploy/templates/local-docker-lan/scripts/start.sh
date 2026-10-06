#!/usr/bin/env bash
set -euo pipefail
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$deployment_dir/scripts/hosting.sh"
cd "$deployment_dir"
python3 scripts/configure-hosting.py
if ! command -v docker >/dev/null; then
    echo 'Docker is missing. Install Docker for this host before starting QM.' >&2
    exit 1
fi
docker info >/dev/null
python3 - <<'PY'
from pathlib import Path
values = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
missing = [name for name in ['ADMIN_GRANTS', 'AUTH_ALLOWED_EMAILS', 'PUBLIC_API_URL', 'PORTAL_SESSION_SECRET', 'AWS_DEPLOY_GATE_SECRET'] if not values.get(name)]
if missing:
    raise SystemExit('Run python3 scripts/credentials.py; unset: ' + ', '.join(missing))
PY
if ! docker network inspect qm-qm-local >/dev/null 2>&1; then
    docker network create --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 qm-qm-local >/dev/null
fi
network_binding="$(docker network inspect --format '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' qm-qm-local)"
if [[ "$network_binding" != 127.0.0.1 ]]; then
    echo 'Refusing startup: qm-qm-local network must bind published ports to 127.0.0.1.' >&2
    exit 1
fi
python3 scripts/check-hosting.py
bash scripts/qm.sh check
bash scripts/qm.sh doctor
bash scripts/qm.sh plan --build-from "$QM_SOURCE_DIR"
bash scripts/qm.sh up --build-from "$QM_SOURCE_DIR"
python3 scripts/verify.py
bash scripts/qm.sh conformance
echo "QM endpoint: https://$QM_PORTAL_HOST"
echo "Published apps: https://<app>.$QM_APPS_DOMAIN/"
echo 'To obtain a private login link: bash scripts/qm.sh admin-login'
