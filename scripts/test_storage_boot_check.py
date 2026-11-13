import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'boot_check', Path(__file__).resolve().parents[1] / 'deploy/host/storage-boot-check.py'
)
boot_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot_check)


class StorageBootCheckTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.boot = Path(directory.name)
        (self.boot / 'grub').mkdir()
        (self.boot / 'grub/grubenv').write_text('# GRUB Environment Block\n')
        (self.boot / 'grub/grub.cfg').write_text(
            '  set default="${next_entry}"\n  set default="0"\n'
            'menuentry Ubuntu {\n  linux /boot/vmlinuz-new root=example\n'
            '  initrd /boot/initrd.img-new\n}\n'
        )
        for name in ('vmlinuz-new', 'initrd.img-new'):
            (self.boot / name).write_text('image')

    @patch.object(boot_check.subprocess, 'run')
    def test_checks_target_kernel_without_loading_module(self, run):
        module = self.boot / 'quota_v2.ko'
        module.touch()
        run.return_value.stdout = f'insmod {module}\n'
        self.assertEqual(boot_check.check(self.boot), 'OK: new, quota_v2 available')
        self.assertEqual(run.call_args.args[0][1:], ['--show-depends', '-S', 'new', 'quota_v2'])
        module.unlink()
        self.assertEqual(boot_check.check(self.boot), 'WARN: incomplete quota_v2 for new')

    @patch.object(boot_check.subprocess, 'run')
    def test_warns_if_quota_module_missing(self, run):
        run.side_effect = subprocess.CalledProcessError(1, 'modprobe')
        self.assertEqual(boot_check.check(self.boot), 'WARN: quota_v2 unavailable for new')

    @patch.object(boot_check.subprocess, 'run')
    def test_one_time_override_needs_manual_verification(self, run):
        (self.boot / 'grub/grubenv').write_text('next_entry=another\n')
        self.assertEqual(boot_check.check(self.boot), 'WARN: verify the GRUB boot selection')
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
