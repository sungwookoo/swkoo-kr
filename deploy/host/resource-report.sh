#!/usr/bin/env bash
# resource-report.sh — single-file read-only collector for swkoo.kr.
#
# Reads host vitals + kubectl/RBAC-scoped cluster state and emits one
# Discord-ready message body to stdout. Invoked by .github/workflows/
# resource-report.yml via SSH ForcedCommand on the OCI host's `monitor`
# user. NEVER writes anywhere; if you find yourself adding `>`, stop.
#
# Install: copied to /usr/local/bin/resource-report.sh by deploy/host/
# monitor-setup.sh. Source of truth lives in git (this file).

set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
export KUBECONFIG=/etc/monitor/kubeconfig
export LC_ALL=C

# Oracle's Always Free documentation now lists Ampere A1 as 2 OCPU /
# 12 GB total. The host may still be a legacy 4 OCPU / 24 GB shape, but
# this report grades CPU and RAM against the smaller target so we see
# pressure before a forced resize or policy change hurts production.
TARGET_OCPU=2
TARGET_MEM_MB=12288

# ---- Severity tracker ----
worst="OK"
bump() {
  case "$1" in
    CRIT) worst="CRIT" ;;
    WARN) [[ "$worst" != "CRIT" ]] && worst="WARN" ;;
  esac
}
# level VAL WARN_PCT CRIT_PCT → emits OK/WARN/CRIT and bumps worst.
level() {
  local v=$1 w=$2 c=$3
  if   (( v >= c )); then bump CRIT; printf '%s' "CRIT"
  elif (( v >= w )); then bump WARN; printf '%s' "WARN"
  else printf '%s' "OK"; fi
}

# ---- Collect ----
NOW=$(TZ='Asia/Seoul' date '+%Y-%m-%d %H:%M KST')
UPTIME=$(uptime -p 2>/dev/null | sed 's/^up //')
LOAD=$(awk '{print $1, $2, $3}' /proc/loadavg)

CPU_IDLE=$(top -bn1 2>/dev/null | awk -F'[ ,%]+' '/Cpu\(s\)/{for(i=1;i<=NF;i++) if($(i+1)=="id"){print int($i); exit}}')
CPU_IDLE=${CPU_IDLE:-100}
CPU_BUSY=$((100 - CPU_IDLE))
CPU_COUNT=$(nproc 2>/dev/null || echo 1)
CPU_TARGET_PCT=$((CPU_BUSY * CPU_COUNT / TARGET_OCPU))
CPU_LV=$(level $CPU_TARGET_PCT 75 90)

MEM_TOTAL=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
MEM_TARGET_PCT=$((MEM_USED * 100 / TARGET_MEM_MB))
MEM_LV=$(level $MEM_TARGET_PCT 75 90)

ROOT_PCT=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
ROOT_USED=$(df -h / | awk 'NR==2{print $3}')
ROOT_SIZE=$(df -h / | awk 'NR==2{print $2}')
ROOT_LV=$(level "${ROOT_PCT:-0}" 75 85)

# /data may be absent on a dev host; emit N/A rather than failing.
if mountpoint -q /data 2>/dev/null; then
  DATA_PCT=$(df -P /data | awk 'NR==2{gsub("%","",$5); print $5}')
  DATA_USED=$(df -h /data | awk 'NR==2{print $3}')
  DATA_SIZE=$(df -h /data | awk 'NR==2{print $2}')
  DATA_LV=$(level "${DATA_PCT:-0}" 75 85)
else
  DATA_PCT="N/A"; DATA_USED="-"; DATA_SIZE="-"; DATA_LV="OK"
fi

# containerd image cache. Requires sudo (root-owned). Sudoers rule is
# locked to /usr/bin/du only — see monitor-setup.sh.
CONT_SIZE=$(sudo /usr/bin/du -sh /var/lib/rancher/k3s/agent/containerd 2>/dev/null | awk '{print $1}')
CONT_SIZE=${CONT_SIZE:-N/A}

