"""Run on the OCI host with sudo, using JSON rendered by renderDeployRepoFiles.

Creates ONLY user-swkoo-validation-a/b and refuses existing namespaces.
Exercises Prisma migrations, PVC replacement, isolated restore and NetworkPolicy.
All test resources are removed in finally; production namespaces are read-only.
"""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def kube(*args, data=None):
    return subprocess.check_output(["kubectl", *args], input=data, text=True).strip()


def obj(*args):
    return json.loads(kube(*args, "-o", "json"))


def apply(resource):
    return kube("apply", "-f", "-", data=json.dumps(resource))


def wait(ns):
    print(kube("rollout", "status", "deployment/probe", "-n", ns, "--timeout=60s"), flush=True)


def node(ns, code):
    return kube("exec", "-n", ns, "deployment/probe", "-c", "probe", "--", "node", "-e", code)


def database_path(ns):
    pvc = obj("get", "pvc", "probe-data", "-n", ns)
    pv = obj("get", "pv", pvc["spec"]["volumeName"])
    return Path(pv["spec"]["local"]["path"]) / "app.db", pv["metadata"]["name"]


fixtures = json.loads(Path(sys.argv[1]).read_text())
namespaces = ["user-swkoo-validation-a", "user-swkoo-validation-b"]
created = []
backup_dir = tempfile.mkdtemp(prefix="swkoo-storage-validation-")
image = "ghcr.io/sungwookoo/sprintflow:latest@sha256:77c71e44b89075dae79232951f65e9b56854fbe85976b3f9996437f24415e582"
try:
    existing = {n["metadata"]["name"] for n in obj("get", "namespaces")["items"]}
    assert not existing.intersection(namespaces), "Validation namespace already exists; refusing to modify it"
    for suffix, ns in zip(["a", "b"], namespaces):
        files = fixtures[suffix]
        assert files["namespace.yaml"]["metadata"]["name"] == ns
        for key in ["namespace.yaml", "resource-quota.yaml", "limit-range.yaml", "probe/pvc.yaml"]:
            apply(files[key])
            if key == "namespace.yaml":
                created.append(ns)
        dep = files["probe/deployment.yaml"]
        for container in dep["spec"]["template"]["spec"]["initContainers"]:
            container["image"] = image
        container = dep["spec"]["template"]["spec"]["containers"][0]
        container["image"] = image
        container["command"] = ["node", "-e", "require('http').createServer((q,r)=>r.end('validation')).listen(3000,'0.0.0.0')"]
        container["readinessProbe"] = {"httpGet": {"path": "/", "port": 3000}, "periodSeconds": 2}
        apply(dep)
        apply(files["probe/service.yaml"])
        wait(ns)
        print("PASS migrated empty SQLite and started restricted pod", ns, flush=True)

    a, b = namespaces
    code = "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.create({data:{key:'VERIFY',name:'Preserve me',summary:'Test only',leadName:'Validation'}}).then(()=>p.$disconnect()).catch(e=>{console.error(e);process.exit(1)})"
    node(a, code)
    count = "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.project.findMany().then(r=>{if(r.length!==1||r[0].name!=='Preserve me')throw Error('data mismatch');console.log('preserved');return p.$disconnect()}).catch(e=>{console.error(e);process.exit(1)})"
    kube("rollout", "restart", "deployment/probe", "-n", a)
    wait(a)
    assert node(a, count) == "preserved"
    print("PASS Prisma data survived pod replacement", flush=True)
    source_path, source_pv = database_path(a)
    backup = Path(backup_dir) / "backup.db"
    with sqlite3.connect(f"file:{source_path}?mode=ro", uri=True) as source, sqlite3.connect(backup) as target:
        source.backup(target)
        assert target.execute("pragma integrity_check").fetchone()[0] == "ok"
    # Restore into a DIFFERENT namespace and PVC while its app is stopped.
    kube("scale", "deployment/probe", "-n", b, "--replicas=0")
    kube("wait", "--for=delete", "pod", "-n", b, "-l", "app=probe", "--timeout=60s")
    restore_path, _ = database_path(b)
    with sqlite3.connect(backup) as source, sqlite3.connect(restore_path) as target:
        source.backup(target)
    kube("scale", "deployment/probe", "-n", b, "--replicas=1")
    wait(b)
    assert node(b, count) == "preserved"
    print("PASS backup restored on separate PVC and read through Prisma", flush=True)

    target_ip = obj("get", "service", "probe", "-n", b)["spec"]["clusterIP"]
    connect = "const s=require('net').connect(80,'" + target_ip + "');s.setTimeout(2500);s.on('connect',()=>{console.log('connected');s.destroy()});s.on('timeout',()=>{console.log('blocked');s.destroy()});s.on('error',()=>console.log('blocked'))"
    assert node(a, connect) == "connected", "Positive network control failed"
    apply(fixtures["a"]["network-policy.yaml"])
    # CNI policy propagation is asynchronous; bounded retries, not a blind pass.
    for _ in range(15):
        if node(a, connect) == "blocked":
            break
        time.sleep(1)
    else:
        raise AssertionError("NetworkPolicy did not block cross-namespace traffic")
    assert "dns-ok" in node(a, "require('dns').lookup('github.com',(e)=>{if(e)process.exit(1);console.log('dns-ok')})")
    assert "no-token" in node(a, "if(require('fs').existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'))process.exit(1);console.log('no-token')")
    print("PASS cross-namespace traffic blocked, DNS allowed, service-account token absent", flush=True)

    # Namespace deletion is the destructive boundary even when PVC has Prune=false.
    kube("delete", "namespace", a, "--wait=true", "--timeout=60s")
    created.remove(a)
    for _ in range(30):
        remaining = kube("get", "pv", source_pv, "--ignore-not-found")
        if not remaining and not source_path.parent.exists():
            break
        time.sleep(1)
    else:
        raise AssertionError("Deleted namespace's test PV was not reclaimed")
    assert node(b, count) == "preserved"
    print("PASS namespace deletion reclaimed its PV; independent restore remains intact", flush=True)
finally:
    for ns in created:
        if ns not in namespaces:
            raise AssertionError("Refusing cleanup outside validation namespaces")
        kube("delete", "namespace", ns, "--wait=true", "--timeout=60s")
    shutil.rmtree(backup_dir)
    print("Validation resources cleaned up", flush=True)
