"""Fail-closed Linux project quotas for platform-owned user PVC directories."""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct

ROOT = Path('/var/lib/rancher/k3s/storage')
PATTERN = re.compile(r'pvc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_user-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?_[a-z0-9][a-z0-9-]*')
FSGET, FSSET, INHERIT = 0x801c581f, 0x401c5820, 0x200
HARD_BYTES, HARD_INODES = 1024 ** 3, 65536


class Dqblk(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ['bhard', 'bsoft', 'space', 'ihard', 'isoft', 'inodes', 'btime', 'itime']] + [('valid', ctypes.c_uint32)]


def checked_path(value):
    path = Path(value)
    if path.parent != ROOT or not PATTERN.fullmatch(path.name) or path.is_symlink():
        raise ValueError('Only a direct user PVC directory under the storage root is allowed')
    if ROOT.is_symlink() or path.parent.resolve() != ROOT.resolve(): raise ValueError('Unsafe storage root')
    return path


def project_id(path):
    return (int.from_bytes(hashlib.sha256(path.name.encode()).digest()[:4], 'big') & 0x7fffffff) or 1


def attributes(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        data = bytearray(28); fcntl.ioctl(fd, FSGET, data)
        return struct.unpack('=IIIII8s', data)
    finally: os.close(fd)


def attach(path, identifier):
    if path.is_symlink() or not (path.is_file() or path.is_dir()): raise ValueError('Existing special files require manual migration')
    flags, extent, nextents, previous, cow, padding = attributes(path)
    if previous not in [0, identifier]: raise ValueError('File belongs to another project')
    if path.is_file() and path.stat().st_nlink > 1: raise ValueError('Existing hard links require manual migration')
    if path.is_dir(): flags |= INHERIT
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try: fcntl.ioctl(fd, FSSET, struct.pack('=IIIII8s', flags, extent, nextents, identifier, cow, padding))
    finally: os.close(fd)


def quota(operation, identifier, value):
    # quotactl_fd (Linux >= 5.14) operates on a directory descriptor, so helper
    # pods need no access to host block devices or host PID/network namespaces.
    if platform.machine() not in ['aarch64', 'x86_64']: raise RuntimeError('Unsupported syscall architecture')
    libc = ctypes.CDLL(None, use_errno=True); libc.syscall.restype = ctypes.c_long
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        result = libc.syscall(ctypes.c_long(443), ctypes.c_int(fd), ctypes.c_int((operation << 8) | 2), ctypes.c_int(identifier), ctypes.byref(value))
        if result != 0:
            code = ctypes.get_errno(); raise OSError(code, os.strerror(code))
    finally: os.close(fd)


def get_quota(identifier):
    value = Dqblk(); quota(0x800007, identifier, value); return value


def set_limits(identifier, size, inodes):
    value = Dqblk(); value.bhard = (size + 1023) // 1024; value.ihard = inodes; value.valid = 5
    quota(0x800008, identifier, value)


def apply(value, size=HARD_BYTES, inode_limit=HARD_INODES):
    path = checked_path(value); identifier = project_id(path)
    fmt = ctypes.c_uint32(); quota(0x800004, 0, fmt)
    for sibling in ROOT.iterdir():
        if sibling != path and sibling.is_dir() and not sibling.is_symlink() and attributes(sibling)[3] == identifier:
            raise ValueError('Project ID collision; refusing shared accounting')
    existing = path.exists()
    if existing and not path.is_dir(): raise ValueError('PVC path is not a directory')
    usage = get_quota(identifier)
    if not existing and (usage.space or usage.inodes): raise ValueError('Project has outstanding allocations')
    entries = [path, *path.rglob('*')] if existing else []
    if sum(entry.lstat().st_blocks * 512 for entry in entries) > size or len(entries) > inode_limit:
        raise ValueError('Existing data exceeds the proposed quota')
    if not existing: path.mkdir(mode=0o700)
    set_limits(identifier, size, inode_limit)
    for entry in [path, *path.rglob('*')]: attach(entry, identifier)
    if not existing: os.chmod(path, 0o770)
    actual = get_quota(identifier)
    if actual.bhard != (size + 1023) // 1024 or actual.ihard != inode_limit or attributes(path)[3] != identifier:
        raise RuntimeError('Quota verification failed')
    return {'projectId': identifier, 'hardBytes': size, 'hardInodes': inode_limit, 'usedBytes': actual.space, 'usedInodes': actual.inodes}


def destroy(value):
    path = checked_path(value); identifier = project_id(path)
    if path.exists():
        if attributes(path)[3] != identifier: raise ValueError('Project ownership mismatch; refusing deletion')
        if not shutil.rmtree.avoids_symlink_attacks: raise RuntimeError('Safe directory removal is unavailable')
        shutil.rmtree(path)
    usage = get_quota(identifier)
    if usage.space or usage.inodes: raise RuntimeError('Open allocations remain; quota is retained')
    set_limits(identifier, 0, 0)
    return {'projectId': identifier, 'removed': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p', required=True)
    parser.add_argument('-s', type=int, default=HARD_BYTES)
    parser.add_argument('-m', default='Filesystem')
    parser.add_argument('-a', choices=['create', 'delete'], required=True)
    args = parser.parse_args()
    if args.m != 'Filesystem' or args.s != HARD_BYTES: parser.error('Only the 1GiB user Filesystem profile is supported')
    print(json.dumps(apply(args.p) if args.a == 'create' else destroy(args.p)), flush=True)


if __name__ == '__main__': main()
