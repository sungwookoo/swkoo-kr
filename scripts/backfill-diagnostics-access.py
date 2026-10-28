"""One-time read-only log access for existing active user namespaces; no repo writes.

Run on the OCI management host. Plans by default. Namespace deletion naturally
removes these backfill Roles; future registrations use the regular template.
"""
import argparse
import json
import re
import subprocess


def resources(namespace):
    if not re.fullmatch(r'user-[a-z0-9][a-z0-9-]*', namespace): raise ValueError('Not a user namespace')
    name = 'swkoo-backend-diagnostics-reader'
    metadata = {'name':name,'namespace':namespace,'labels':{'swkoo.kr/diagnostics-backfill':'true'}}
    return [
        {'apiVersion':'rbac.authorization.k8s.io/v1','kind':'Role','metadata':metadata,
         'rules':[{'apiGroups':[''],'resources':['pods/log'],'verbs':['get']}]},
        {'apiVersion':'rbac.authorization.k8s.io/v1','kind':'RoleBinding','metadata':metadata,
         'subjects':[{'kind':'ServiceAccount','name':'swkoo-backend','namespace':'swkoo'}],
         'roleRef':{'kind':'Role','name':name,'apiGroup':'rbac.authorization.k8s.io'}},
    ]


def kube(*args, data=None):
    return subprocess.check_output(['kubectl',*args],input=data,text=True).strip()


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--execute',action='store_true'); args=parser.parse_args()
    apps=json.loads(kube('get','applications','-n','argocd','-o','json'))['items']
    namespaces=json.loads(kube('get','namespaces','-l','swkoo.kr/tenant=user','-o','json'))['items']
    active={a['spec']['destination'].get('namespace') for a in apps if a['metadata']['name'].startswith('swkoo-user-') and not a['metadata'].get('deletionTimestamp')}
    targets=[ns['metadata']['name'] for ns in namespaces if ns['metadata']['name'] in active and not ns['metadata'].get('deletionTimestamp')]
    print(json.dumps({'execute':args.execute,'namespaces':targets,'permission':'get pods/log'}))
    if not args.execute: return
    for ns in targets:
        for resource in resources(ns):
            existing=kube('get',resource['kind'],resource['metadata']['name'],'-n',ns,'--ignore-not-found','-o','json')
            if existing:
                value=json.loads(existing)
                assert value['metadata'].get('labels',{}).get('swkoo.kr/diagnostics-backfill') == 'true', 'Foreign resource'
                for key in ['rules','subjects','roleRef']:
                    if key in resource: assert value.get(key) == resource[key], 'Unexpected existing grant'
                continue
            kube('create','-f','-',data=json.dumps(resource))


if __name__ == '__main__': main()