# PVC actual usage top 5. Same sudoers rule as containerd cache.
# `du -d 1` lists each direct child + the parent total at the end; the
# parent is also the largest by definition. sort -hr floats it to the
# top so `tail -n +2` strips it, leaving per-PVC entries. We avoid
# shell glob (`/path/*`) because the monitor user can't read the
# parent dir — glob would expand to literal `*` and du would fail.
# `-s` is incompatible with `-d 1`; omit it.
PVC_TOP=$(sudo /usr/bin/du -hx -d 1 /var/lib/rancher/k3s/storage 2>/dev/null \
  | sort -hr | tail -n +2 | head -5 \
  | awk '{
      name=$2;
      sub(".*/","",name);              # drop everything up to last /
      sub("^pvc-[^_]+_","",name);      # drop pvc-<uuid>_ prefix
      sub("_","/",name);               # ns_name → ns/name
      if (length(name) > 60) name=substr(name,1,57) "...";
      printf "  %-6s %s\n", $1, name
    }')

# kubectl: node ready + pressure conditions
NODE_NAME=$(kubectl get nodes --no-headers 2>/dev/null | awk 'NR==1{print $1}')
NODE_READY=$(kubectl get nodes --no-headers 2>/dev/null | awk 'NR==1{print $2}')
PRESSURE=$(kubectl get nodes -o jsonpath='{range .items[*].status.conditions[?(@.status=="True")]}{.type} {end}' 2>/dev/null \
  | tr ' ' '\n' | grep Pressure || true)
if [[ -n "$PRESSURE" ]]; then
  bump WARN
  PRESSURE_TXT="$(echo "$PRESSURE" | tr '\n' ',' | sed 's/,$//')"
  NODE_LV="WARN"
else
  PRESSURE_TXT="no pressure"
  NODE_LV="OK"
fi

# Pods. Status column "Completed" === phase Succeeded; abnormal = any
# other non-Running.
POD_TBL=$(kubectl get pods -A --no-headers 2>/dev/null)
TOTAL_PODS=$(printf '%s\n' "$POD_TBL" | sed '/^$/d' | wc -l)
RUNNING_PODS=$(printf '%s\n' "$POD_TBL" | awk '$4 == "Running"' | wc -l)
SUCC_PODS=$(printf '%s\n' "$POD_TBL" | awk '$4 == "Completed"' | wc -l)
ABNORMAL=$((TOTAL_PODS - RUNNING_PODS - SUCC_PODS))
ABNORMAL_LIST=""
if (( ABNORMAL > 0 )); then
  bump WARN
  ABNORMAL_LIST=$(printf '%s\n' "$POD_TBL" \
    | awk '$4 != "Running" && $4 != "Completed" {printf "  %s/%s  %s\n", $1, $2, $4}' \
    | head -10)
fi
POD_LV=$([[ $ABNORMAL -gt 0 ]] && echo WARN || echo OK)

# ArgoCD Applications
APP_TBL=$(kubectl get application -n argocd --no-headers 2>/dev/null)
APP_TOTAL=$(printf '%s\n' "$APP_TBL" | sed '/^$/d' | wc -l)
APP_OK=$(printf '%s\n' "$APP_TBL" | awk '$2 == "Synced" && $3 == "Healthy"' | wc -l)
APP_BAD=$((APP_TOTAL - APP_OK))
APP_BAD_LIST=""
if (( APP_BAD > 0 )); then
  bump WARN
  APP_BAD_LIST=$(printf '%s\n' "$APP_TBL" \
    | awk '$2 != "Synced" || $3 != "Healthy" {printf "  %s  %s/%s\n", $1, $2, $3}')
fi
APP_LV=$([[ $APP_BAD -gt 0 ]] && echo WARN || echo OK)

