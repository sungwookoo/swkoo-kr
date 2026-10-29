"""Isolated kubelet eviction test at a reduced 32Mi threshold. Plans by default."""
import argparse
import json
import re
import subprocess
import time

NAMESPACE = 'user-swkoo-storage-limit-validation'


def kube(*args, document=None):
    return subprocess.check_output(['kubectl', *args], input=json.dumps(document) if document is not None else None, text=True).strip()


def pod(name, megabytes):
    program = f"const fs=require('fs'); const fd=fs.openSync('/tmp/validation.bin','w'); const b=Buffer.alloc(1024*1024,1); for(let i=0;i<{megabytes};i++) fs.writeSync(fd,b); fs.fsyncSync(fd); fs.closeSync(fd); setInterval(()=>{{}},1000);"
    return {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': name, 'namespace': NAMESPACE}, 'spec': {
        'automountServiceAccountToken': False, 'restartPolicy': 'Never',
        'securityContext': {'seccompProfile': {'type': 'RuntimeDefault'}},
        'containers': [{'name': name, 'image': None, 'command': ['node', '-e', program],
                        'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                        'resources': {'requests': {'cpu': '100m', 'memory': '64Mi', 'ephemeral-storage': '8Mi'},
                                      'limits': {'cpu': '500m', 'memory': '128Mi', 'ephemeral-storage': '32Mi'}}}]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'ghcr\.io/sw-koo/nextjs-sample@sha256:[a-f0-9]{64}', args.image):
        parser.error('Only the explicitly approved test-account image is allowed')
    print(json.dumps({'execute': args.execute, 'namespace': NAMESPACE, 'writesMiB': 65, 'ephemeralLimitMiB': 32}), flush=True)
    if not args.execute: return
    if kube('get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'name'):
        raise RuntimeError('Refusing an existing namespace')
    namespace = json.loads(kube('create', '-f', '-', '-o', 'json', document={
        'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': NAMESPACE, 'labels': {'pod-security.kubernetes.io/enforce': 'restricted'}}}))
    uid = namespace['metadata']['uid']
    try:
        for name, size in [('exhaust', 64), ('control', 1)]:
            fixture = pod(name, size); fixture['spec']['containers'][0]['image'] = args.image
            kube('create', '-f', '-', document=fixture)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            pods = json.loads(kube('get', 'pods', '-n', NAMESPACE, '-o', 'json'))['items']
            states = {item['metadata']['name']: item.get('status', {}) for item in pods}
            failed = states.get('exhaust', {})
            if failed.get('reason') == 'Evicted':
                message = failed.get('message', '')
                print(json.dumps({'observedEviction': message}), flush=True)
                if not re.search(r'ephemeral[- ](?:local )?storage', message, re.I) or 'limit' not in message.lower(): raise RuntimeError('Wrong eviction reason')
                if states.get('control', {}).get('phase') != 'Running': raise RuntimeError('Control app was affected')
                print(json.dumps({'ok': True, 'reason': failed['reason'], 'message': failed['message'], 'control': 'Running'}), flush=True)
                break
            time.sleep(5)
        else: raise RuntimeError('Ephemeral limit eviction was not observed within 300s')
    finally:
        current = json.loads(kube('get', 'namespace', NAMESPACE, '-o', 'json'))
        if current['metadata']['uid'] != uid: raise RuntimeError('Namespace identity changed; refusing cleanup')
        kube('delete', 'namespace', NAMESPACE, '--wait=true', '--timeout=120s')
        print(json.dumps({'cleaned': not bool(kube('get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'name'))}), flush=True)


if __name__ == '__main__': main()
