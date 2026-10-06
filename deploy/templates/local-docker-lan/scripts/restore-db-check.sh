#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! -f "$1" ]]; then
    echo 'Usage: bash scripts/restore-db-check.sh /var/backups/qm-lan/TIMESTAMP/database.dump' >&2
    exit 1
fi
restore_db="qm_restore_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() {
    docker exec qm-qm-local-pg dropdb -U postgres --if-exists "$restore_db" >/dev/null
}
docker exec qm-qm-local-pg createdb -U postgres "$restore_db"
trap cleanup EXIT
docker exec -i qm-qm-local-pg pg_restore -U postgres --exit-on-error --no-owner -d "$restore_db" < "$1"
table_count="$(docker exec qm-qm-local-pg psql -U postgres -d "$restore_db" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[[ "$table_count" =~ ^[0-9]+$ && "$table_count" -gt 0 ]]
echo "Backup restored successfully into a disposable database ($table_count public tables)."
