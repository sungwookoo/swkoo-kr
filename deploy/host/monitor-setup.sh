#!/usr/bin/env bash
# monitor-setup.sh — one-shot installer for the resource-report monitor.
#
# Creates:
#   - system user `monitor` (no sudo other than the du rule)
#   - ServiceAccount + ClusterRole + ClusterRoleBinding + Secret in ns
#     `monitoring` (read-only across the cluster)
#   - /etc/monitor/kubeconfig pointing at that SA's token (NOT k3s.yaml)
#   - /etc/sudoers.d/monitor-du allowing /usr/bin/du only
#   - /usr/local/bin/resource-report.sh (from this directory)
#   - ed25519 SSH keypair at /tmp/monitor-key{,.pub}, public key
#     installed into /home/monitor/.ssh/authorized_keys with
#     ForcedCommand + no-pty/no-forwarding restrictions
#
# Idempotent: re-runs do not duplicate users, RBAC, or sudoers rules.
# Re-runs WILL regenerate the SSH keypair; rotate the GH secret if you
# re-run after the initial setup.
#
# Usage (from a workstation with `ssh swkoo-oci` configured):
#
#   scp deploy/host/{monitor-setup.sh,resource-report.sh} swkoo-oci:/tmp/
#   ssh swkoo-oci 'sudo bash /tmp/monitor-setup.sh'
#   ssh swkoo-oci 'sudo cat /tmp/monitor-key'   # ← paste into GH secret OCI_HOST_SSH_KEY
#   ssh swkoo-oci 'sudo rm /tmp/monitor-key /tmp/monitor-key.pub /tmp/monitor-setup.sh /tmp/resource-report.sh'

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPORT="${SCRIPT_DIR}/resource-report.sh"
if [[ ! -f "$SOURCE_REPORT" ]]; then
  echo "missing $SOURCE_REPORT — scp it alongside this script first" >&2
  exit 1
fi

echo "==> [1/7] create system user 'monitor' (idempotent)"
if id -u monitor >/dev/null 2>&1; then
  echo "    user exists, skipping"
else
  # Real shell (bash) is required for SSH ForcedCommand to execute;
  # /usr/sbin/nologin would block sshd. The no-pty / ForcedCommand
  # restrictions in authorized_keys are what actually lock down access.
  useradd --system --create-home --shell /bin/bash monitor
fi
install -d -m 0700 -o monitor -g monitor /home/monitor/.ssh
install -d -m 0755 -o root    -g root    /etc/monitor

echo "==> [2/7] install /usr/local/bin/resource-report.sh"
install -m 0755 -o root -g root "$SOURCE_REPORT" /usr/local/bin/resource-report.sh

echo "==> [3/7] sudoers rule (du only, NOPASSWD)"
# visudo -c validates before writing. Locks to /usr/bin/du; any other
# binary path or shell escape attempt is rejected.
cat > /etc/sudoers.d/monitor-du <<'EOF'
# Allows the resource-report.sh collector to read root-owned k3s state
# (containerd cache, PVC actual usage) WITHOUT broader sudo privileges.
# DO NOT widen — see deploy/host/monitor-setup.sh for rationale.
monitor ALL=(root) NOPASSWD: /usr/bin/du
EOF
chmod 0440 /etc/sudoers.d/monitor-du
visudo -c -f /etc/sudoers.d/monitor-du >/dev/null

echo "==> [4/7] k8s ServiceAccount + read-only ClusterRole + token Secret"
KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: monitor
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitor-readonly
rules:
  - apiGroups: [""]
    resources: ["nodes", "pods", "persistentvolumeclaims", "namespaces"]
    verbs: ["get", "list"]
  - apiGroups: ["argoproj.io"]
    resources: ["applications"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: monitor-readonly
subjects:
  - kind: ServiceAccount
    name: monitor
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: monitor-readonly
  apiGroup: rbac.authorization.k8s.io
---
# k8s >=1.24 doesn't auto-create SA token Secrets; provision an
# explicit long-lived one bound to the SA. The kubelet populates
# .data.token + .data.ca.crt asynchronously after apply.
apiVersion: v1
kind: Secret
metadata:
  name: monitor-token
  namespace: monitoring
  annotations:
    kubernetes.io/service-account.name: monitor
type: kubernetes.io/service-account-token
EOF

echo "==> [5/7] wait for SA token + build /etc/monitor/kubeconfig"
# Token + CA populate within ~1s on k3s; poll for up to 30s before
# bailing out.
for _ in $(seq 1 30); do
  TOKEN=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n monitoring get secret monitor-token -o jsonpath='{.data.token}' 2>/dev/null || true)
  if [[ -n "$TOKEN" ]]; then break; fi
  sleep 1
done
if [[ -z "$TOKEN" ]]; then
  echo "ServiceAccount token never populated — check kube-controller-manager" >&2
  exit 1
fi
TOKEN=$(echo -n "$TOKEN" | base64 -d)
CA=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl -n monitoring get secret monitor-token -o jsonpath='{.data.ca\.crt}')
# Use the cluster's internal API server URL from k3s.yaml. On a single-
# node host that's https://127.0.0.1:6443 — fine for an on-host collector.
SERVER=$(KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')

cat > /etc/monitor/kubeconfig <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: swkoo
    cluster:
      server: $SERVER
      certificate-authority-data: $CA
contexts:
  - name: monitor@swkoo
    context:
      cluster: swkoo
      user: monitor
current-context: monitor@swkoo
users:
  - name: monitor
    user:
      token: $TOKEN
EOF
chown root:monitor /etc/monitor/kubeconfig
chmod 0640 /etc/monitor/kubeconfig

echo "==> [6/7] generate fresh ed25519 keypair for the monitor user"
# Force regeneration each run — the spec says re-runs rotate the key.
# Operator must update OCI_HOST_SSH_KEY GH secret after every re-run.
rm -f /tmp/monitor-key /tmp/monitor-key.pub
ssh-keygen -t ed25519 -N '' -C 'monitor@github-actions' -f /tmp/monitor-key >/dev/null
PUBKEY=$(cat /tmp/monitor-key.pub)

echo "==> [7/7] install pubkey to /home/monitor/.ssh/authorized_keys"
# Single line, restricted to the resource-report.sh ForcedCommand.
# `from=` (IP CIDR) is intentionally NOT set per v0 spec.
cat > /home/monitor/.ssh/authorized_keys <<EOF
no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,command="/usr/local/bin/resource-report.sh" $PUBKEY
EOF
chown monitor:monitor /home/monitor/.ssh/authorized_keys
chmod 0600 /home/monitor/.ssh/authorized_keys

# Make sure the private key is only readable by root (for the
# operator's `sudo cat`); /tmp/ default perms leak to other users.
chmod 0600 /tmp/monitor-key

echo
echo "DONE."
echo
echo "Next steps (operator, from workstation):"
echo "  1) ssh swkoo-oci 'sudo cat /tmp/monitor-key'"
echo "     → paste the entire output (including BEGIN/END lines) into"
echo "       GitHub secret OCI_HOST_SSH_KEY"
echo "  2) Set GitHub secrets: OCI_HOST=<public IP or DNS>, OCI_HOST_USER=monitor,"
echo "     DISCORD_RESOURCE_REPORT_WEBHOOK_URL=<new Discord channel webhook>"
echo "  3) ssh swkoo-oci 'sudo rm /tmp/monitor-key /tmp/monitor-key.pub'"
echo "  4) Sanity check (returns the Discord message body):"
echo "     ssh -i ~/.ssh/<saved-private-key> monitor@<OCI_HOST>"
