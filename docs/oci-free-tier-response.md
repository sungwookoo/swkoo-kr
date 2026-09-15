# OCI Always Free capacity response

Updated: 2026-09-15

Verified in OCI Console: Pay As You Go, current-month displayed cost SGD 0.00.
Instance metadata confirms 4 OCPU / 24 GB. Oracle's [paid-account price list](https://www.oracle.com/cloud/price-list/)
includes 3,000 A1 OCPU-hours and 18,000 GB-hours monthly. The [Always Free-only documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
currently describes 2 OCPU / 12 GB; do not infer that this paid tenancy must resize.

## Non-disruptive actions already taken

- Daily `resource-report.sh` grades CPU/RAM against a 2 OCPU / 12 GB
  target while still printing the current host capacity.
- Public copy no longer promises 4 OCPU / 24 GB as the durable baseline.
- Business/readiness docs call out Free Tier capacity drift as an
  operating risk.

## Operating policy

- Do not resize, reboot, or stop the instance just to chase documentation
  changes. First confirm billing/account behavior.
- Use measured 4 OCPU / 24 GB capacity for current planning. The existing
  report still evaluates a conservative 2/12 fallback scenario; it is not
  the actual allocation or a verified user-capacity limit.
- Keep Block Volume planning at 200 GB unless Oracle changes that
  separate allowance.
- Avoid adding always-on control-plane components unless they replace
  something heavier.
- Prefer on-demand jobs over resident pods for scans, cleanup, and
  diagnostics.

## Immediate manual checks

- OCI Billing: confirm current month cost remains zero.
- OCI Budgets: set a low alert threshold, for example 1 USD and 5 USD.
- OCI Compute: check whether the existing A1 instance still has an
  Always Free label or any paid-resource warning.
- Backups: confirm SQLite/Object Storage backups have a recent successful
  run before any future resize or migration.

## If forced to 2 OCPU / 12 GB

1. Keep the single-node architecture.
2. Lower Prometheus retention before touching app quotas.
3. Remove or pause optional resident tools before user workloads.
4. Keep user app defaults conservative: 100m request / 500m limit,
   256Mi request / 512Mi limit.
5. Limit stateful/PVC apps first, because they add backup and recovery
   responsibility even when CPU/RAM usage is low.

## Capacity watchpoints

- Memory at 75% of 12 GB: warning.
- Memory at 90% of 12 GB: critical.
- CPU sustained above 75% of 2 OCPU target: warning.
- CPU sustained above 90% of 2 OCPU target: critical.
- `/data` above 75%: warning.
- `/data` above 85%: critical.

