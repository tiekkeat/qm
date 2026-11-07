#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash scripts/install-public-proxy.sh'; exit 1; }
mode="${1:-public}"
[[ "$mode" == public || "$mode" == --private ]] || { echo "Usage: sudo bash scripts/install-public-proxy.sh [--private]"; exit 2; }
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
if ! command -v caddy >/dev/null; then
    apt-get update
    apt-get install -y caddy
fi
temporary_config="$(mktemp)"
trap 'rm -f "$temporary_config"' EXIT
printf '%s {\n    reverse_proxy 127.0.0.1:8082\n}\n' "$QM_PORTAL_HOST" > "$temporary_config"
if [[ "$mode" == --private ]]; then
    printf '%s {\n    tls internal\n    reverse_proxy 127.0.0.1:8082\n}\n*.apps.%s {\n    tls internal\n    reverse_proxy 127.0.0.1:8082 {\n        header_up X-QM-App-Host 1\n    }\n}\n' "$QM_PORTAL_HOST" "$QM_PORTAL_HOST" > "$temporary_config"
fi
caddy validate --config "$temporary_config" --adapter caddyfile
if [[ -f /etc/caddy/Caddyfile ]]; then
    cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-qm-$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0644 "$temporary_config" /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
if [[ "$mode" == --private ]]; then
    install -d -m 0755 "$deployment_dir/certificates"
    curl --fail --silent --show-error http://127.0.0.1:2019/pki/ca/local | python3 -c 'import json,sys;print(json.load(sys.stdin)["root_certificate"],end="")' > "$deployment_dir/certificates/qm-lan-root.crt"
    chmod 0644 "$deployment_dir/certificates/qm-lan-root.crt"
    install -m 0644 "$deployment_dir/certificates/qm-lan-root.crt" /usr/local/share/ca-certificates/qm-lan.crt
    update-ca-certificates
    echo "Private portal and wildcard apps configured. Trust $deployment_dir/certificates/qm-lan-root.crt on clients."
else
    echo 'Portal proxy installed. HTTPS issuance requires DNS and inbound TCP ports 80 and 443.'
fi
