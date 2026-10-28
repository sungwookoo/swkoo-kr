"""Three isolated Next.js/SQLite apps: bounded ramp + 15 minute mixed load.

Default is a plan only. --execute creates ONLY user-swkoo-load-a/b/c.
No ingress, public traffic, user repository writes, or production DB access.
"""
import argparse
import json
from pathlib import Path
import re
import signal
import subprocess
import time

NAMESPACES = ['user-swkoo-load-' + suffix for suffix in ['a', 'b', 'c']]
CLIENT = r"""
(async()=>{const results=[];for(const[rps,seconds]of[[1,15],[3,15],[5,15],[2,900]]){
 const times=[],types={ssr:0,read:0,write:0},pending=new Set();let errors=0,skipped=0;const began=performance.now();
 for(let i=0;i<rps*seconds;i++){
  const delay=began+i*1000/rps-performance.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));
  if(pending.size>=2){skipped++;continue}const at=performance.now(),kind=i%10===0?'write':i%2===0?'ssr':'read';
  const task=(async()=>{try{
   const response=await fetch('http://127.0.0.1:3000'+(kind==='ssr'?'/':'/api/records'),
    {signal:AbortSignal.timeout(5000),...(kind==='write'?{method:'POST',headers:{'Content-Type':'application/json','x-validation-key':'isolated-load-fixture'},body:JSON.stringify({value:'load-'+Date.now()})}:{})});
   if(!response.ok)throw Error('HTTP '+response.status);
   if(kind==='ssr'){if(!(await response.text()).includes('SQLite'))throw Error('SSR content')}
   else {const body=await response.json();if(kind==='read'&&(!Array.isArray(body.records)||body.count<0))throw Error('API content')}
   types[kind]++;times.push(performance.now()-at);
  }catch{errors++}})();pending.add(task);task.finally(()=>pending.delete(task));
 }
 await Promise.all(pending);times.sort((a,b)=>a-b);results.push({rps,seconds,requests:times.length,types,errors,skipped,p95Ms:times[Math.ceil(times.length*.95)-1]??null});
 if(errors||skipped)throw Error('Request failures: '+JSON.stringify(results));
}console.log(JSON.stringify(results));})().catch(e=>{console.error(e.message);process.exitCode=1});
"""


def kube(*args, data=None):
    return subprocess.check_output(['kubectl', *args], input=data, text=True).strip()


def apply(data):
    kube('apply', '-f', '-', data=json.dumps(data))


def metrics(namespace):
    result = subprocess.run(['kubectl', 'top', 'pods', '-n', namespace, '--containers', '--no-headers'], capture_output=True, text=True)
    if result.returncode:
        if 'metrics not available yet' in result.stderr:
            return []
        raise RuntimeError('Resource metrics lookup failed: ' + result.stderr.strip())
    return result.stdout.splitlines()


