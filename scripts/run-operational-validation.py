"""Single operator entry point. Plans by default; --execute runs on the OCI host."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
CASES = {
    'storage': ('validate-user-storage.py', ['user-swkoo-validation-a', 'user-swkoo-validation-b'], 600),
    'runtime': ('validate-runtime-failures.py', ['user-swkoo-failure-validation'], 600),
    'load': ('validate-app-capacity.py', ['user-swkoo-load-a', 'user-swkoo-load-b', 'user-swkoo-load-c'], 1500),
}


def kube(*args):
    return subprocess.check_output(['kubectl', *args], text=True).strip()


def interrupted(signum, frame):
    raise KeyboardInterrupt('Operator interrupted validation')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', choices=CASES)
    parser.add_argument('--image', required=True)
    parser.add_argument('--fixtures')
    parser.add_argument('--output-dir')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    script, namespaces, timeout = CASES[args.case]
    repository = 'sw-koo/nextjs-sample@' if args.case == 'load' else 'sungwookoo/sprintflow:latest@'
    if not re.fullmatch(r'ghcr\.io/' + re.escape(repository) + r'sha256:[a-f0-9]{64}', args.image):
        parser.error('Only the explicitly approved validation image is allowed')
    if args.case != 'runtime' and (not args.fixtures or not Path(args.fixtures).is_file()):
        parser.error('Rendered fixture JSON is required')
    if not args.execute:
        print(json.dumps({'execute': False, 'case': args.case, 'namespaces': namespaces, 'image': args.image, 'timeoutSeconds': timeout}))
        return 0
    if sys.platform != 'linux' or not shutil.which('kubectl'):
        parser.error('--execute must run on the OCI Linux management host with kubectl')
    nodes = json.loads(kube('get', 'nodes', '-o', 'json'))['items']
    assert len(nodes) == 1 and nodes[0]['metadata']['name'] == 'instance-20250321-1004', 'Unexpected cluster'
    assert any(c['type'] == 'Ready' and c['status'] == 'True' for c in nodes[0]['status']['conditions']), 'Node not Ready'
    assert not kube('get', 'namespace', *namespaces, '--ignore-not-found', '-o', 'name'), 'Refusing existing validation namespaces'
    assert shutil.disk_usage('/var/lib/rancher/k3s/storage').free > 5 * 1024**3, 'Insufficient free disk for validation'
    if args.output_dir:
        output = Path(args.output_dir)
        output.mkdir(mode=0o700)
    else:
        output = Path(tempfile.mkdtemp(prefix='swkoo-validation-' + args.case + '-'))
    command = [sys.executable, str(ROOT / script)]
    if args.case == 'runtime':
        command += [args.image, str(output / 'snapshots.json')]
    elif args.case == 'storage':
        command += [str(Path(args.fixtures).resolve()), args.image]
    else:
        command += [str(Path(args.fixtures).resolve()), args.image, '--execute', '--output', str(output / 'load.json')]
    report = {'case': args.case, 'image': args.image, 'namespaces': namespaces,
              'startedAt': datetime.now(timezone.utc).isoformat(), 'status': 'failed'}
    signal.signal(signal.SIGTERM, interrupted)
    print(json.dumps({'status': 'running', 'case': args.case, 'resultDirectory': str(output)}), flush=True)
    try:
        with (output / 'execution.log').open('x') as log:
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            try:
                assert child.wait(timeout=timeout) == 0, 'Validation failed; see execution.log'
            except BaseException:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=240)
                raise
            if args.case == 'runtime':
                check = (ROOT / 'check-runtime-snapshots.cjs').read_text().replace(
                    "require('../apps/backend/dist/deploy/deploy-status.service.js')", "require('/app/dist/deploy/deploy-status.service.js')")
                result = subprocess.run(['kubectl', 'exec', '-i', '-n', 'swkoo', 'deployment/swkoo-backend', '--', 'node', '-e', check],
                                        input=(output / 'snapshots.json').read_text(), text=True, stdout=log, stderr=subprocess.STDOUT, timeout=60)
                assert result.returncode == 0, 'Deployed runtime classification failed'
        assert not kube('get', 'namespace', *namespaces, '--ignore-not-found', '-o', 'name'), 'Validation namespaces remain'
        if args.case == 'runtime':
            assert not kube('get', 'priorityclass', 'swkoo-failure-validation', '--ignore-not-found', '-o', 'name'), 'Validation priority class remains'
        report['status'] = 'passed'
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error)
        try:
            report['remainingNamespaces'] = kube('get', 'namespace', *namespaces, '--ignore-not-found', '-o', 'name').splitlines()
        except Exception:
            report['cleanupStatus'] = 'unverified'
    finally:
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        (output / 'summary.json').write_text(json.dumps(report, indent=2))
        try:
            print(json.dumps({**report, 'resultDirectory': str(output)}), flush=True)
        except BrokenPipeError:
            pass  # The saved result remains authoritative after an SSH disconnect.
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
