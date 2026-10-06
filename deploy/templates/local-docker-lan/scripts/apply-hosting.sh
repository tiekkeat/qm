#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo 'Run this script with sudo.' >&2
    exit 1
fi
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$deployment_dir/scripts/hosting.sh"
: "${QM_LAN_IP:?The Ubuntu host installer needs QM_LAN_IP in hosting.env}"
: "${QM_LAN_INTERFACE:?The Ubuntu host installer needs QM_LAN_INTERFACE in hosting.env}"
: "${QM_LAN_PREFIX:?The Ubuntu host installer needs QM_LAN_PREFIX in hosting.env}"
ip -4 -o addr show dev "$QM_LAN_INTERFACE" | awk '{print $4}' | grep -Fxq "$QM_LAN_IP/$QM_LAN_PREFIX" || {
    echo "Expected LAN address $QM_LAN_IP/$QM_LAN_PREFIX is missing on $QM_LAN_INTERFACE." >&2
    exit 1
}
apt-get update
apt-get install -y dnsmasq dnsutils
bash "$deployment_dir/scripts/install-hosting-config.sh"
dnsmasq --test
systemctl enable --now dnsmasq.service
systemctl restart dnsmasq.service
test "$(dig +short +tries=1 +time=2 "@$QM_LAN_IP" "$QM_PORTAL_HOST" A | tail -1)" = "$QM_LAN_IP"
test "$(dig +short +tries=1 +time=2 "@$QM_LAN_IP" "qm-probe.$QM_APPS_DOMAIN" A | tail -1)" = "$QM_LAN_IP"
systemctl restart qm-lan-firewall.service
runuser -u caddy -- env QM_LAN_IP="$QM_LAN_IP" QM_PORTAL_HOST="$QM_PORTAL_HOST" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl restart caddy.service
for attempt in {1..30}; do
    if curl --noproxy '*' --fail --silent --show-error --max-time 3 --cacert "$deployment_dir/certificates/qm-lan-root.crt" \
        --resolve "$QM_PORTAL_HOST:443:$QM_LAN_IP" "https://$QM_PORTAL_HOST/healthz" >/dev/null; then
        break
    fi
    if (( attempt == 30 )); then
        echo 'Caddy is configured, but the portal health check did not pass.' >&2
        exit 1
    fi
    sleep 1
done
echo "LAN DNS and HTTPS app-host routing are ready. Set each LAN PC DNS server to $QM_LAN_IP."
