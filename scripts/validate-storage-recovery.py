"""Rehearse offline full-volume recovery on a disposable loop filesystem only."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile


def run(*command):
    return subprocess.check_output(command, stderr=subprocess.STDOUT, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        print('Plan: clone, CRC-check, change quota features, restore, verify synthetic database on a 256MiB loop filesystem')
        return
    lab = Path(tempfile.mkdtemp(prefix='swkoo-quota-block-lab-', dir='/data'))
    mount = lab / 'mount'; mount.mkdir()
    image = lab / 'isolated.img'; snapshot = lab / 'recovery.partclone.gz'
    loop = None; mounted = False; success = False
    try:
        run('truncate', '-s', '256M', str(image))
        run('mkfs.ext4', '-q', '-F', str(image))
        loop = run('losetup', '--find', '--show', str(image)).strip()
        run('mount', loop, str(mount)); mounted = True
        db = sqlite3.connect(mount / 'synthetic.db')
        db.execute('CREATE TABLE records(value TEXT)'); db.execute("INSERT INTO records VALUES ('recovery rehearsal')"); db.commit(); db.close()
        original = hashlib.sha256((mount / 'synthetic.db').read_bytes()).hexdigest()
        run('umount', str(mount)); mounted = False
        run('e2fsck', '-f', '-p', loop)
        with gzip.open(snapshot, 'wb', compresslevel=1) as output:
            process = subprocess.Popen(['partclone.ext4', '-c', '-s', loop, '-o', '-', '-q', '-L', str(lab/'clone.log')], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            shutil.copyfileobj(process.stdout, output)
            if process.wait(): raise RuntimeError('Clone failed')
        with gzip.open(snapshot, 'rb') as source:
            process = subprocess.Popen(['partclone.chkimg', '-s', '-', '-L', str(lab/'check.log')], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.copyfileobj(source, process.stdin); process.stdin.close()
            if process.wait(): raise RuntimeError('Image CRC validation failed')
        run('tune2fs', '-O', 'project,quota', '-Q', 'prjquota', loop)
        run('e2fsck', '-f', '-p', loop)
        run('mount', '-o', 'prjquota', loop, str(mount)); mounted = True
        (mount/'synthetic.db').write_bytes(b'changed after conversion')
        run('umount', str(mount)); mounted = False
        with gzip.open(snapshot, 'rb') as source:
            process = subprocess.Popen(['partclone.restore', '-s', '-', '-o', loop, '-q', '-L', str(lab/'restore.log')], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.copyfileobj(source, process.stdin); process.stdin.close()
            if process.wait(): raise RuntimeError('Full-volume restore failed')
        run('e2fsck', '-f', '-p', loop)
        features = run('tune2fs', '-l', loop)
        assert ' project ' not in features and ' quota ' not in features, 'Original filesystem features not restored'
        run('mount', '-o', 'ro', loop, str(mount)); mounted = True
        assert hashlib.sha256((mount/'synthetic.db').read_bytes()).hexdigest() == original
        db = sqlite3.connect('file:'+str(mount/'synthetic.db')+'?mode=ro', uri=True)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'; db.close()
        success = True
        print(json.dumps({'ok':True,'imageCRC':'passed','fullBlockRestore':'passed','originalDatabaseHash':'matched','integrity':'ok','originalFilesystemFeatures':'restored'}), flush=True)
    finally:
        if mounted: run('umount', str(mount))
        if loop: run('losetup', '-d', loop)
        if success:
            if lab.parent != Path('/data') or not lab.name.startswith('swkoo-quota-block-lab-'): raise RuntimeError('Unsafe cleanup target')
            shutil.rmtree(lab)
        else: print(json.dumps({'preservedRehearsal':str(lab)}), flush=True)


if __name__ == '__main__': main()
