#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo 'Run this script as root.' >&2
    exit 1
fi
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
deployment_user="$(stat -c %U "$deployment_dir")"
deployment_home="$(getent passwd "$deployment_user" | cut -d: -f6)"
install -d -m 0755 /etc/qm-lan /etc/caddy /etc/systemd/system/caddy.service.d /usr/local/lib/qm-lan
install -m 0644 "$deployment_dir/hosting.env" /etc/qm-lan/hosting.env
printf 'QM_DEPLOYMENT_DIR="%s"\nQM_DEPLOY_USER_HOME="%s"\n' "$deployment_dir" "$deployment_home" >> /etc/qm-lan/hosting.env
sed -e "s/@QM_LAN_INTERFACE@/$QM_LAN_INTERFACE/g" \
    -e "s/@QM_LAN_IP@/$QM_LAN_IP/g" \
    -e "s/@QM_PORTAL_HOST@/$QM_PORTAL_HOST/g" \
    "$deployment_dir/system/dnsmasq-qm.conf" > /etc/dnsmasq.d/qm-lan.conf
chmod 0644 /etc/dnsmasq.d/qm-lan.conf
install -m 0755 "$deployment_dir/system/firewall.sh" /usr/local/lib/qm-lan/firewall.sh
install -m 0644 "$deployment_dir/system/qm-lan-firewall.service" /etc/systemd/system/qm-lan-firewall.service
if [[ -f /etc/caddy/Caddyfile ]] && ! cmp -s /etc/caddy/Caddyfile "$deployment_dir/system/Caddyfile"; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-qm-$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0644 "$deployment_dir/system/Caddyfile" /etc/caddy/Caddyfile
install -m 0644 "$deployment_dir/system/caddy-lan.conf" /etc/systemd/system/caddy.service.d/qm-lan.conf
systemctl daemon-reload
