# OCI Always Free capacity response

Updated: 2026-06-15

Oracle's Always Free documentation currently lists Ampere A1 as 2 OCPU
and 12 GB memory total. swkoo.kr may still run on a legacy 4 OCPU / 24 GB
shape, but operating assumptions should be based on the smaller target.

## Non-disruptive actions already taken

- Daily `resource-report.sh` grades CPU/RAM against a 2 OCPU / 12 GB
  target while still printing the current host capacity.
- Public copy no longer promises 4 OCPU / 24 GB as the durable baseline.
- Business/readiness docs call out Free Tier capacity drift as an
  operating risk.

## Operating policy

- Do not resize, reboot, or stop the instance just to chase documentation
  changes. First confirm billing/account behavior.
- Treat 2 OCPU / 12 GB as the planning target for user capacity and
  alert thresholds.
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
4. Keep user app defaults conservative: 50m request / 100m limit,
   64Mi request / 128Mi limit.
5. Limit stateful/PVC apps first, because they add backup and recovery
   responsibility even when CPU/RAM usage is low.

## Capacity watchpoints

- Memory at 75% of 12 GB: warning.
- Memory at 90% of 12 GB: critical.
- CPU sustained above 75% of 2 OCPU target: warning.
- CPU sustained above 90% of 2 OCPU target: critical.
- `/data` above 75%: warning.
- `/data` above 85%: critical.

