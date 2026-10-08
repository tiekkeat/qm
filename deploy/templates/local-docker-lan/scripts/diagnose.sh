#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deployment_dir"
source scripts/hosting.sh
failed=0
check() {
    local name="$1"
    shift
    printf '\nCHECK: %s\n' "$name"
    if "$@"; then
        echo "PASS: $name"
    else
        local status=$?
        echo "FAIL: $name (exit $status)" >&2
        failed=1
    fi
}
if ! docker info >/dev/null 2>&1; then
    if [[ "${QM_DIAGNOSE_DOCKER_GROUP:-0}" == 0 ]] && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -Fxq "$(id -un)"; then
        export QM_DIAGNOSE_DOCKER_GROUP=1
        exec sg docker -c 'bash scripts/diagnose.sh'
    fi
    echo 'Docker access unavailable. Check Docker service and group membership.' >&2
    failed=1
fi
check 'Node version' node --version
check 'npm version' npm --version
core_state() {
    local state
    state="$(docker inspect --format 'state={{.State.Status}} restarts={{.RestartCount}} exit={{.State.ExitCode}} error={{.State.Error}}' qm-qm-local-core)" || return
    echo "$state"
    [[ "$state" == 'state=running '* ]]
}
check 'Docker services' docker ps -a --filter label=qm.org=qm-local --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
check 'Core state' core_state
check 'Core health' curl --noproxy '*' --fail --silent --show-error --max-time 15 http://127.0.0.1:8080/healthz
check 'Firewall portal and wildcard DNS' python3 scripts/check-hosting.py
check 'HTTPS and authentication gates' python3 scripts/verify.py
check 'Deployment conformance' bash scripts/qm.sh conformance
check 'Recent core logs' docker logs --tail 40 qm-qm-local-core
if [[ -f /etc/docker/daemon.json ]]; then
    echo 'INFO: optional Docker daemon.json is present.'
else
    echo 'INFO: optional Docker daemon.json is absent; Docker uses its defaults. This is normal.'
fi
if sudo -n true 2>/dev/null; then
    echo 'INFO: sudo is available without a password prompt in this session.'
else
    echo 'INFO: sudo requires a terminal password prompt. This is normal; it does not mean core failed.'
fi
exit "$failed"
