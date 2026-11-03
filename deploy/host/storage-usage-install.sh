#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ -x /usr/local/sbin/swkoo-storage-preflight ]] || { echo 'Quota preflight missing' >&2; exit 1; }
install -m 0644 "$source_dir/storage-usage.py" /usr/local/lib/swkoo-storage/storage-usage.py
install -m 0644 "$source_dir/swkoo-storage-usage.service" "$source_dir/swkoo-storage-usage.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl start swkoo-storage-usage.service
systemctl enable --now swkoo-storage-usage.timer
