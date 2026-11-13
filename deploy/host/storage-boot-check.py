#!/usr/bin/python3
"""Read-only check for the default Ubuntu GRUB boot entry on the OCI host."""

import re
import subprocess
from pathlib import Path


def check(boot=Path('/boot')):
    try:
        config = (boot / 'grub/grub.cfg').read_text()
        env = (boot / 'grub/grubenv').read_text()
        defaults = re.findall(r'^\s*set default=(.+)$', config, re.M)
        if defaults != ['"${next_entry}"', '"0"'] or re.search(
            r'^(?:next_entry|initrdfail|prev_saved_entry)=.+', env, re.M
        ):
            return 'WARN: verify the GRUB boot selection'

        first_entry = config.split('\nmenuentry ', 1)[1].split('\n}', 1)[0]
        kernel = re.search(r'^\s*linux\s+/boot/vmlinuz-(\S+)\s', first_entry, re.M)[1]
        if not re.fullmatch(r'[a-zA-Z0-9._+-]+', kernel):
            return 'WARN: unrecognized GRUB kernel version'
        for image in ('vmlinuz', 'initrd.img'):
            name = f'{image}-{kernel}'
            if not re.search(r'\s/boot/' + re.escape(name) + r'(?:\s|$)', first_entry):
                return 'WARN: kernel and initramfs differ'
            if (boot / name).stat().st_size == 0:
                return 'WARN: empty boot image'

        result = subprocess.run(
            ['/usr/sbin/modprobe', '--show-depends', '-S', kernel, 'quota_v2'],
            check=True, capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            action, path, *_ = line.split()
            if action == 'insmod' and not Path(path).is_file():
                return f'WARN: incomplete quota_v2 for {kernel}'
            if action not in ('insmod', 'builtin'):
                return f'WARN: unexpected quota_v2 configuration for {kernel}'
        if not result.stdout.strip():
            return f'WARN: quota_v2 not verified for {kernel}'
        return f'OK: {kernel}, quota_v2 available'
    except subprocess.CalledProcessError:
        return f'WARN: quota_v2 unavailable for {kernel}'
    except (OSError, ValueError, TypeError, IndexError, subprocess.TimeoutExpired):
        return 'WARN: boot kernel could not be verified'


if __name__ == '__main__':
    print(check())
