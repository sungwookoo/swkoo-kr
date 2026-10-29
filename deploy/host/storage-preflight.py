#!/usr/bin/python3
"""Read-only K3s startup guard: never fall back to the root disk."""
import ctypes
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, '/usr/local/lib/swkoo-storage')
import quota


def main():
    config = json.loads(Path('/etc/swkoo-storage.json').read_text())
    for target in ['/data', str(quota.ROOT)]:
        if not Path(target).is_mount(): raise RuntimeError('Required storage mount is missing')
        actual = subprocess.check_output(['findmnt','-T',target,'-n','-o','UUID'],text=True).strip()
        if actual != config['volumeUuid']: raise RuntimeError('Unexpected storage filesystem')
    profile = Path('/var/lib/kubelet/seccomp/swkoo-user-storage-v1.json')
    info = profile.stat()
    if profile.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022: raise RuntimeError('Insecure workload profile ownership')
    if hashlib.sha256(profile.read_bytes()).hexdigest() != config['profileSha256']: raise RuntimeError('Workload security profile changed')
    fmt = ctypes.c_uint32(); quota.quota(0x800004, 0, fmt)
    print('swkoo storage: correct filesystem, project quota and workload profile verified')


if __name__ == '__main__': main()
