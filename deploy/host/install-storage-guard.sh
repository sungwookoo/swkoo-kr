#!/bin/sh
# Run only after offline conversion, remount, and project-quota verification.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test "$(id -u)" -eq 0
install -d -o root -g root -m 0755 /usr/local/lib/swkoo-storage /var/lib/kubelet/seccomp
install -o root -g root -m 0644 "$SCRIPT_DIR/../storage/quota.py" /usr/local/lib/swkoo-storage/quota.py
install -o root -g root -m 0644 "$SCRIPT_DIR/user-storage-seccomp.json" /var/lib/kubelet/seccomp/swkoo-user-storage-v1.json
install -o root -g root -m 0755 "$SCRIPT_DIR/storage-preflight.py" /usr/local/sbin/swkoo-storage-preflight
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
config={'volumeUuid':'ada291fe-68a3-4e69-9f29-8ba24c1d421c','profileSha256':hashlib.sha256(Path('/var/lib/kubelet/seccomp/swkoo-user-storage-v1.json').read_bytes()).hexdigest()}
fd=os.open('/etc/swkoo-storage.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as file:json.dump(config,file)
PY
/usr/local/sbin/swkoo-storage-preflight
printf '%s\n' quota_v2 > /etc/modules-load.d/swkoo-user-storage.conf
install -d -o root -g root -m 0755 /etc/systemd/system/k3s.service.d
install -o root -g root -m 0644 "$SCRIPT_DIR/k3s-storage-guard.conf" /etc/systemd/system/k3s.service.d/20-swkoo-storage.conf
systemctl daemon-reload
