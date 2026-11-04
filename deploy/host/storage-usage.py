#!/usr/bin/env python3
"""Publish quota counters only. No app file contents, execution, or quota writes."""
from datetime import datetime, timezone
import json
import subprocess
import sys


def kube(*args, data=None):
    return json.loads(subprocess.check_output(
        ['/usr/local/bin/k3s', 'kubectl', *args, '-o', 'json'], input=data, timeout=15))


def measure(path):
    sys.path.insert(0, '/usr/local/lib/swkoo-storage')
    import quota
    target = quota.checked_path(path)
    identifier = quota.project_id(target)
    if quota.attributes(target)[3] != identifier:
        raise ValueError('Project ownership mismatch')
    actual = quota.get_quota(identifier)
    if actual.bhard * 1024 != quota.HARD_BYTES or actual.ihard != quota.HARD_INODES:
        raise ValueError('Expected enforced quota missing')
    return {'usedBytes': actual.space, 'limitBytes': actual.bhard * 1024,
            'usedInodes': actual.inodes, 'limitInodes': actual.ihard}


def collect(volumes, pods, reader):
    rows = []
    for volume in volumes:
        spec = volume.get('spec', {})
        claim = spec.get('claimRef', {})
        namespace, name = claim.get('namespace', ''), claim.get('name', '')
        if not namespace.startswith('user-') or volume.get('status', {}).get('phase') != 'Bound':
            continue
        path = spec.get('local', spec.get('hostPath', {})).get('path', '')
        expected = f"/var/lib/rancher/k3s/storage/{volume['metadata']['name']}_{namespace}_{name}"
        if path != expected or not claim.get('uid'):
            continue
        try:
            usage = reader(path)
        except (OSError, ValueError, RuntimeError):
            continue  # Missing record means unknown, never zero usage.
        pod_ids = [p['metadata']['uid'] for p in pods
                   if p['metadata'].get('namespace') == namespace and
                   not p['metadata'].get('deletionTimestamp') and
                   any(v.get('persistentVolumeClaim', {}).get('claimName') == name
                       for v in p.get('spec', {}).get('volumes', []))]
        rows.append({'namespace': namespace, 'claimName': name, 'claimUid': claim['uid'],
                     'podUids': pod_ids, **usage})
    return rows


def main():
    # Also confirms the expected filesystem is mounted and quota is active.
    subprocess.check_output(['/usr/local/sbin/swkoo-storage-preflight'], timeout=10)
    volumes = kube('get', 'pv')['items']
    pods = kube('get', 'pods', '--all-namespaces')['items']
    rows = collect(volumes, pods, measure)
    payload = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'volumes': rows}
    config = {'apiVersion': 'v1', 'kind': 'ConfigMap',
              'metadata': {'name': 'swkoo-storage-usage', 'namespace': 'swkoo'},
              'data': {'usage.json': json.dumps(payload)}}
    kube('apply', '-f', '-', data=json.dumps(config).encode())
    print(json.dumps({'volumesMeasured': len(rows), 'checkedAt': payload['checkedAt']}))


if __name__ == '__main__':
    main()
