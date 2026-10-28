"""Bounded SQLite fixture benchmark. Never targets a production app or public URL."""
import json
from pathlib import Path
import re
import subprocess
import sys

NS = 'user-swkoo-validation-capacity'


def kube(*args, data=None):
    return subprocess.check_output(['kubectl', *args], input=data, text=True).strip()


APP = r"""
const fs=require('fs'),{PrismaClient}=require('@prisma/client'),p=new PrismaClient();
function stats(){let c={}; for(const l of fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').trim().split('\n')){const[k,v]=l.split(' ');c[k]=Number(v)}
return {cpu:c,memory:Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8')),peak:Number(fs.readFileSync('/sys/fs/cgroup/memory.peak','utf8')),events:fs.readFileSync('/sys/fs/cgroup/memory.events','utf8')}}
require('http').createServer(async(q,r)=>{try{r.setHeader('Content-Type','application/json');r.end(JSON.stringify(q.url==='/__stats'?stats():await p.project.findMany({take:50,orderBy:{key:'asc'}})))}catch{r.statusCode=500;r.end('{}')}}).listen(3000,'0.0.0.0');
"""
CLIENT = r"""
(async()=>{const out=[];for(const rps of [5,10,20]){
 const start=await(await fetch('http://127.0.0.1:3000/__stats')).json(), times=[], pending=new Set();let errors=0,skipped=0;
 const began=performance.now(),duration=15000;
 for(let i=0;i<rps*duration/1000;i++){
  const delay=began+i*1000/rps-performance.now();if(delay>0)await new Promise(r=>setTimeout(r,delay));
  if(pending.size>=8){skipped++;continue}const at=performance.now();
  const task=(async()=>{try{const r=await fetch('http://127.0.0.1:3000',{signal:AbortSignal.timeout(5000)});const rows=await r.json();if(!r.ok||rows.length!==50)throw Error('response');times.push(performance.now()-at)}catch{errors++}})();
  pending.add(task);task.finally(()=>pending.delete(task));
 }
 await Promise.all(pending);const elapsed=performance.now()-began,end=await(await fetch('http://127.0.0.1:3000/__stats')).json();times.sort((a,b)=>a-b);
 out.push({targetRps:rps,requests:times.length,errors,skipped,p95Ms:times[Math.min(times.length-1,Math.ceil(times.length*.95)-1)],cpuCores:(end.cpu.usage_usec-start.cpu.usage_usec)/(elapsed*1000),throttledPeriods:end.cpu.nr_throttled-start.cpu.nr_throttled,memoryMiB:end.memory/1048576,peakMiB:end.peak/1048576,memoryEvents:end.events});
 }console.log(JSON.stringify(out));if(out.some(x=>x.errors||x.skipped))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1});
"""

fixtures = json.loads(Path(sys.argv[1]).read_text())['capacity']
image = sys.argv[2]
assert re.fullmatch(r'ghcr.io/sungwookoo/sprintflow:latest@sha256:[a-f0-9]{64}', image)
assert fixtures['namespace.yaml']['metadata']['name'] == NS
assert not kube('get', 'namespace', NS, '--ignore-not-found'), 'Refusing existing namespace'
created = False
try:
    for name in ['namespace.yaml', 'resource-quota.yaml', 'limit-range.yaml', 'network-policy.yaml', 'probe/pvc.yaml']:
        kube('apply', '-f', '-', data=json.dumps(fixtures[name]))
        if name == 'namespace.yaml':
            created = True
    dep = fixtures['probe/deployment.yaml']
    for c in dep['spec']['template']['spec']['initContainers']:
        c['image'] = image
    app = dep['spec']['template']['spec']['containers'][0]
    app.update(image=image, command=['node', '-e', APP], readinessProbe={'httpGet': {'path': '/', 'port': 3000}, 'periodSeconds': 2})
    dep['spec']['template']['spec']['containers'].append({
        'name': 'client', 'image': 'node:24.18.1-alpine', 'command': ['node', '-e', 'setInterval(()=>{},10000)'],
        'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
        'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '200m', 'memory': '128Mi'}},
    })
    kube('apply', '-f', '-', data=json.dumps(dep))
    print(kube('rollout', 'status', 'deployment/probe', '-n', NS, '--timeout=90s'), flush=True)
    seed = "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.createMany({data:Array.from({length:100},(_,i)=>({key:'P'+i,name:'Capacity '+i,summary:'Fixture only',leadName:'Validation'}))}).then(()=>p.$disconnect()).catch(()=>process.exit(1))"
    kube('exec', '-n', NS, 'deployment/probe', '-c', 'probe', '--', 'node', '-e', seed)
    result = kube('exec', '-n', NS, 'deployment/probe', '-c', 'client', '--', 'node', '-e', CLIENT)
    json.loads(result)
    print(result, flush=True)
finally:
    if created:
        kube('delete', 'namespace', NS, '--wait=true', '--timeout=90s')
        print('Capacity fixture removed', flush=True)
