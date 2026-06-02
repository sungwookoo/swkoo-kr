#!/usr/bin/env bash
# get-deployed-images.sh — ForcedCommand target for the retention SSH
# key on the monitor user. Emits the swkoo-backend / swkoo-frontend
# keep set in the form ocir-retention.py expects:
#
#   swkoo/<repo>:<tag1>[,<tag2>]
#
# For each Deployment we read TWO image refs:
#   - .spec.template.spec.containers[0].image    (Deployment desired)
#   - .status.containerStatuses[0].image          (Pod actually pulled)
# during a rollout these can briefly diverge. The retention workflow
# preserves BOTH so neither side of the rollout gets erased mid-flip.
# When they agree (steady state) the tag appears once.
#
# Any deviation from the expected `nrt.ocir.io/<ns>/swkoo/<repo>:<tag>`
# image path aborts with stderr — better to fail than silently drop
# the deployed tag and let retention delete it.

set -uo pipefail
export KUBECONFIG=/etc/monitor/kubeconfig
export PATH=/usr/local/bin:/usr/bin:/bin
export LC_ALL=C

# Extract "swkoo/<repo>:<tag>" from a full image ref or return "" on
# any deviation. Caller checks for empty.
parse_ref() {
  local img="$1"
  [[ -z "$img" || "$img" != *:* ]] && return 1
  [[ "$img" != */swkoo/* ]] && return 1
  local tag="${img##*:}"
  # Strip a possible "@sha256:..." that some kubelets append after the
  # tag in containerStatuses.image. We only want the tag, not the
  # imageID-style digest.
  tag="${tag%%@*}"
  local rest="${img%:*}"
  local shortrepo="${rest##*/swkoo/}"
  printf 'swkoo/%s:%s' "$shortrepo" "$tag"
}

for name in swkoo-backend swkoo-frontend; do
  desired=$(kubectl get deploy "$name" -n swkoo \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)

  # There may be multiple replicas; take all containerStatuses and
  # dedup. `range` over .items[*] handles any replica count.
  mapfile -t pod_imgs < <(kubectl get pods -n swkoo \
    -l "app=$name" \
    -o jsonpath='{range .items[*]}{.status.containerStatuses[0].image}{"\n"}{end}' 2>/dev/null \
    | sed '/^$/d' || true)

  # Some deploys use a different selector label (we don't know yours
  # without spec.selector). Fall back to a label-free filter that
  # matches by name-prefix on the pods. Cheaper than parsing the
  # deployment spec.
  if (( ${#pod_imgs[@]} == 0 )); then
    mapfile -t pod_imgs < <(kubectl get pods -n swkoo \
      -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[0].image}{"\n"}{end}' 2>/dev/null \
      | awk -v n="$name-" '$1 ~ "^"n {print $2}' \
      | sed '/^$/d' || true)
  fi

  refs=()
  if [[ -n "$desired" ]]; then
    parsed=$(parse_ref "$desired") || { echo "ERROR: bad Deployment image for $name: $desired" >&2; exit 1; }
    refs+=("$parsed")
  fi
  for p in "${pod_imgs[@]}"; do
    parsed=$(parse_ref "$p") || { echo "ERROR: bad Pod image for $name: $p" >&2; exit 1; }
    refs+=("$parsed")
  done

  if (( ${#refs[@]} == 0 )); then
    echo "ERROR: no image refs resolved for $name" >&2
    exit 1
  fi

  # Group by repo (always the same here, but defensive) and dedup tags.
  # Each ref is already "swkoo/<repo>:<tag>"; split, dedup tags per
  # repo, emit one line per repo.
  repo=""
  declare -A seen=()
  tags=()
  for r in "${refs[@]}"; do
    this_repo="${r%:*}"
    this_tag="${r##*:}"
    if [[ -z "$repo" ]]; then repo="$this_repo"; fi
    if [[ "$this_repo" != "$repo" ]]; then
      echo "ERROR: deployment+pod images point at different repos for $name: $repo vs $this_repo" >&2
      exit 1
    fi
    if [[ -z "${seen[$this_tag]:-}" ]]; then
      seen["$this_tag"]=1
      tags+=("$this_tag")
    fi
  done
  unset seen

  # Join tags with ","
  joined=""
  for t in "${tags[@]}"; do
    if [[ -z "$joined" ]]; then joined="$t"; else joined="$joined,$t"; fi
  done
  printf '%s:%s\n' "$repo" "$joined"
done
