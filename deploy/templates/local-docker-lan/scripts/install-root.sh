#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
    echo 'Run with sudo bash scripts/install-root.sh' >&2
    exit 1
fi
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$deployment_dir/scripts/hosting.sh"
: "${QM_LAN_IP:?The Ubuntu host installer needs QM_LAN_IP in hosting.env}"
: "${QM_LAN_INTERFACE:?The Ubuntu host installer needs QM_LAN_INTERFACE in hosting.env}"
: "${QM_LAN_PREFIX:?The Ubuntu host installer needs QM_LAN_PREFIX in hosting.env}"
deployment_user="$(stat -c %U "$deployment_dir")"
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]
ip -4 -o addr show dev "$QM_LAN_INTERFACE" | awk '{print $4}' | grep -Fxq "$QM_LAN_IP/$QM_LAN_PREFIX" || {
    echo "Expected LAN address $QM_LAN_IP/$QM_LAN_PREFIX is missing on $QM_LAN_INTERFACE." >&2
    exit 1
}
for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
        echo "Conflicting package $package is installed; review before replacing it." >&2
        exit 1
    fi
done
apt-get update
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https iptables dnsmasq dnsutils
install -d -m 0755 /etc/apt/keyrings /usr/local/lib/qm-lan /etc/systemd/system/caddy.service.d
curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$temporary_dir/caddy.asc"
gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$temporary_dir/caddy.asc"
curl --fail --silent --show-error --location https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
bash "$deployment_dir/scripts/install-hosting-config.sh"
dnsmasq --test
systemctl enable --now dnsmasq.service
systemctl restart dnsmasq.service
test "$(dig +short +tries=1 +time=2 "@$QM_LAN_IP" "$QM_PORTAL_HOST" A | tail -1)" = "$QM_LAN_IP"
systemctl enable --now qm-lan-firewall.service
apt-get install -y -o Dpkg::Options::=--force-confold caddy
runuser -u caddy -- env QM_LAN_IP="$QM_LAN_IP" QM_PORTAL_HOST="$QM_PORTAL_HOST" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
usermod -aG docker "$deployment_user"
install -m 0755 "$deployment_dir/system/backup.sh" /usr/local/lib/qm-lan/backup.sh
install -m 0644 "$deployment_dir/system/qm-lan-backup.service" /etc/systemd/system/qm-lan-backup.service
install -m 0644 "$deployment_dir/system/qm-lan-backup.timer" /etc/systemd/system/qm-lan-backup.timer
install -d -m 0700 /var/backups/qm-lan
systemctl daemon-reload
systemctl enable --now docker.service caddy.service qm-lan-backup.timer
systemctl restart caddy.service
for attempt in {1..30}; do
    if [[ -f /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ]]; then
        install -d -m 0755 "$deployment_dir/certificates"
        install -m 0644 /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt "$deployment_dir/certificates/qm-lan-root.crt"
        chown -R "$deployment_user" "$deployment_dir/certificates"
        install -m 0644 "$deployment_dir/certificates/qm-lan-root.crt" /usr/local/share/ca-certificates/qm-lan.crt
        update-ca-certificates
        break
    fi
    sleep 1
done
test -f "$deployment_dir/certificates/qm-lan-root.crt"
docker version --format '{{.Server.Version}}'
caddy version
echo 'Host setup complete. Use a new login shell for Docker group membership.'
echo "LAN DNS and app hostnames are configured. Set each LAN PC DNS server to $QM_LAN_IP."
echo "Then run: cd $deployment_dir && python3 scripts/bootstrap-secrets.py && python3 scripts/credentials.py && bash scripts/start.sh"
