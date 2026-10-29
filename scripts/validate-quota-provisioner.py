"""Full PVC/helper/consumer rehearsal on an isolated loop filesystem."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

PROVIDER, CONSUMER, CLASS = 'swkoo-storage-validation', 'user-swkoo-quota-validation', 'swkoo-quota-validation'


def kube(*args, document=None):
    result = subprocess.run(['kubectl', *args], input=json.dumps(document) if document is not None else None, capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def wait(predicate, timeout=240):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if predicate(): return
        time.sleep(2)
    raise RuntimeError('Validation did not reach the required state')


def copy_pull_secret(namespace):
    # Keep credentials entirely inside the cluster process, never in output
    # or rendered fixtures. The namespace is freshly created by this test.
    source=json.loads(kube('get','secret','ocir-credentials','-n','swkoo','-o','json'))
    secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':'ocir-credentials','namespace':namespace},'type':source['type'],'data':source['data']}
    kube('create','-f','-',document=secret)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifests', type=Path, required=True)
    parser.add_argument('--execute', action='store_true')
    args=parser.parse_args()
    resources=json.loads(args.manifests.read_text())
    helper=next(item['data']['helperPod.yaml'] for item in resources if item['kind']=='ConfigMap')
    consumer_image=re.search(r'^\s*image:\s*(\S+)',helper,re.MULTILINE).group(1)
    if any(item.get('metadata',{}).get('namespace') not in [None,'swkoo-storage'] for item in resources): raise RuntimeError('Unexpected source namespace')
    print(json.dumps({'execute':args.execute,'namespaces':[PROVIDER,CONSUMER],'isolatedImageGiB':3}),flush=True)
    if not args.execute: return
    for namespace in [PROVIDER,CONSUMER]:
        if kube('get','namespace',namespace,'--ignore-not-found','-o','name'): raise RuntimeError('Refusing existing validation namespace')
    if kube('get','storageclass',CLASS,'--ignore-not-found','-o','name'): raise RuntimeError('Refusing existing storage class')
    lab=Path(tempfile.mkdtemp(prefix='swkoo-quota-pvc-lab-',dir='/data')); image=lab/'isolated.img'; mount=lab/'mount'; mount.mkdir()
    mounted=False; created=[]; ready_to_remove=False
    try:
        subprocess.run(['truncate','-s','3G',str(image)],check=True)
        subprocess.run(['mkfs.ext4','-q','-F','-O','project,quota',str(image)],check=True)
        subprocess.run(['tune2fs','-Q','prjquota',str(image)],check=True,capture_output=True)
        subprocess.run(['mount','-o','loop,prjquota',str(image),str(mount)],check=True); mounted=True
        storage=mount/'storage'; storage.mkdir(mode=0o700)
        for source in resources:
            item=copy.deepcopy(source); kind=item['kind']; meta=item['metadata']
            if kind=='Namespace': meta['name']=PROVIDER
            elif kind in ['ClusterRole','ClusterRoleBinding']: meta['name']=CLASS
            elif kind=='StorageClass': meta['name']=CLASS; item['provisioner']='swkoo.kr/user-quota-validation'
            else: meta['namespace']=PROVIDER
            if kind=='ClusterRoleBinding': item['roleRef']['name']=CLASS
            for subject in item.get('subjects',[]): subject['namespace']=PROVIDER
            if kind=='Deployment':
                command=item['spec']['template']['spec']['containers'][0]['command']
                command[command.index('--provisioner-name')+1]='swkoo.kr/user-quota-validation'
            if kind=='ConfigMap':
                item['data']['config.json']=json.dumps({'nodePathMap':[{'node':'DEFAULT_PATH_FOR_NON_LISTED_NODES','paths':[str(storage)]}]})
                # Override only the helper's data mount target; its host source
                # is the isolated filesystem chosen by this test provisioner.
                text=item['data']['helperPod.yaml']
                text=text.replace('      volumeMounts:\n','      volumeMounts:\n        - name: data\n          mountPath: /var/lib/rancher/k3s/storage\n')
                item['data']['helperPod.yaml']=text
            result=json.loads(kube('create','-f','-','-o','json',document=item))
            created.append((kind,meta['name'],result['metadata']['uid']))
            if kind=='Namespace': copy_pull_secret(PROVIDER)
        kube('rollout','status','deployment/swkoo-user-storage','-n',PROVIDER,'--timeout=120s')
        namespace=json.loads(kube('create','-f','-','-o','json',document={'apiVersion':'v1','kind':'Namespace','metadata':{'name':CONSUMER,'labels':{'pod-security.kubernetes.io/enforce':'restricted'}}}))
        created.append(('Namespace',CONSUMER,namespace['metadata']['uid']))
        copy_pull_secret(CONSUMER)
        for name in ['a','b']:
            kube('create','-f','-',document={'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':{'name':name,'namespace':CONSUMER},'spec':{'storageClassName':CLASS,'accessModes':['ReadWriteOnce'],'resources':{'requests':{'storage':'1Gi'}}}})
        def pod(name,claim,program):
            return {'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':CONSUMER},'spec':{
                'restartPolicy':'Never','automountServiceAccountToken':False,
                'imagePullSecrets':[{'name':'ocir-credentials'}],
                'securityContext':{'fsGroup':1000,'seccompProfile':{'type':'Localhost','localhostProfile':'swkoo-user-storage-v1.json'}},
                'containers':[{'name':'app','image':consumer_image,'command':['python3','-c',program],
                    'env':[{'name':'PYTHONDONTWRITEBYTECODE','value':'1'}],
                    'resources':{'requests':{'cpu':'100m','memory':'64Mi'},'limits':{'cpu':'500m','memory':'256Mi'}},
                    'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},
                    'volumeMounts':[{'name':'data','mountPath':'/data'}]}],
                'volumes':[{'name':'data','persistentVolumeClaim':{'claimName':claim}}]}}
        writer="""
