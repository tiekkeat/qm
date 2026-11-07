#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash scripts/install-public-proxy.sh'; exit 1; }
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
if ! command -v caddy >/dev/null; then
    apt-get update
    apt-get install -y caddy
fi
temporary_config="$(mktemp)"
trap 'rm -f "$temporary_config"' EXIT
printf '%s {\n    reverse_proxy 127.0.0.1:8082\n}\n' "$QM_PORTAL_HOST" > "$temporary_config"
caddy validate --config "$temporary_config" --adapter caddyfile
if [[ -f /etc/caddy/Caddyfile ]]; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-qm-$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0644 "$temporary_config" /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo 'Portal proxy installed. HTTPS issuance requires DNS and inbound TCP ports 80 and 443.'