# PVCs — drop non-Gi entries from the sum (v0 baseline; all current
# PVCs are local-path Gi-scoped). Column layout from `kubectl get pvc`
# is: NS NAME STATUS VOLUME CAPACITY … so capacity is field 5, not 4.
PVC_TBL=$(kubectl get pvc -A --no-headers 2>/dev/null)
PVC_TOTAL=$(printf '%s\n' "$PVC_TBL" | sed '/^$/d' | wc -l)
PVC_BOUND=$(printf '%s\n' "$PVC_TBL" | awk '$3 == "Bound"' | wc -l)
PVC_ALLOC=$(printf '%s\n' "$PVC_TBL" \
  | awk '{cap=$5; if (cap ~ /Gi$/) { sub("Gi","",cap); sum+=cap }} END {printf "%dGi", sum+0}')

# ---- Render ----
case "$worst" in
  CRIT) ICON="🚨" ;;
  WARN) ICON="⚠️" ;;
  *)    ICON="📊" ;;
esac

# Discord 2000-char limit; the renderer is intentionally compact.
# The body is wrapped in a ``` ``` code block so Discord renders it
# with a fixed-width font and `[OK]`/`[WARN]`/`[CRIT]` columns line up.
# Pad level to 4 chars so the next column is consistent.
fmt_lv() { printf '%-4s' "$1"; }

{
  printf '%s **swkoo.kr daily resource report** — `%s`\n' "$ICON" "$NOW"
  printf '```\n'
  printf '[%s] Host:      uptime %s, load %s\n' "$(fmt_lv OK)" "$UPTIME" "$LOAD"
  printf '[%s] CPU:       %d%% host busy (~%d%% of %d OCPU target)\n' "$(fmt_lv "$CPU_LV")" "$CPU_BUSY" "$CPU_TARGET_PCT" "$TARGET_OCPU"
  printf '[%s] Memory:    %dM / %dM host (%d%% host, %d%% of 12GB target)\n' "$(fmt_lv "$MEM_LV")" "$MEM_USED" "$MEM_TOTAL" "$MEM_PCT" "$MEM_TARGET_PCT"
  printf '[%s] Disk /:    %s / %s (%s%%)\n' "$(fmt_lv "$ROOT_LV")" "$ROOT_USED" "$ROOT_SIZE" "${ROOT_PCT}"
  printf '[%s] Disk/data: %s / %s (%s%%)\n' "$(fmt_lv "$DATA_LV")" "$DATA_USED" "$DATA_SIZE" "${DATA_PCT}"
  printf '[%s] containerd cache: %s\n' "$(fmt_lv OK)" "$CONT_SIZE"
  printf '[%s] Node:      %s %s — %s\n' "$(fmt_lv "$NODE_LV")" "$NODE_NAME" "$NODE_READY" "$PRESSURE_TXT"
  printf '[%s] Pods:      %d Running, %d abnormal (Succeeded=%d)\n' \
    "$(fmt_lv "$POD_LV")" "$RUNNING_PODS" "$ABNORMAL" "$SUCC_PODS"
  [[ -n "$ABNORMAL_LIST" ]] && printf '%s\n' "$ABNORMAL_LIST"
  printf '[%s] Argo:      %d Synced/Healthy of %d\n' "$(fmt_lv "$APP_LV")" "$APP_OK" "$APP_TOTAL"
  [[ -n "$APP_BAD_LIST" ]] && printf '%s\n' "$APP_BAD_LIST"
  printf '[%s] PVCs:      %d Bound / %d total, allocated %s\n' "$(fmt_lv OK)" "$PVC_BOUND" "$PVC_TOTAL" "$PVC_ALLOC"
  if [[ -n "$PVC_TOP" ]]; then
    printf 'PVC top (actual on /data):\n%s\n' "$PVC_TOP"
  fi
  printf '\n'
  printf 'Free Tier target: %d OCPU / 12GB RAM / 200GB BV / 20GB Object\n' "$TARGET_OCPU"
  printf 'Note: current host may still report legacy 4 OCPU / 24GB allocatable.\n'
  printf 'OCIR: 수동 점검 (v0 범위 제외)\n'
  printf '```\n'
}
