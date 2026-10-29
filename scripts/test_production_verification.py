"""Failure-path tests: no external network or deployment writes."""
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('verify-production-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = 'a' * 40


class ProductionVerification(unittest.TestCase):
    def respond(self, path):
        if path in ['/api/health', '/version.json']:
            return 200, json.dumps({'status': 'ok', 'revision': SHA}).encode(), {'Cache-Control': 'no-store'}
        return release.ROUTES[path], b'', {}

    def test_verifies_each_service_and_auth_boundary(self):
        with patch.object(release, 'read', side_effect=self.respond) as read:
            self.assertTrue(release.verify({'backend': SHA, 'frontend': SHA})['ok'])
            self.assertIn('/api/admin/deployment-recovery', [call.args[0] for call in read.call_args_list])

    def test_wrong_or_cached_revision_never_passes(self):
        for body, headers in [({'revision': 'b' * 40, 'status': 'ok'}, {'Cache-Control': 'no-store'}),
                              ({'status': 'ok'}, {'Cache-Control': 'no-store'}),
                              ({'revision': SHA, 'status': 'ok'}, {}),
                              ({'revision': SHA, 'status': 'failed'}, {'Cache-Control': 'no-store'})]:
            with patch.object(release, 'read', return_value=(200, json.dumps(body).encode(), headers)):
                with self.assertRaises(RuntimeError): release.verify({'backend': SHA})

    def test_wrong_route_status_auth_leak_redirect_and_tls_error_fail(self):
        for path in release.ROUTES:
            def wrong_route(current):
                return (302 if path == '/' else 200 if 'admin' in path else 500), b'', {} if current == path else {}
            original = self.respond
            with patch.object(release, 'read', side_effect=lambda current: wrong_route(current) if current == path else original(current)):
                with self.assertRaises(RuntimeError): release.verify({})
        with patch.object(release, 'read', side_effect=OSError('TLS verification failed')):
            with self.assertRaises(OSError): release.verify({})

    def test_redirect_handler_never_follows_a_different_origin(self):
        self.assertIsNone(release.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example'))


storage_spec = importlib.util.spec_from_file_location('storage', Path(__file__).with_name('validate-ephemeral-storage.py'))
storage = importlib.util.module_from_spec(storage_spec)
storage_spec.loader.exec_module(storage)


class EphemeralValidationSafety(unittest.TestCase):
    def run_fixture(self, extra=None, image=None):
        argv = ['validation', '--image', image or 'ghcr.io/sw-koo/nextjs-sample@sha256:' + 'a' * 64] + (extra or [])
        with patch('sys.argv', argv), contextlib.redirect_stdout(io.StringIO()): storage.main()

    def test_plan_does_not_call_cluster(self):
        with patch.object(storage, 'kube', side_effect=AssertionError('No mutation')): self.run_fixture()

    def test_customer_images_and_existing_namespaces_are_rejected(self):
        with patch.object(storage, 'kube', return_value='namespace/existing') as kube:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): self.run_fixture(image='ghcr.io/customer/app@sha256:' + 'a' * 64)
            kube.assert_not_called()
            with self.assertRaisesRegex(RuntimeError, 'existing namespace'): self.run_fixture(['--execute'])
            self.assertEqual(kube.call_count, 1)

    def test_fixture_has_no_volume_secret_or_service_account_and_bounded_writes(self):
        fixture = storage.pod('exhaust', 64)
        self.assertFalse(fixture['spec']['automountServiceAccountToken'])
        self.assertNotIn('volumes', fixture['spec'])
        self.assertNotIn('env', fixture['spec']['containers'][0])
        self.assertEqual(fixture['metadata']['namespace'], storage.NAMESPACE)
        self.assertEqual(fixture['spec']['containers'][0]['resources']['limits']['ephemeral-storage'], '32Mi')


if __name__ == '__main__': unittest.main()
