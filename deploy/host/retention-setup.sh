#!/usr/bin/env bash
# retention-setup.sh — augments the existing monitor user with what the
# OCIR retention workflow needs:
#
#   - additional ClusterRole `monitor-deployments` (apps/v1 deployments,
#     get+list) bound to the same monitor SA. Kept SEPARATE from
#     `monitor-readonly` so it can be removed independently.
#   - /usr/local/bin/get-deployed-images.sh as a second ForcedCommand
#     script. Reads the deploy/{backend,frontend} image refs from the
#     `swkoo` namespace.
#   - a NEW ed25519 keypair at /tmp/retention-key{,.pub}; the pubkey is
#     appended to /home/monitor/.ssh/authorized_keys with its OWN
#     ForcedCommand line. The existing resource-report key stays put.
#
# Idempotent. Re-runs:
#   - kubectl apply is upsert (no churn)
#   - the get-deployed-images.sh file is overwritten with the current
#     in-repo version (so a script bugfix can be re-applied)
#   - the SSH keypair is REGENERATED every run; rotate
#     OCI_HOST_RETENTION_SSH_KEY after re-running
#
# Usage (from a workstation with `ssh swkoo-oci` configured):
#
#   scp deploy/host/{retention-setup.sh,get-deployed-images.sh} swkoo-oci:/tmp/
#   ssh swkoo-oci 'sudo bash /tmp/retention-setup.sh'
#   ssh swkoo-oci 'sudo cat /tmp/retention-key'
#     # ↑ paste into GH secret OCI_HOST_RETENTION_SSH_KEY
#   ssh swkoo-oci 'sudo rm /tmp/retention-key /tmp/retention-key.pub /tmp/retention-setup.sh /tmp/get-deployed-images.sh'

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_GET="${SCRIPT_DIR}/get-deployed-images.sh"
if [[ ! -f "$SOURCE_GET" ]]; then
  echo "missing $SOURCE_GET — scp it alongside this script first" >&2
  exit 1
fi

if ! id -u monitor >/dev/null 2>&1; then
  echo "ERROR: monitor user does not exist — run monitor-setup.sh first" >&2
  exit 1
fi

echo "==> [1/4] install /usr/local/bin/get-deployed-images.sh"
install -m 0755 -o root -g root "$SOURCE_GET" /usr/local/bin/get-deployed-images.sh

echo "==> [2/4] ClusterRole monitor-deployments (apps/v1 deployments, get+list)"
KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitor-deployments
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitor-deployments
subjects:
  - kind: ServiceAccount
    name: monitor
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: monitor-deployments
  apiGroup: rbac.authorization.k8s.io
EOF

echo "==> [3/4] generate retention keypair"
rm -f /tmp/retention-key /tmp/retention-key.pub
ssh-keygen -t ed25519 -N '' -C 'monitor-retention@github-actions' -f /tmp/retention-key >/dev/null
PUBKEY=$(cat /tmp/retention-key.pub)
chmod 0600 /tmp/retention-key

echo "==> [4/4] append retention key to authorized_keys with its own ForcedCommand"
AUTH=/home/monitor/.ssh/authorized_keys
LINE="no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,command=\"/usr/local/bin/get-deployed-images.sh\" $PUBKEY"

# Idempotency: drop any prior line whose comment is monitor-retention@github-actions.
# `grep -v` against a stable comment marker is the safest match — we don't
# want to remove the resource-report key by accident.
if grep -q 'monitor-retention@github-actions' "$AUTH" 2>/dev/null; then
  grep -v 'monitor-retention@github-actions' "$AUTH" > "$AUTH.new"
  mv "$AUTH.new" "$AUTH"
fi
echo "$LINE" >> "$AUTH"
chown monitor:monitor "$AUTH"
chmod 0600 "$AUTH"

echo
echo "DONE."
echo
echo "Next steps (operator, from workstation):"
echo "  1) ssh swkoo-oci 'sudo cat /tmp/retention-key'"
echo "     → paste into GH secret OCI_HOST_RETENTION_SSH_KEY"
echo "  2) ssh swkoo-oci 'sudo rm /tmp/retention-key /tmp/retention-key.pub'"
echo "  3) Sanity (returns two 'swkoo/<repo>:<sha>' lines):"
echo "     ssh -i ~/.ssh/<saved-retention-key> monitor@<OCI_HOST>"
