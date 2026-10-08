#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$PATH"
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$deployment_dir"
mode=full
case "${1:-}" in
    '') ;;
    --prepare-only) mode=prepare ;;
    --deploy-only) mode=deploy ;;
    --help)
        echo 'Usage: bash scripts/install.sh [--prepare-only|--deploy-only]'
        echo 'Default: configure, install host prerequisites, deploy source, verify, and test backups.'
        echo '--prepare-only: configure and validate without installing host services or deploying.'
        echo '--deploy-only: deploy on a host whose Docker and Caddy are already configured.'
        exit 0 ;;
    *) echo 'Unknown option. Use --help.' >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { echo 'Only one mode flag is allowed.' >&2; exit 2; }
[[ $EUID -ne 0 ]] || { echo 'Run as your normal user; the installer calls sudo for host operations.' >&2; exit 1; }
stage=prerequisites
trap 'status=$?; printf "\nFAILED stage=%s line=%s exit=%s\nCommand: %s\nLog: %s\n" "$stage" "$LINENO" "$status" "$BASH_COMMAND" "${log_file:-not-created}" >&2; exit "$status"' ERR
missing=()
for executable in curl python3 git openssl tar xz; do
    command -v "$executable" >/dev/null || missing+=("$executable")
done
if (( ${#missing[@]} )); then
    if [[ "$mode" != full ]]; then
        echo "Missing prerequisites: ${missing[*]}. Install curl python3 git openssl xz-utils ca-certificates." >&2
        exit 1
    fi
    sudo apt-get update
    sudo apt-get install -y curl python3 git openssl xz-utils ca-certificates
fi
mkdir -p validation
log_file="$deployment_dir/validation/install-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
touch "$log_file"
chmod 0600 "$log_file"
exec > >(tee -a "$log_file") 2>&1
stage=hosting-configuration
echo "STAGE: $stage"
if [[ ! -f hosting.env ]]; then
    [[ -t 0 ]] || { echo 'Create hosting.env from hosting.env.example before noninteractive installation.' >&2; exit 1; }
    detected_interface="$(ip -4 route show default | awk 'NR==1 {print $5}')"
    detected_address="$(ip -4 -o address show dev "$detected_interface" | awk 'NR==1 {print $4}')"
    read -r -p 'Portal hostname: ' portal_host
    read -r -p 'Source checkout path [../qm]: ' source_dir
    read -r -p "LAN interface [$detected_interface]: " lan_interface
    read -r -p "Permanent LAN IPv4 address [${detected_address%/*}]: " lan_ip
    read -r -p "LAN prefix length [${detected_address#*/}]: " lan_prefix
    read -r -p 'Firewall DNS server IP [use host resolver]: ' dns_server
    {
        printf 'QM_PORTAL_HOST=%q\n' "$portal_host"
        printf 'QM_SOURCE_DIR=%q\n' "${source_dir:-../qm}"
        printf 'QM_LAN_IP=%q\n' "${lan_ip:-${detected_address%/*}}"
        if [[ -n "$dns_server" ]]; then
            printf 'QM_DNS_SERVER=%q\n' "$dns_server"
        else
            printf 'QM_DNS_SERVER=\n'
        fi
        printf 'QM_CA_CERT=certificates/qm-lan-root.crt\n'
        printf 'QM_LAN_INTERFACE=%q\n' "${lan_interface:-$detected_interface}"
        printf 'QM_LAN_PREFIX=%q\n' "${lan_prefix:-${detected_address#*/}}"
    } > hosting.env
fi
source scripts/hosting.sh
python3 - <<'PY'
import json
from pathlib import Path
config = json.loads(Path('qm.config.jsonc').read_text())
if config.get('orgId') != 'qm-local' or config.get('target') != 'docker':
    raise SystemExit('This template requires orgId=qm-local and target=docker; orgName controls display branding.')
PY
bash scripts/configure-hosting.sh
stage=node-and-cli
echo "STAGE: $stage"
bash scripts/install-node.sh
npm ci --no-audit --no-fund
stage=secrets-and-administrator
echo "STAGE: $stage"
python3 scripts/bootstrap-secrets.py
if ! python3 - <<'PY'
from pathlib import Path
values = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines() if line and not line.startswith('#') and '=' in line)
raise SystemExit(0 if values.get('ADMIN_GRANTS') and values.get('AUTH_ALLOWED_EMAILS') and values.get('PUBLIC_API_URL') else 1)
PY
then
    python3 scripts/credentials.py
fi
python3 - <<'PY'
import os
import tempfile
from pathlib import Path
path = Path('.env')
values = dict(line.split('=', 1) for line in path.read_text().splitlines() if line and not line.startswith('#') and '=' in line)
for name in ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'AUTH_EMAIL_FROM']:
    values.setdefault(name, '')
descriptor, temporary = tempfile.mkstemp(dir='.', prefix='.env-')
try:
    with os.fdopen(descriptor, 'w') as output:
        output.write(''.join(f'{name}={value}\n' for name, value in values.items()))
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
stage=static-validation
echo "STAGE: $stage"
bash scripts/qm.sh check
bash scripts/qm.sh conformance --static
if [[ "$mode" == prepare ]]; then
    echo 'Preparation passed. No host services or Docker containers were changed.'
    exit 0
fi
stage=firewall-dns
echo "STAGE: $stage"
echo "DNS must resolve $QM_PORTAL_HOST and *.apps.$QM_PORTAL_HOST to $QM_LAN_IP."
python3 scripts/check-hosting.py
if [[ "$mode" == full ]]; then
    stage=host-installation
    echo "STAGE: $stage"
    sudo bash scripts/install-host.sh
fi
stage=source-deployment-and-live-verification
echo "STAGE: $stage"
if docker info >/dev/null 2>&1; then
    bash scripts/start.sh
else
    sg docker -c 'bash scripts/start.sh'
fi
if [[ "$mode" == full ]]; then
    stage=backup-and-recovery-test
    echo "STAGE: $stage"
    sudo bash scripts/finalize-host.sh
fi
stage=complete
echo "STAGE: $stage"
echo "Portal: https://$QM_PORTAL_HOST"
echo "Admin: https://$QM_PORTAL_HOST/admin/"
echo "Apps: https://<app>.apps.$QM_PORTAL_HOST/"
echo "Trust the public CA certificate on clients: $deployment_dir/certificates/qm-lan-root.crt"
echo 'Generate a private administrator login link yourself: bash scripts/qm.sh admin-login'
echo 'AI responses require a configured model provider. SMTP sign-in requires configured email credentials.'
echo "Installation log: $log_file"