def stop(signum, frame):
    raise KeyboardInterrupt('Validation interrupted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures')
    parser.add_argument('image')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--output', default='/tmp/swkoo-app-capacity-result.json')
    args = parser.parse_args()
    if not re.fullmatch(r'ghcr\.io/sw-koo/nextjs-sample@sha256:[a-f0-9]{64}', args.image):
        parser.error('Only the owner-approved disposable fixture digest is allowed')
    fixtures = json.loads(Path(args.fixtures).read_text())
    for suffix, ns in zip(['a', 'b', 'c'], NAMESPACES):
        if fixtures[suffix]['namespace.yaml']['metadata']['name'] != ns:
            parser.error('Unexpected fixture namespace')
        for name in ['resource-quota.yaml', 'limit-range.yaml', 'network-policy.yaml', 'probe/pvc.yaml', 'probe/deployment.yaml']:
            if fixtures[suffix][name]['metadata'].get('namespace') != ns:
                parser.error('Resource outside the validation namespace')
    if not args.execute:
        print(json.dumps({'execute': False, 'namespaces': NAMESPACES, 'image': args.image, 'durationSeconds': 945}))
        return
    for ns in NAMESPACES:
        assert not kube('get', 'namespace', ns, '--ignore-not-found'), 'Refusing existing namespace: ' + ns
    assert not Path(args.output).exists(), 'Refusing existing result file'
    assert Path(args.output).parent.is_dir(), 'Result directory must exist'
    signal.signal(signal.SIGTERM, stop)
    created, processes, handles, samples = [], [], [], []
    try:
        for suffix, ns in zip(['a', 'b', 'c'], NAMESPACES):
            files = fixtures[suffix]
            for name in ['namespace.yaml', 'resource-quota.yaml', 'limit-range.yaml', 'network-policy.yaml', 'probe/pvc.yaml']:
                if name == 'namespace.yaml':
                    kube('create', '-f', '-', data=json.dumps(files[name]))
                    created.append(ns)
                else:
                    apply(files[name])
            apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'probe-env', 'namespace': ns},
                   'stringData': {'VALIDATION_WRITE_KEY': 'isolated-load-fixture'}})
            dep = files['probe/deployment.yaml']
            for container in dep['spec']['template']['spec']['initContainers'] + dep['spec']['template']['spec']['containers']:
                container['image'] = args.image
            dep['spec']['template']['spec']['containers'].append({
                'name': 'client', 'image': 'node:24.18.1-alpine', 'command': ['node', '-e', 'setInterval(()=>{},10000)'],
                'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                'resources': {'requests': {'cpu': '25m', 'memory': '64Mi'}, 'limits': {'cpu': '100m', 'memory': '128Mi'}}})
            apply(dep)
            print(kube('rollout', 'status', 'deployment/probe', '-n', ns, '--timeout=180s'), flush=True)
        metric_deadline = time.monotonic() + 90
        while not all(any(row.split()[1] == 'probe' for row in metrics(ns)) for ns in NAMESPACES):
            assert time.monotonic() < metric_deadline, 'Resource metrics did not become ready'
            time.sleep(3)
        for ns in NAMESPACES:
            handle = open(str(args.output) + '.' + ns + '.log', 'x')
            handles.append(handle)
            processes.append(subprocess.Popen(['kubectl', 'exec', '-n', ns, 'deployment/probe', '-c', 'client', '--', 'node', '-e', CLIENT], stdout=handle, stderr=subprocess.STDOUT))
        began = time.monotonic()
        while any(process.poll() is None for process in processes):
            assert time.monotonic() - began < 1020, 'Load deadline exceeded'
            assert all(process.poll() in [None, 0] for process in processes), 'Load client failed'
            node = kube('top', 'node', '--no-headers').split()
            assert int(node[2].rstrip('%')) < 80 and int(node[4].rstrip('%')) < 75, 'Node safety threshold reached'
            sample = {'elapsedSeconds': round(time.monotonic() - began), 'node': node, 'apps': {}}
            for ns in NAMESPACES:
                rows = metrics(ns)
                assert any(row.split()[1] == 'probe' for row in rows), 'Resource metrics unavailable during load'
                for row in rows:
                    fields = row.split()
                    if fields[1] == 'probe':
                        assert fields[3].endswith('Mi') and int(fields[3][:-2]) < 460, 'Fixture memory safety threshold reached'
                        sample['apps'][ns] = {'cpu': fields[2], 'memory': fields[3]}
                pods = json.loads(kube('get', 'pods', '-n', ns, '-o', 'json'))
                assert all(c.get('restartCount', 0) == 0 for p in pods['items'] for c in p.get('status', {}).get('containerStatuses', [])), 'Fixture restarted'
            samples.append(sample)
            print(json.dumps(sample), flush=True)
            time.sleep(30)
        results = {}
        for ns, process, handle in zip(NAMESPACES, processes, handles):
            handle.close()
            assert process.returncode == 0, 'Client failed: ' + ns
            results[ns] = json.loads(Path(str(args.output) + '.' + ns + '.log').read_text())
            assert sum(ns in sample['apps'] for sample in samples) >= 20, 'Insufficient resource samples'
        Path(args.output).write_text(json.dumps({'image': args.image, 'results': results, 'samples': samples}))
        print(json.dumps({'completed': True, 'apps': len(results), 'output': args.output}), flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
        for handle in handles:
            handle.close()
        for ns in reversed(created):
            kube('delete', 'namespace', ns, '--wait=true', '--timeout=90s')
        print('Isolated load resources removed', flush=True)


if __name__ == '__main__':
    main()
