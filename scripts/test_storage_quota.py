"""Safety invariants for privileged storage helpers; no kernel/cluster changes."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('quota', ROOT / 'deploy/storage/quota.py')
quota = importlib.util.module_from_spec(spec); spec.loader.exec_module(quota)
NAME = 'pvc-00000001-0000-4000-8000-000000000000_user-alice_app-data'


class StorageQuotaSafety(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.override = patch.object(quota, 'ROOT', self.root); self.override.start(); self.addCleanup(self.override.stop)
        self.target = self.root / NAME

    def test_rejects_non_user_paths_traversal_and_symlinks(self):
        for target in [self.root, self.root / '..' / NAME, self.root / 'pvc-bad_user-alice_app', self.root / NAME.replace('user-alice', 'swkoo')]:
            with self.assertRaises(ValueError): quota.checked_path(target)
        self.target.symlink_to('/tmp')
        with self.assertRaises(ValueError): quota.checked_path(self.target)

    def test_missing_enforcement_never_creates_a_directory(self):
        with patch.object(quota, 'quota', side_effect=OSError('Disabled')):
            with self.assertRaises(OSError): quota.apply(self.target)
        self.assertFalse(self.target.exists())

    def test_colliding_project_ids_never_share_storage_accounting(self):
        sibling = self.root / NAME.replace('00000001', '00000002'); sibling.mkdir()
        with patch.object(quota, 'quota'), patch.object(quota, 'attributes', return_value=(0,0,0,quota.project_id(self.target),0,b'')), patch.object(quota, 'set_limits') as set_limits:
            with self.assertRaisesRegex(ValueError, 'collision'): quota.apply(self.target)
            set_limits.assert_not_called()

    def test_over_limit_legacy_data_is_kept_without_changing_limits(self):
        self.target.mkdir(); (self.target / 'existing.db').write_bytes(b'x' * 8192)
        with patch.object(quota, 'quota'), patch.object(quota, 'get_quota', return_value=quota.Dqblk()), patch.object(quota, 'set_limits') as set_limits:
            with self.assertRaisesRegex(ValueError, 'exceeds'): quota.apply(self.target, size=4096)
            self.assertTrue((self.target / 'existing.db').exists()); set_limits.assert_not_called()

    def test_deletion_refuses_wrong_project_and_retains_open_allocation_limit(self):
        self.target.mkdir()
        with patch.object(quota, 'attributes', return_value=(0,0,0,0,0,b'')), patch.object(quota.shutil, 'rmtree') as remove:
            with self.assertRaisesRegex(ValueError, 'ownership'): quota.destroy(self.target)
            remove.assert_not_called()
        self.target.rmdir(); usage = quota.Dqblk(); usage.space = 4096
        with patch.object(quota, 'get_quota', return_value=usage), patch.object(quota, 'set_limits') as set_limits:
            with self.assertRaisesRegex(RuntimeError, 'Open'): quota.destroy(self.target)
            set_limits.assert_not_called()

    def test_cli_refuses_arbitrary_size_and_block_volume_before_mutating(self):
        for extra in [['-s','2147483648'], ['-m','Block']]:
            with patch('sys.argv',['quota','-p',str(self.target),'-a','create',*extra]), patch.object(quota,'apply') as apply, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): quota.main()
                apply.assert_not_called()

    def test_seccomp_keeps_default_deny_and_blocks_masked_project_mutation(self):
        profile = json.loads((ROOT/'deploy/host/user-storage-seccomp.json').read_text())
        self.assertEqual(profile['defaultAction'], 'SCMP_ACT_ERRNO')
        guards = [item for item in profile['syscalls'] if 'ioctl' in item['names']]
        ranges=[]
        for item in guards:
            self.assertEqual(item['action'],'SCMP_ACT_ALLOW'); self.assertEqual(len(item['args']),1)
            arg=item['args'][0]; self.assertEqual(arg['op'],'SCMP_CMP_MASKED_EQ'); self.assertEqual(arg['index'],1)
            self.assertLessEqual(arg['value'],0xffffffff); ranges.append((arg['value'],arg['valueTwo']))
        for command in [0x401c5820,0x40086602,0x40046602]:
            for extra in [0,1<<32,0xabcdef<<32]: self.assertFalse(any(((command|extra)&mask)==value for mask,value in ranges))
        # Disjoint coverage of exactly 2^32 - 3 requests proves the profile
        # preserves every other ioctl request, including harmless DB operations.
        for index,(mask,value) in enumerate(ranges):
            for other_mask,other_value in ranges[index+1:]:
                common=mask&other_mask; self.assertNotEqual(value&common,other_value&common)
        self.assertEqual(sum(1<<(32-mask.bit_count()) for mask,_ in ranges),(1<<32)-3)


if __name__ == '__main__': unittest.main()
