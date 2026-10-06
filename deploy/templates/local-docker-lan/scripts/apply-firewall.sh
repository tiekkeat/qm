#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo 'Run this script with sudo.' >&2
    exit 1
fi
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$deployment_dir/scripts/hosting.sh"
bash "$deployment_dir/scripts/install-hosting-config.sh"
systemctl restart qm-lan-firewall.service
systemctl restart caddy.service
iptables -w -S QM-LAN
curl --noproxy '*' --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --cacert "$deployment_dir/certificates/qm-lan-root.crt" --resolve "$QM_PORTAL_HOST:443:$QM_LAN_IP" "https://$QM_PORTAL_HOST/healthz"
echo
echo "QM HTTPS now accepts any source address: https://$QM_PORTAL_HOST"
