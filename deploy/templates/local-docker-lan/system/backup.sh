#!/usr/bin/env bash
set -euo pipefail
source /etc/qm-lan/hosting.env
umask 077
exec 9>/run/lock/qm-lan-backup.lock
flock -n 9 || exit 0
backup_root=/var/backups/qm-lan
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
staging_dir="$backup_root/.incomplete-$backup_stamp"
backup_dir="$backup_root/$backup_stamp"
install -d -m 0700 "$backup_root" "$staging_dir"
trap 'rm -rf -- "$staging_dir"' EXIT
docker inspect --format '{{.State.Running}}' qm-qm-local-pg | grep -qx true
docker exec qm-qm-local-pg pg_dump -U postgres -d qm -Fc > "$staging_dir/database.dump"
test -s "$staging_dir/database.dump"
tar -czf "$staging_dir/deployment.tar.gz" -C "$QM_DEPLOYMENT_DIR" --exclude=node_modules --exclude=.git --exclude=backups --exclude=validation .
if [[ -d "$QM_DEPLOY_USER_HOME/.config/qm/deployments/qm-local" ]]; then
    tar -czf "$staging_dir/cli-state.tar.gz" -C "$QM_DEPLOY_USER_HOME/.config/qm/deployments" qm-local
fi
tar -czf "$staging_dir/caddy-state.tar.gz" -C /var/lib/caddy .
python3 - "$staging_dir" <<'PY'
import json
import subprocess
import sys
from pathlib import Path
destination = Path(sys.argv[1])
containers = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=qm.org=qm-local'], text=True).split()
volumes = {'qm-qm-local-coredata'}
images = {}
for container in containers:
    item = json.loads(subprocess.check_output(['docker', 'inspect', container], text=True))[0]
    images[item['Name'].lstrip('/')] = {'reference': item['Config']['Image'], 'imageId': item['Image']}
    for mount in item.get('Mounts', []):
        if mount['Type'] == 'volume' and mount['Name'] != 'qm-qm-local-pgdata':
            volumes.add(mount['Name'])
(destination / 'images.json').write_text(json.dumps(images, indent=2) + '\n')
manifest = []
for volume in sorted(volumes):
    mountpoint = subprocess.check_output(['docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', volume], text=True).strip()
    filename = f'volume-{len(manifest):03d}.tar.gz'
    subprocess.run(['tar', '-czf', str(destination / filename), '-C', mountpoint, '.'], check=True)
    manifest.append({'volume': volume, 'archive': filename})
(destination / 'volumes.json').write_text(json.dumps(manifest, indent=2) + '\n')
PY
(cd "$staging_dir" && sha256sum ./* > SHA256SUMS)
mv "$staging_dir" "$backup_dir"
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +6 -exec rm -rf -- {} +
echo "QM backup completed: $backup_dir"
