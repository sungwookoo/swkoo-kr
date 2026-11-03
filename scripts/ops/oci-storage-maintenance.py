#!/usr/bin/env python3
"""Daily platform-only storage maintenance. Defaults to inspection, not deletion.

Uses the host's existing OCI profile and Kubernetes pull secret, without copying
credentials. Never touches user repositories, user PVCs, or user app images.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import re
import subprocess

REPOS = ('swkoo/backend', 'swkoo/frontend')
BUCKET = 'swkoo-kr-backups'
HOST = 'nrt.ocir.io'
BACKUP = re.compile(r'^daily/\d{4}-\d{2}-\d{2}/observatory\.sqlite$')
SHA = re.compile(r'^[a-f0-9]{40}$')
BUDGET_BYTES = 8_000_000_000  # Leave 2 GB below the paid-account 10 GB allowance.
STATUS = Path('/var/lib/swkoo-storage-maintenance/status.json')


def kubectl(*args):
    return json.loads(subprocess.check_output(
        ['sudo', '-n', 'k3s', 'kubectl', *args, '-o', 'json'], timeout=60))


def references(inventory, namespace):
    """Include desired, running, init-container and all ReplicaSet rollback refs."""
    found = {repo: set() for repo in REPOS}
    deployments = set()
    prefix = f'{HOST}/{namespace}/'
    for item in inventory['items']:
        if item['kind'] == 'Deployment' and item['metadata']['namespace'] == 'swkoo':
            deployments.add(item['metadata']['name'])
        spec = item.get('spec', {})
        spec = spec.get('template', {}).get('spec', spec)
        containers = spec.get('containers', []) + spec.get('initContainers', [])
        status = item.get('status', {})
        containers += status.get('containerStatuses', []) + status.get('initContainerStatuses', [])
        for container in containers:
            image = container.get('image', '')
            if not image.startswith(prefix):
                continue
            image = image[len(prefix):]
            for repo in REPOS:
                if image.startswith(repo + ':') or image.startswith(repo + '@'):
                    ref = image[len(repo) + 1:]
                    if '@' in ref:
                        tag, digest = ref.split('@', 1)
                        found[repo].update((tag, digest))
                    else:
                        found[repo].add(ref)
    if not {'swkoo-backend', 'swkoo-frontend'}.issubset(deployments):
        raise RuntimeError('Missing platform Deployment; refusing incomplete inventory')
    if any(not refs for refs in found.values()):
        raise RuntimeError('Missing platform image references')
    return found


def image_plan(images, required, fetch_manifest, now):
    """Delete only old digests unreachable from every protected manifest/index."""
    available = [i for i in images if i.lifecycle_state == 'AVAILABLE']
    by_digest = {i.digest: i for i in available}
    by_tag = {i.version: i.digest for i in available if i.version}
    missing = required - (by_tag.keys() | by_digest.keys())
    if missing:
        raise RuntimeError(f'Required registry references missing: {sorted(missing)}')
    keep = {by_tag.get(ref, ref) for ref in required}
    recent = sorted((i for i in available if i.version and SHA.fullmatch(i.version)),
                    key=lambda i: i.time_created, reverse=True)[:3]
    keep.update(i.digest for i in recent)
    for image in available:
        # Unknown version names and all storage versions remain protected.
        if (image.time_created > now - timedelta(days=2) or
                image.version and not SHA.fullmatch(image.version)):
            keep.add(image.digest)
    pending = list(keep)
    manifests = {}
    while pending:
        digest = pending.pop()
        if digest in manifests:
            continue
        manifest = fetch_manifest(digest)
        if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 2:
            raise RuntimeError(f'Unreadable protected manifest: {digest}')
        manifests[digest] = manifest
        children = [m['digest'] for m in manifest.get('manifests', [])]
        subject = manifest.get('subject', {}).get('digest')
        if subject:
            children.append(subject)
        for child in children:
            if child not in by_digest:
                raise RuntimeError(f'Protected child missing from OCI inventory: {child}')
            if child not in keep:
                keep.add(child)
                pending.append(child)
    candidates = list({i.id: i for i in available if i.digest not in keep}.values())
    return keep, candidates, manifests


def backup_plan(objects, now):
    owned = sorted((o for o in objects if BACKUP.fullmatch(o.name)),
                   key=lambda o: o.time_modified, reverse=True)
    if not owned or owned[0].time_modified < now - timedelta(hours=48):
        raise RuntimeError('No fresh platform backup; keep existing backups and investigate')
    protected = {o.name for o in owned[:2]}
    delete = [o for o in owned if o.time_modified < now - timedelta(days=14)
              and o.name not in protected]
    return owned, delete


def list_objects(client, namespace):
    objects = []
    start = None
    while True:
        response = client.list_objects(namespace, BUCKET, fields='name,size,timeModified,etag',
                                       **({'start': start} if start else {})).data
        objects.extend(response.objects)
        start = response.next_start_with
        if not start:
            return objects


def delete_image(client, image, images):
    current = client.get_container_image(image.id)
    original_versions = {i.version for i in images if i.id == image.id and i.version}
    if {v.version for v in current.data.versions} != original_versions:
        raise RuntimeError('Image versions changed; retry later')
    client.delete_container_image(image.id, if_match=current.headers['etag'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    # The unit runs one instance at a time; manual invocations use the same lock.
    import fcntl
    with open('/home/ubuntu/.swkoo-storage-maintenance.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            result = run(args.apply)
        except Exception:
            if args.apply:
                write_status({'success': False})
            raise
        if args.apply:
            write_status({'success': True, **result})


def write_status(result):
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    temporary = STATUS.with_suffix('.tmp')
    temporary.write_text(json.dumps(result))
    temporary.chmod(0o644)
    temporary.replace(STATUS)


def run(apply):
    import oci
    config = oci.config.from_file()
    if config['region'] != 'ap-tokyo-1':
        raise RuntimeError('Unexpected OCI region')
    artifacts = oci.artifacts.ArtifactsClient(config)
    storage = oci.object_storage.ObjectStorageClient(config)
    namespace = storage.get_namespace().data
    inventory = kubectl('get', 'deployments,replicasets,pods', '--all-namespaces')
    refs = references(inventory, namespace)
    credentials = kubectl('get', 'secret', 'ocir-credentials', '-n', 'swkoo')
    auths = json.loads(base64.b64decode(credentials['data']['.dockerconfigjson']))['auths']
    auth = auths.get(HOST) or auths.get('https://' + HOST)
    if not auth:
        raise RuntimeError('Expected registry credentials missing')
    if 'auth' in auth:
        username, token = base64.b64decode(auth['auth']).decode().split(':', 1)
    else:
        username, token = auth['username'], auth['password']
    spec = importlib.util.spec_from_file_location('registry', Path(__file__).with_name('ocir-retention.py'))
    registry = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(registry)
    now = datetime.now(timezone.utc)
    repos = oci.pagination.list_call_get_all_results(
        artifacts.list_container_repositories, config['tenancy']).data
    selected = {r.display_name: r for r in repos if r.display_name in REPOS}
    if set(selected) != set(REPOS):
        raise RuntimeError('Platform repositories missing')
    plans = {}
    for repo, summary in selected.items():
        images = oci.pagination.list_call_get_all_results(
            artifacts.list_container_images, config['tenancy'], repository_id=summary.id).data
        bearer = registry.get_bearer(HOST, username, token, f'repository:{namespace}/{repo}:pull')
        def fetch(digest):
            actual, _, manifest = registry.get_manifest(HOST, f'{namespace}/{repo}', digest, bearer)
            if actual != digest:
                raise RuntimeError('Registry manifest digest mismatch')
            return manifest
        keep, delete, manifests = image_plan(images, refs[repo], fetch, now)
        # OCI can attach multiple versions to one digest. Refuse a stale tag view.
        # The Registry tag inventory must agree with OCI before any mutation.
        tags = set(registry.list_tags(HOST, f'{namespace}/{repo}', bearer))
        if tags != {i.version for i in images if i.version and i.lifecycle_state == 'AVAILABLE'}:
            raise RuntimeError('OCI/registry tag inventory differs; retry when stable')
        plans[repo] = (summary, images, keep, delete, manifests, bearer)
        print(json.dumps({'repo': repo, 'images': len(images), 'protected': len(keep),
                          'delete': len(delete), 'required': sorted(refs[repo])}), flush=True)
    objects = list_objects(storage, namespace)
    owned, remove = backup_plan(objects, now)
    print(json.dumps({'backupObjects': len(owned), 'backupBytes': sum(o.size for o in objects),
                      'deleteBackups': len(remove), 'deleteBackupBytes': sum(o.size for o in remove),
                      'retentionDays': 14, 'apply': apply}), flush=True)
    if not apply:
        return
    if references(kubectl('get', 'deployments,replicasets,pods', '--all-namespaces'), namespace) != refs:
        raise RuntimeError('Deployment changed during inspection; no deletion performed')
    # Re-read all repository versions before mutating either repository. Young
    # images are preserved, so an in-progress publish is also safe on retry.
    for repo, (summary, images, keep, delete, manifests, bearer) in plans.items():
        current = oci.pagination.list_call_get_all_results(
            artifacts.list_container_images, config['tenancy'], repository_id=summary.id).data
        signature = lambda rows: {(i.id, i.digest, i.version, i.lifecycle_state) for i in rows}
        if signature(current) != signature(images):
            raise RuntimeError('Registry changed during inspection; retry later')
    for repo, (summary, images, keep, delete, manifests, bearer) in plans.items():
        for image in delete:
            delete_image(artifacts, image, images)
        # Confirm every retained root and child is still retrievable.
        for digest in manifests:
            actual, _, manifest = registry.get_manifest(HOST, f'{namespace}/{repo}', digest, bearer)
            if actual != digest or manifest != manifests[digest]:
                raise RuntimeError(f'Protected manifest verification failed: {repo}@{digest}')
        print(json.dumps({'repo': repo, 'deleted': len(delete), 'protectedVerified': len(manifests)}), flush=True)
    # Conditional deletion never removes an object overwritten after inspection.
    for obj in remove:
        storage.delete_object(namespace, BUCKET, obj.name, if_match=obj.etag)
    remaining = list_objects(storage, namespace)
    remaining_names = {o.name for o in remaining}
    if any(o.name not in remaining_names for o in owned if o not in remove):
        raise RuntimeError('Backup preservation verification failed')
    total = sum(o.size for o in remaining)
    for summary in repos:
        actual = artifacts.get_container_repository(summary.id).data
        total += actual.layers_size_in_bytes or 0
    result = {'remainingBackupObjects': len(remaining),
                      'remainingBackupBytes': sum(o.size for o in remaining),
                      'reportedCombinedBytes': total, 'budgetBytes': BUDGET_BYTES,
                      'note': 'OCIR reclamation may take up to 48 hours'}
    print(json.dumps(result), flush=True)
    if total >= BUDGET_BYTES:
        raise RuntimeError('Storage above 8 GB safety budget; inspect retained images / delayed reclamation')
    return result


if __name__ == '__main__':
    main()
