#!/usr/bin/env bash
# Install reviewed scripts/units without adding credentials or restarting apps.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
install -d -m 0755 /usr/local/lib/swkoo-storage-maintenance
install -d -m 0755 -o ubuntu -g ubuntu /var/lib/swkoo-storage-maintenance
install -m 0644 "$source_dir/scripts/ops/oci-storage-maintenance.py" "$source_dir/scripts/ops/ocir-retention.py" /usr/local/lib/swkoo-storage-maintenance/
install -m 0644 "$source_dir/deploy/host/swkoo-storage-maintenance.service" "$source_dir/deploy/host/swkoo-storage-maintenance.timer" /etc/systemd/system/
install -m 0755 "$source_dir/deploy/host/resource-report.sh" /usr/local/bin/resource-report.sh
systemctl daemon-reload
# Start only the timer: first actual cleanup follows a reviewed dry run.
systemctl enable --now swkoo-storage-maintenance.timer
