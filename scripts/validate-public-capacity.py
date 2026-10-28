"""Windows operator -> public HTTPS, 3 disposable apps, no source repository writes.

Plans by default. Uses the existing swkoo-oci SSH connection, standard TLS
verification, bounded requests, node safety checks and owned-namespace cleanup.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
NAMESPACES = ['user-swkoo-load-' + suffix for suffix in ['a', 'b', 'c']]


def kube(*args, data=None):
    # Only fixed operator-authored arguments, never interpolated repo/user input.
    return subprocess.check_output(['ssh', '-o', 'ServerAliveInterval=30', 'swkoo-oci', 'sudo', 'kubectl', *args],
                                   input=data, text=True, timeout=240).strip()


def validate(fixtures, image):
    if not re.fullmatch(r'ghcr\.io/sw-koo/nextjs-sample@sha256:[a-f0-9]{64}', image):
        raise ValueError('Only the explicitly approved fixture digest is allowed')
    for suffix, namespace in zip(['a','b','c'], NAMESPACES):
        files = fixtures[suffix]
        if files['namespace.yaml']['metadata']['name'] != namespace:
            raise ValueError('Unexpected namespace')
        for name, kind in {'resource-quota.yaml':'ResourceQuota','limit-range.yaml':'LimitRange','network-policy.yaml':'NetworkPolicy',
                           'probe/pvc.yaml':'PersistentVolumeClaim','probe/service.yaml':'Service','probe/deployment.yaml':'Deployment','probe/ingress.yaml':'Ingress'}.items():
            if files[name].get('kind') != kind: raise ValueError('Unexpected resource kind')
        for name, resource in files.items():
            if resource.get('kind') in ['Namespace', 'Kustomization']: continue
            if resource.get('metadata', {}).get('namespace') != namespace:
                raise ValueError('Resource outside validation namespace')
        ingress = files['probe/ingress.yaml']['spec']
        host = f'swkoo-load-{suffix}.apps.swkoo.kr'
        if ingress['rules'][0]['host'] != host or ingress['tls'][0]['hosts'] != [host]:
            raise ValueError('Unexpected public host')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures'); parser.add_argument('image')
    parser.add_argument('--seconds', type=int, default=3600, choices=range(60, 3601), metavar='60..3600')
    parser.add_argument('--output-dir', required=True); parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    fixtures = json.loads(Path(args.fixtures).read_text(encoding='utf-8-sig')); validate(fixtures, args.image)
    if not args.execute:
        print(json.dumps({'execute': False, 'namespaces': NAMESPACES, 'steadySeconds': args.seconds, 'externalHttps': True})); return
    output = Path(args.output_dir); output.mkdir(mode=0o700)  # Refuse an existing result path.
    report = {'startedAt': datetime.now(timezone.utc).isoformat(), 'image': args.image, 'steadySeconds': args.seconds, 'status': 'failed'}
    owned, samples, process, client_log = {}, [], None, None
    key = secrets.token_hex(24)
    def stop(signum, frame): raise KeyboardInterrupt('Operator interrupted')
    signal.signal(signal.SIGTERM, stop)
    try:
        node = json.loads(kube('get', 'nodes', '-o', 'json'))['items']
        assert len(node) == 1 and node[0]['metadata']['name'] == 'instance-20250321-1004', 'Unexpected cluster'
        assert any(c['type'] == 'Ready' and c['status'] == 'True' for c in node[0]['status']['conditions']), 'Node not ready'
        free = int(subprocess.check_output(['ssh','swkoo-oci','df -B1 --output=avail /var/lib/rancher/k3s/storage'], text=True).splitlines()[-1])
        assert free > 8 * 1024 ** 3, 'Insufficient disk safety margin'
        for ns in NAMESPACES: assert not kube('get','namespace',ns,'--ignore-not-found','-o','name'), 'Existing validation namespace'
        for suffix, ns in zip(['a','b','c'], NAMESPACES):
            files = fixtures[suffix]
            created = json.loads(kube('create','-f','-','-o','json',data=json.dumps(files['namespace.yaml'])))
            owned[ns] = created['metadata']['uid']
            for name in ['resource-quota.yaml','limit-range.yaml','network-policy.yaml','probe/pvc.yaml','probe/service.yaml']:
                kube('create','-f','-',data=json.dumps(files[name]))
            kube('create','-f','-',data=json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'name':'probe-env','namespace':ns},'stringData':{'VALIDATION_WRITE_KEY':key}}))
            dep = files['probe/deployment.yaml']
            for c in dep['spec']['template']['spec']['containers'] + dep['spec']['template']['spec']['initContainers']: c['image'] = args.image
            kube('create','-f','-',data=json.dumps(dep)); kube('rollout','status','deployment/probe','-n',ns,'--timeout=180s')
            kube('create','-f','-',data=json.dumps(files['probe/ingress.yaml']))
            deadline = time.monotonic() + 60
            while not kube('get','certificate','probe-tls','-n',ns,'--ignore-not-found','-o','name'):
                assert time.monotonic() < deadline, 'Certificate was not created'
                time.sleep(3)
            kube('wait','--for=condition=Ready','certificate/probe-tls','-n',ns,'--timeout=360s')
            url = f'https://swkoo-load-{suffix}.apps.swkoo.kr/api/records'
            deadline = time.monotonic() + 90
            while True:
                try:
                    with urllib.request.urlopen(url, timeout=15) as response:
                        assert json.load(response)['count'] == 0, 'Expected empty disposable database'
                    break
                except Exception:
                    if time.monotonic() >= deadline: raise
                    time.sleep(3)  # Certificate Ready can precede ingress TLS reload.
        deadline = time.monotonic() + 90
        while True:
            ready = all(subprocess.run(['ssh','swkoo-oci','sudo','kubectl','top','pod','-n',ns,'--no-headers'],
                                       capture_output=True,text=True,timeout=30).returncode == 0 for ns in NAMESPACES)
            if ready: break
            assert time.monotonic() < deadline, 'Resource metrics unavailable'
            time.sleep(3)
        client_log = (output / 'client.log').open('x')
        process = subprocess.Popen(['node', str(ROOT / 'public-capacity-client.cjs'), str(args.seconds), str(output / 'clients.json')],
                                   env={**os.environ, 'FIXTURE_WRITE_KEY':key}, stdout=client_log, stderr=subprocess.STDOUT)
        began = time.monotonic()
        while process.poll() is None:
            assert time.monotonic() - began < args.seconds + 150, 'Load deadline exceeded'
            node_usage = kube('top','node','--no-headers').split()
            assert int(node_usage[2].rstrip('%')) < 80 and int(node_usage[4].rstrip('%')) < 75, 'Node safety threshold'
            sample = {'elapsedSeconds':round(time.monotonic()-began),'node':node_usage,'apps':{}}
            for ns in NAMESPACES:
                pods = json.loads(kube('get','pods','-n',ns,'-o','json'))['items']
                assert all(c.get('restartCount',0) == 0 for p in pods for c in p.get('status',{}).get('containerStatuses',[])), 'Fixture restarted'
                fields = kube('top','pod','-n',ns,'--no-headers').split()
                assert fields[2].endswith('Mi') and int(fields[2][:-2]) < 460, 'Memory safety threshold'
                sample['apps'][ns] = {'cpu':fields[1],'memory':fields[2]}
            samples.append(sample)
            (output/'samples.json').write_text(json.dumps(samples))
            print(json.dumps(sample),flush=True); time.sleep(30)
        assert process.returncode == 0, 'Public HTTPS client failed'
        for suffix in ['a','b','c']:
            with urllib.request.urlopen(f'https://swkoo-load-{suffix}.apps.swkoo.kr/api/records',timeout=15) as response:
                expected = 15 + (args.seconds * 2 + 9) // 10
                assert json.load(response)['count'] == expected, 'SQLite write count mismatch'
        report['status'] = 'passed'
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error)
    finally:
        if process and process.poll() is None: process.terminate(); process.wait(timeout=15)
        if client_log: client_log.close()
        cleanup = []
        for ns, uid in reversed(list(owned.items())):
            try:
                current = json.loads(kube('get','namespace',ns,'-o','json'))
                assert current['metadata']['uid'] == uid, 'Namespace ownership changed'
                kube('delete','namespace',ns,'--wait=true','--timeout=120s')
            except Exception: cleanup.append(ns)
        report.update(finishedAt=datetime.now(timezone.utc).isoformat(), remainingNamespaces=cleanup)
        if cleanup: report['status'] = 'failed'
        (output/'summary.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report),flush=True)
    if report['status'] != 'passed': raise SystemExit(1)


if __name__ == '__main__': main()
