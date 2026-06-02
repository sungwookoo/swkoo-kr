#!/usr/bin/env bash
# get-deployed-images.sh — ForcedCommand target for the retention SSH
# key on the monitor user. Reads the swkoo-backend / swkoo-frontend
# Deployment image references and prints one `<repo>:<tag>` line per
# repo, in the form ocir-retention.py expects as positional args.
#
# Output (lf-terminated):
#   swkoo/backend:<sha>
#   swkoo/frontend:<sha>
#
# Any deviation from the expected `nrt.ocir.io/<ns>/swkoo/<repo>:<tag>`
# image path aborts with stderr — better to fail the workflow than
# silently drop the deployed tag and let retention delete it.

set -uo pipefail
export KUBECONFIG=/etc/monitor/kubeconfig
export PATH=/usr/local/bin:/usr/bin:/bin
export LC_ALL=C

for name in swkoo-backend swkoo-frontend; do
  img=$(kubectl get deploy "$name" -n swkoo \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
  if [[ -z "$img" || "$img" != *:* ]]; then
    echo "ERROR: cannot resolve image for deploy/$name" >&2
    exit 1
  fi
  # nrt.ocir.io/<ns>/swkoo/<repo>:<tag>
  if [[ "$img" != */swkoo/* ]]; then
    echo "ERROR: unexpected image path for $name: $img" >&2
    exit 1
  fi
  tag="${img##*:}"
  rest="${img%:*}"
  shortrepo="${rest##*/swkoo/}"
  echo "swkoo/${shortrepo}:${tag}"
done
