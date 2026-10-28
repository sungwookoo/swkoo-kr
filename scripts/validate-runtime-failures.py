"""Bounded failures in an isolated namespace; never mutates user apps or repos.

Run on the OCI host with sudo. Pass the owner-controlled SprintFlow image digest
and an output JSON path. Capacity fixture cannot preempt existing workloads.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import time

NS = 'user-swkoo-failure-validation'
PRIORITY = 'swkoo-failure-validation'


def kube(*args, data=None):
    return subprocess.check_output(['kubectl', *args], input=data, text=True).strip()


def apply(data):
    kube('apply', '-f', '-', data=json.dumps(data))


image, output = sys.argv[1:3]
assert re.fullmatch(r'ghcr.io/sungwookoo/sprintflow:latest@sha256:[a-f0-9]{64}', image)
assert not kube('get', 'namespace', NS, '--ignore-not-found'), 'Refusing existing namespace'
assert not kube('get', 'priorityclass', PRIORITY, '--ignore-not-found'), 'Refusing existing priority class'
results = {}
created = False
priority_created = False
try:
    apply({'apiVersion': 'scheduling.k8s.io/v1', 'kind': 'PriorityClass', 'metadata': {'name': PRIORITY},
           'value': -1000, 'globalDefault': False, 'preemptionPolicy': 'Never'})
    priority_created = True
    apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': NS, 'labels': {
        'pod-security.kubernetes.io/enforce': 'restricted'}}})
    created = True
    for case in ['oom', 'capacity', 'database']:
        code = "Buffer.alloc(128*1024*1024,1);setInterval(()=>{},1000)"
        resources = {'requests': {'cpu': '10m', 'memory': '32Mi'}, 'limits': {'cpu': '100m', 'memory': '64Mi'}}
        if case == 'capacity':
            code = 'setInterval(()=>{},1000)'
            resources = {'requests': {'cpu': '4', 'memory': '32Mi'}, 'limits': {'cpu': '4', 'memory': '64Mi'}}
        if case == 'database':
            code = "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.$connect().then(()=>process.exit(0)).catch(()=>process.exit(1))"
            resources['limits']['memory'] = '128Mi'
        dep = {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'sprintflow', 'namespace': NS},
               'spec': {'replicas': 1, 'selector': {'matchLabels': {'app': 'sprintflow'}},
                        'template': {'metadata': {'labels': {'app': 'sprintflow'}}, 'spec': {
                            'automountServiceAccountToken': False, 'priorityClassName': PRIORITY,
                            'securityContext': {'runAsNonRoot': True, 'runAsUser': 1001, 'seccompProfile': {'type': 'RuntimeDefault'}},
                            'containers': [{'name': 'sprintflow', 'image': image, 'command': ['node', '-e', code],
                                            'env': [{'name': 'DATABASE_URL', 'value': 'file:/nonexistent-dir/validation.db'}],
                                            'resources': resources, 'securityContext': {
                                                'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}}}]}}}}
        apply(dep)
        for attempt in range(90):
            pods = json.loads(kube('get', 'pods', '-n', NS, '-l', 'app=sprintflow', '-o', 'json'))
            statuses = [s for p in pods['items'] for s in p.get('status', {}).get('containerStatuses', [])]
            if case == 'capacity':
                ready = any(c.get('reason') == 'Unschedulable' and 'Insufficient cpu' in c.get('message', '')
                            for p in pods['items'] for c in p.get('status', {}).get('conditions', []))
            else:
                reason = 'OOMKilled' if case == 'oom' else 'Error'
                ready = any(s.get('state', {}).get('terminated', {}).get('reason') == reason
                            or (s.get('state', {}).get('waiting') and
                                s.get('lastState', {}).get('terminated', {}).get('reason') == reason)
                            for s in statuses)
            if ready:
                results[case] = {'pods': pods, 'deployment': json.loads(kube('get', 'deployment', 'sprintflow', '-n', NS, '-o', 'json'))}
                print(f'{case}: expected Kubernetes failure observed', flush=True)
                break
            time.sleep(2)
        else:
            raise RuntimeError(f'{case}: expected failure not observed')
        kube('delete', 'deployment', 'sprintflow', '-n', NS, '--wait=true', '--timeout=60s')
        if kube('get', 'pod', '-l', 'app=sprintflow', '-n', NS, '-o', 'name'):
            kube('wait', '--for=delete', 'pod', '-l', 'app=sprintflow', '-n', NS, '--timeout=60s')
    Path(output).write_text(json.dumps(results))
finally:
    if created:
        kube('delete', 'namespace', NS, '--wait=true', '--timeout=90s')
        print('Failure fixtures removed', flush=True)
    if priority_created:
        kube('delete', 'priorityclass', PRIORITY, '--wait=true')
