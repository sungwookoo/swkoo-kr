"""Safety checks for the operational load runner, without a cluster."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('load_validation', Path(__file__).with_name('validate-app-capacity.py'))
load = importlib.util.module_from_spec(spec)
spec.loader.exec_module(load)
runner_spec = importlib.util.spec_from_file_location('operation_runner', Path(__file__).with_name('run-operational-validation.py'))
runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(runner)


class LoadSafety(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'fixtures.json'
        self.image = 'ghcr.io/sw-koo/nextjs-sample@sha256:' + 'a' * 64
        self.fixtures = {}
        for suffix, namespace in zip(['a', 'b', 'c'], load.NAMESPACES):
            self.fixtures[suffix] = {'namespace.yaml': {'metadata': {'name': namespace}}}
            for name in ['resource-quota.yaml', 'limit-range.yaml', 'network-policy.yaml', 'probe/pvc.yaml', 'probe/deployment.yaml']:
                self.fixtures[suffix][name] = {'metadata': {'namespace': namespace}}

    def run_plan(self, image=None, execute=False):
        self.path.write_text(json.dumps(self.fixtures))
        args = ['validation', str(self.path), image or self.image] + (['--execute'] if execute else [])
        with patch('sys.argv', args), contextlib.redirect_stdout(io.StringIO()) as output:
            load.main()
        return json.loads(output.getvalue())

    def test_plan_has_no_cluster_calls(self):
        with patch.object(load, 'kube', side_effect=AssertionError('No cluster calls allowed')):
            self.assertFalse(self.run_plan()['execute'])

    def test_production_image_is_rejected(self):
        with patch.object(load, 'kube') as kube, contextlib.redirect_stderr(io.StringIO()):
            for image in ['ghcr.io/customer/app@sha256:' + 'a' * 64, self.image.replace('ghcr.io', 'ghcrXio')]:
                with self.assertRaises(SystemExit):
                    self.run_plan(image)
            kube.assert_not_called()

    def test_cross_namespace_resource_is_rejected(self):
        self.fixtures['b']['probe/deployment.yaml']['metadata']['namespace'] = 'swkoo'
        with patch.object(load, 'kube') as kube, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.run_plan()
            kube.assert_not_called()

    def test_existing_namespace_is_never_applied_or_deleted(self):
        with patch.object(load, 'kube', return_value=load.NAMESPACES[0]) as kube:
            with self.assertRaisesRegex(AssertionError, 'Refusing existing namespace'):
                self.run_plan(execute=True)
            self.assertEqual(kube.call_count, 1)
            self.assertEqual(kube.call_args.args[:2], ('get', 'namespace'))

    def test_metric_warmup_does_not_hide_access_errors(self):
        with patch.object(load.subprocess, 'run') as run:
            run.return_value = subprocess_result = type('Result', (), {'returncode': 1, 'stderr': 'error: metrics not available yet'})()
            self.assertEqual(load.metrics('fixture'), [])
            subprocess_result.stderr = 'Error from server (Forbidden)'
            with self.assertRaisesRegex(RuntimeError, 'metrics lookup failed'):
                load.metrics('fixture')


class EntryPointSafety(unittest.TestCase):
    image = 'ghcr.io/sungwookoo/sprintflow:latest@sha256:' + 'b' * 64

    def test_default_plan_never_calls_the_cluster(self):
        with patch('sys.argv', ['validation', 'runtime', '--image', self.image]), patch.object(runner, 'kube') as kube:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(runner.main(), 0)
            self.assertFalse(json.loads(output.getvalue())['execute'])
            kube.assert_not_called()

    def test_another_cluster_is_rejected_before_resource_creation(self):
        nodes = {'items': [{'metadata': {'name': 'another-node'}}]}
        with patch('sys.argv', ['validation', 'runtime', '--image', self.image, '--execute']), \
                patch.object(runner.sys, 'platform', 'linux'), patch.object(runner.shutil, 'which', return_value='/usr/bin/kubectl'), \
                patch.object(runner, 'kube', return_value=json.dumps(nodes)) as kube:
            with self.assertRaisesRegex(AssertionError, 'Unexpected cluster'):
                runner.main()
            self.assertEqual(kube.call_count, 1)
            self.assertEqual(kube.call_args.args, ('get', 'nodes', '-o', 'json'))

    def test_customer_image_is_rejected_before_cluster_access(self):
        for image in [self.image.replace('sungwookoo', 'customer'), self.image.replace('ghcr.io', 'ghcrXio')]:
            with patch('sys.argv', ['validation', 'runtime', '--image', image]), \
                    patch.object(runner, 'kube') as kube, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    runner.main()
                kube.assert_not_called()


if __name__ == '__main__':
    unittest.main()
