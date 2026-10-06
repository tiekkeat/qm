#!/usr/bin/env bash
set -euo pipefail
deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$deployment_dir/hosting.env" ]]; then
    echo 'Copy hosting.env.example to hosting.env and set the portal hostname first.' >&2
    exit 1
fi
source "$deployment_dir/hosting.env"
: "${QM_PORTAL_HOST:?Set QM_PORTAL_HOST in hosting.env}"
QM_SOURCE_DIR="${QM_SOURCE_DIR:-../qm}"
if [[ "$QM_SOURCE_DIR" == /* ]]; then
    QM_SOURCE_DIR="$(cd "$QM_SOURCE_DIR" && pwd)"
else
    QM_SOURCE_DIR="$(cd "$deployment_dir/$QM_SOURCE_DIR" && pwd)"
fi
QM_LAN_IP="${QM_LAN_IP:-}"
QM_DNS_SERVER="${QM_DNS_SERVER:-}"
QM_CA_CERT="${QM_CA_CERT:-}"
QM_LAN_INTERFACE="${QM_LAN_INTERFACE:-}"
QM_LAN_PREFIX="${QM_LAN_PREFIX:-}"
export QM_PORTAL_HOST QM_SOURCE_DIR QM_LAN_IP QM_DNS_SERVER QM_CA_CERT QM_LAN_INTERFACE QM_LAN_PREFIX
export QM_APPS_DOMAIN="apps.$QM_PORTAL_HOST"
python3 - <<'PY'
import ipaddress
import os
import re

host = os.environ['QM_PORTAL_HOST']
if len(host) > 253 or not re.fullmatch(r'[a-z0-9-]+(?:\.[a-z0-9-]+)+', host):
    raise SystemExit('QM_PORTAL_HOST must be a lower-case DNS hostname')
if any(label.startswith('-') or label.endswith('-') or len(label) > 63 for label in host.split('.')):
    raise SystemExit('QM_PORTAL_HOST contains an invalid DNS label')
ip = os.environ['QM_LAN_IP']
prefix = os.environ['QM_LAN_PREFIX']
if ip:
    ipaddress.IPv4Address(ip)
if prefix:
    if not ip:
        raise SystemExit('QM_LAN_PREFIX requires QM_LAN_IP')
    ipaddress.IPv4Interface(f'{ip}/{prefix}')
interface = os.environ['QM_LAN_INTERFACE']
if interface and not re.fullmatch(r'[A-Za-z0-9_.:-]+', interface):
    raise SystemExit('QM_LAN_INTERFACE contains invalid characters')
dns = os.environ['QM_DNS_SERVER']
if dns:
    ipaddress.IPv4Address(dns)
PY
