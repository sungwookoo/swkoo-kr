"""Isolated ext4 project-quota rehearsal. Plans by default; no production paths."""
import argparse
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode: raise RuntimeError(result.stderr.strip())
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--code', type=Path, default=Path(__file__).resolve().parent.parent / 'deploy/storage/quota.py')
    args = parser.parse_args()
    print(json.dumps({'execute': args.execute, 'isolatedImageGiB': 3, 'productionDiskModified': False}), flush=True)
    if not args.execute: return
    spec = importlib.util.spec_from_file_location('quota', args.code); quota = importlib.util.module_from_spec(spec); spec.loader.exec_module(quota)
    lab = Path(tempfile.mkdtemp(prefix='swkoo-quota-lab-', dir='/data')); os.chmod(lab, 0o711)
    image, mount = lab / 'isolated.img', lab / 'mount'; mount.mkdir()
    mounted = False
    try:
        run('truncate', '-s', '3G', str(image)); run('mkfs.ext4', '-q', '-F', str(image)); run('tune2fs', '-O', 'project,quota', '-Q', 'prjquota', str(image))
        checked = subprocess.run(['e2fsck', '-f', '-p', str(image)], capture_output=True, text=True)
        if checked.returncode not in [0, 1]: raise RuntimeError('Isolated filesystem check failed: ' + checked.stdout + checked.stderr)
        run('mount', '-o', 'loop,prjquota', str(image), str(mount)); mounted = True
        quota.ROOT = mount / 'storage'; quota.ROOT.mkdir(mode=0o711)
        paths = [quota.ROOT / f'pvc-0000000{i}-0000-4000-8000-000000000000_user-swkoo-quota-lab_{name}' for i, name in enumerate(['a', 'b', 'c'], 1)]
        paths[0].mkdir(); dbpath = paths[0] / 'app.db'
        connection = sqlite3.connect(dbpath); connection.execute('CREATE TABLE records(value TEXT)'); connection.execute("INSERT INTO records VALUES ('synthetic')"); connection.commit(); connection.close()
        for path in paths[:2]:
            quota.apply(str(path)); os.chown(path, 1000, 1000)
        os.chown(dbpath, 1000, 1000)
        # Run the writer with the same unprivileged UID as deployed apps.
        program = """
import ctypes,errno,fcntl,json,os,sqlite3,struct,sys
from pathlib import Path
# Stack the exact additional ioctl restrictions; the container test also
# exercises the complete exported RuntimeDefault + deny profile.
class Compare(ctypes.Structure):
 _fields_=[('index',ctypes.c_uint),('op',ctypes.c_int),('a',ctypes.c_uint64),('b',ctypes.c_uint64)]
lib=ctypes.CDLL('libseccomp.so.2'); lib.seccomp_init.restype=ctypes.c_void_p
lib.seccomp_rule_add_array.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint,ctypes.POINTER(Compare)]
lib.seccomp_load.argtypes=[ctypes.c_void_p]; lib.seccomp_release.argtypes=[ctypes.c_void_p]
ctx=lib.seccomp_init(0x7fff0000); ioctl=lib.seccomp_syscall_resolve_name(b'ioctl')
for request in [0x401c5820,0x40086602,0x40046602]:
 cmp=Compare(1,7,0xffffffff,request); assert lib.seccomp_rule_add_array(ctx,0x50000|13,ioctl,1,ctypes.byref(cmp))==0
assert lib.seccomp_load(ctx)==0; lib.seccomp_release(ctx)
a,b=map(Path,sys.argv[1:]); block=b'x'*(1024*1024)
fd=os.open(a/'fill',os.O_WRONLY|os.O_CREAT,0o600)
try:
 for i in range(1100): os.write(fd,block)
 raise RuntimeError('1GiB quota did not refuse the write')
except OSError as error:
 assert error.errno==errno.EDQUOT,error
finally: os.close(fd)
with (b/'control').open('wb') as f: f.write(block)
fd=os.open(a,os.O_RDONLY); data=bytearray(28); fcntl.ioctl(fd,0x801c581f,data); fields=list(struct.unpack('=IIIII8s',data)); fields[3]=0
try:
 fcntl.ioctl(fd,0x401c5820,struct.pack('=IIIII8s',*fields)); raise RuntimeError('App escaped its project')
except OSError as error: assert error.errno==errno.EACCES,error
finally: os.close(fd)
db=sqlite3.connect(a/'app.db'); assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; assert db.execute('SELECT count(*) FROM records').fetchone()[0]==1; db.close()
print(json.dumps({'hardByteLimit':'EDQUOT','otherAppWrite':True,'unprivilegedEscape':'EACCES','existingDatabase':'ok'}))
"""
        def drop_uid(): os.setgid(1000); os.setuid(1000)
        result = subprocess.run(['python3', '-c', program, str(paths[0]), str(paths[1])], capture_output=True, text=True, preexec_fn=drop_uid)
        if result.returncode: raise RuntimeError(result.stderr.strip())
        print(result.stdout.strip(), flush=True)
        quota.apply(str(paths[2]), inode_limit=64); os.chown(paths[2], 1000, 1000)
        inode_program = "import os,sys,errno; from pathlib import Path; p=Path(sys.argv[1]);\ntry:\n for i in range(100): (p/str(i)).touch()\n raise RuntimeError('Inode limit did not refuse the write')\nexcept OSError as e: assert e.errno==errno.EDQUOT"
        subprocess.run(['python3', '-c', inode_program, str(paths[2])], check=True, preexec_fn=drop_uid)
        run('sync'); run('umount', str(mount)); mounted = False
        run('mount', '-o', 'loop,prjquota', str(image), str(mount)); mounted = True
        assert quota.get_quota(quota.project_id(paths[0])).bhard == 1024 ** 2
        assert quota.attributes(paths[0])[3] == quota.project_id(paths[0])
        for path in paths:
            quota.destroy(str(path)); usage = quota.get_quota(quota.project_id(path))
            assert not any([usage.space, usage.inodes, usage.bhard, usage.ihard])
        unprotected = lab / 'unprotected'; unprotected.mkdir(); quota.ROOT = unprotected
        target = unprotected / paths[0].name
        try: quota.apply(str(target)); raise RuntimeError('Missing enforcement did not block setup')
        except OSError: assert not target.exists()
        print(json.dumps({'ok': True, 'inodeLimit':'EDQUOT', 'remountPreservesQuota':True, 'deleteReclaimsQuota':True, 'missingEnforcementFailsClosed':True}), flush=True)
    finally:
        if mounted: run('umount', str(mount))
        if lab.parent != Path('/data') or not lab.name.startswith('swkoo-quota-lab-') or lab.is_symlink(): raise RuntimeError('Unsafe cleanup path')
        shutil.rmtree(lab)


if __name__ == '__main__': main()
