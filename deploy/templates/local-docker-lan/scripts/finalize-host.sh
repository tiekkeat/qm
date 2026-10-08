#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
source "$(dirname "${BASH_SOURCE[0]}")/hosting.sh"
install -m 0644 "$deployment_dir/hosting.env" /etc/qm-lan/hosting.env
deployment_user="$(stat -c %U "$deployment_dir")"
deployment_home="$(getent passwd "$deployment_user" | cut -d: -f6)"
printf 'QM_DEPLOYMENT_DIR="%s"\nQM_DEPLOY_USER_HOME="%s"\n' "$deployment_dir" "$deployment_home" >> /etc/qm-lan/hosting.env
for attempt in {1..60}; do
    if docker exec qm-qm-local-pg pg_isready -U postgres -d qm >/dev/null 2>&1 && curl --noproxy '*' --fail --silent --max-time 5 http://127.0.0.1:8080/healthz >/dev/null && curl --noproxy '*' --fail --silent --max-time 5 --cacert "$deployment_dir/$QM_CA_CERT" --resolve "$QM_PORTAL_HOST:443:$QM_LAN_IP" "https://$QM_PORTAL_HOST/healthz" >/dev/null; then
        break
    fi
    sleep 2
done
curl --noproxy '*' --fail --silent --show-error --max-time 15 --cacert "$deployment_dir/$QM_CA_CERT" --resolve "$QM_PORTAL_HOST:443:$QM_LAN_IP" "https://$QM_PORTAL_HOST/healthz" >/dev/null
systemctl start qm-lan-backup.service
backup_name="$(find /var/backups/qm-lan -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort | tail -n 1)"
[[ -n "$backup_name" ]]
(cd "/var/backups/qm-lan/$backup_name" && sha256sum -c SHA256SUMS)
bash "$deployment_dir/scripts/restore-db-check.sh" "/var/backups/qm-lan/$backup_name/database.dump"
python3 - "$deployment_dir" "$backup_name" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
root = Path(sys.argv[1])
owner = root.stat()
destination = root / 'validation/backup-verified.json'
destination.write_text(json.dumps({'verifiedAt': datetime.now(timezone.utc).isoformat(), 'backup': sys.argv[2], 'checksums': 'passed', 'databaseRestore': 'passed'}, indent=2) + '\n')
os.chown(destination, owner.st_uid, owner.st_gid)
PY
echo 'Backup checksums and temporary database recovery: passed.'