import ctypes,errno,fcntl,json,os,sqlite3,struct
db=sqlite3.connect('/data/app.db'); db.execute('CREATE TABLE records(value TEXT)'); db.execute("INSERT INTO records VALUES ('synthetic')"); db.commit(); db.close()
fd=os.open('/data/fill',os.O_WRONLY|os.O_CREAT,0o600)
try:
 for i in range(1100): os.write(fd,b'x'*(1024*1024))
 raise RuntimeError('Hard quota was not enforced')
except OSError as e: assert e.errno==errno.EDQUOT,e
finally: os.close(fd)
fd=os.open('/data',os.O_RDONLY); data=bytearray(28); fcntl.ioctl(fd,0x801c581f,data)
lib=ctypes.CDLL(None,use_errno=True); lib.syscall.restype=ctypes.c_long
for request in [0x401c5820,0x40086602,0x40046602]:
 for extra in [0,1<<32]:
  result=lib.syscall(ctypes.c_long(29),ctypes.c_int(fd),ctypes.c_ulong(request|extra),ctypes.c_void_p(0))
  assert result==-1 and ctypes.get_errno()==errno.EPERM,(request|extra,result,ctypes.get_errno())
os.close(fd)
db=sqlite3.connect('/data/app.db'); assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; db.close()
print(json.dumps({'hardLimit':'EDQUOT','deniedIoctlVariants':6,'integrity':'ok'}),flush=True)
"""
        control="from pathlib import Path; import time; Path('/data/control').write_bytes(b'x'*1024*1024); time.sleep(600)"
        kube('create','-f','-',document=pod('a','a',writer)); kube('create','-f','-',document=pod('b','b',control))
        def succeeded(name):
            status=json.loads(kube('get','pod',name,'-n',CONSUMER,'-o','json'))['status']
            if status.get('phase')=='Failed': raise RuntimeError('Validation pod failed: '+kube('logs',name,'-n',CONSUMER))
            return status.get('phase')=='Succeeded'
        wait(lambda:succeeded('a')); print(kube('logs','a','-n',CONSUMER),flush=True)
        assert json.loads(kube('get','pod','b','-n',CONSUMER,'-o','json'))['status']['phase']=='Running'
        reader="import sqlite3,os,errno; db=sqlite3.connect('/data/app.db'); assert db.execute('SELECT count(*) FROM records').fetchone()[0]==1; os.unlink('/data/fill'); db.execute(\"INSERT INTO records VALUES ('after-restart')\"); db.commit(); assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; db.close(); print('restart-and-write-ok')"
        kube('create','-f','-',document=pod('a-restart','a',reader)); wait(lambda:succeeded('a-restart'))
        kube('delete','namespace',CONSUMER,'--wait=true','--timeout=120s')
        wait(lambda:not [p for p in json.loads(kube('get','pv','-o','json'))['items'] if p['spec'].get('claimRef',{}).get('namespace')==CONSUMER])
        assert not list(storage.iterdir()),'Test PV directories were not reclaimed'
        ready_to_remove=True
        print(json.dumps({'ok':True,'realPVCs':2,'otherAppRunning':True,'podReplacementPreservesData':True,'deletionReclaimsVolumes':True}),flush=True)
    finally:
        # Preserve a failed rehearsal for inspection rather than hiding or
        # force-removing a live PV. Successful test resources are identity-checked.
        if ready_to_remove:
            for kind,name,uid in reversed(created):
                if kind not in ['Namespace','StorageClass','ClusterRole','ClusterRoleBinding'] or name==CONSUMER: continue
                current=kube('get',kind,name,'--ignore-not-found','-o','json')
                if current and json.loads(current)['metadata']['uid']!=uid: raise RuntimeError('Resource identity changed')
                if current: kube('delete',kind,name,'--wait=true','--timeout=120s')
            if mounted: subprocess.run(['umount',str(mount)],check=True)
            if lab.parent!=Path('/data') or not lab.name.startswith('swkoo-quota-pvc-lab-'): raise RuntimeError('Unsafe cleanup target')
            shutil.rmtree(lab)
        else: print(json.dumps({'preservedRehearsal':str(lab)}),flush=True)


if __name__=='__main__': main()
