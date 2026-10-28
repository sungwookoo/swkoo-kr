"""Safety checks for the operational load runner, without a cluster."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

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

    def test_failed_execution_keeps_a_failed_report_and_checks_remaining_namespaces(self):
        nodes = {'items': [{'metadata': {'name': 'instance-20250321-1004'},
                            'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}]}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'result'
            args = ['validation', 'runtime', '--image', self.image, '--execute', '--output-dir', str(output)]
            with patch('sys.argv', args), patch.object(runner.sys, 'platform', 'linux'), \
                    patch.object(runner.shutil, 'which', return_value='/usr/bin/kubectl'), \
                    patch.object(runner.shutil, 'disk_usage', return_value=Mock(free=10 * 1024**3)), \
                    patch.object(runner, 'kube', side_effect=[json.dumps(nodes), '', '']), \
                    patch.object(runner.subprocess, 'Popen', return_value=Mock(wait=Mock(return_value=1), poll=Mock(return_value=1))), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.main(), 1)
            report = json.loads((output / 'summary.json').read_text())
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['remainingNamespaces'], [])



public_spec = importlib.util.spec_from_file_location('public_validation', Path(__file__).with_name('validate-public-capacity.py'))
public = importlib.util.module_from_spec(public_spec)
public_spec.loader.exec_module(public)
access_spec = importlib.util.spec_from_file_location('diagnostics_access', Path(__file__).with_name('backfill-diagnostics-access.py'))
access = importlib.util.module_from_spec(access_spec)
access_spec.loader.exec_module(access)


class PublicSafety(unittest.TestCase):
    def fixtures(self):
        result = {}
        for suffix, ns in zip(['a','b','c'], public.NAMESPACES):
            files = {'namespace.yaml': {'kind':'Namespace','metadata':{'name':ns}}}
            for name, kind in {'resource-quota.yaml':'ResourceQuota','limit-range.yaml':'LimitRange','network-policy.yaml':'NetworkPolicy',
                               'probe/pvc.yaml':'PersistentVolumeClaim','probe/service.yaml':'Service','probe/deployment.yaml':'Deployment','probe/ingress.yaml':'Ingress'}.items():
                files[name] = {'kind':kind,'metadata':{'name':'probe','namespace':ns}}
            host = f'swkoo-load-{suffix}.apps.swkoo.kr'
            files['probe/ingress.yaml']['spec'] = {'rules':[{'host':host}],'tls':[{'hosts':[host]}]}
            result[suffix] = files
        return result

    def test_public_targets_and_kinds_are_fixed(self):
        image = 'ghcr.io/sw-koo/nextjs-sample@sha256:' + 'a'*64
        public.validate(self.fixtures(), image)
        for change in ['image','namespace','host','kind']:
            data = self.fixtures()
            if change == 'image':
                with self.assertRaises(ValueError): public.validate(data, image.replace('sw-koo','customer'))
                continue
            if change == 'namespace': data['a']['probe/pvc.yaml']['metadata']['namespace'] = 'user-customer'
            if change == 'host': data['a']['probe/ingress.yaml']['spec']['rules'][0]['host'] = 'swkoo.kr'
            if change == 'kind': data['a']['probe/service.yaml']['kind'] = 'ClusterRole'
            with self.assertRaises(ValueError): public.validate(data, image)

    def test_public_plan_does_not_access_cluster_or_create_result_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)/'fixtures.json'; fixture.write_text(json.dumps(self.fixtures()))
            result = Path(directory)/'result'
            args = ['validation',str(fixture),'ghcr.io/sw-koo/nextjs-sample@sha256:'+'a'*64,'--output-dir',str(result)]
            with patch('sys.argv',args),patch.object(public,'kube') as kube,contextlib.redirect_stdout(io.StringIO()):
                public.main(); kube.assert_not_called()
            self.assertFalse(result.exists())

    def test_diagnostics_grant_cannot_read_secrets_or_use_system_namespace(self):
        with self.assertRaises(ValueError): access.resources('kube-system')
        role,binding = access.resources('user-alice')
        self.assertEqual(role['rules'],[{'apiGroups':[''],'resources':['pods/log'],'verbs':['get']}])
        self.assertEqual(binding['subjects'],[{'kind':'ServiceAccount','name':'swkoo-backend','namespace':'swkoo'}])

if __name__ == '__main__':
    unittest.main()
