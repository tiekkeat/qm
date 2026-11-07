#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$deployment_dir/scripts/hosting.sh"
cd "$deployment_dir"
docker info >/dev/null
python3 scripts/configure-hosting.py
bash scripts/qm.sh check
if ! docker network inspect qm-qm-local >/dev/null 2>&1; then
    docker network create --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 qm-qm-local >/dev/null
fi
binding="$(docker network inspect --format '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' qm-qm-local)"
[[ "$binding" == 127.0.0.1 ]] || { echo 'The QM network must bind published ports to loopback.'; exit 1; }
docker image inspect qm-sandbox-local:latest >/dev/null 2>&1 || (cd "$QM_SOURCE_DIR" && bash scripts/local-sandbox-build.sh)
bash scripts/qm.sh plan --build-from "$QM_SOURCE_DIR"
bash scripts/qm.sh up --build-from "$QM_SOURCE_DIR"
docker update --restart unless-stopped qm-qm-local-core qm-qm-local-pg >/dev/null
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-all-errors --retry-delay 2 --max-time 3 http://127.0.0.1:8080/healthz
bash scripts/qm.sh conformance
