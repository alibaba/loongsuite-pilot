#!/usr/bin/env python3
"""Fetch pinned build-only Boa sources; installed Pilot does not use Python."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import time
import urllib.request


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def tree_hash(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('dependency cache must not contain symlinks')
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode('utf-8'))
            digest.update(b'\0')
            digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def prepare(root, spec, offline):
    # Keep sources outside target: rust-cache may clean it before and after builds.
    cache = root / '.build' / 'rust-deps'
    cache.mkdir(parents=True, exist_ok=True)
    archives = root / '.build' / 'rust-archives'
    archives.mkdir(parents=True, exist_ok=True)
    folder = '{}-{}'.format(spec['crate'], spec['version'])
    destination = cache / folder
    stamp = cache / (folder + '.json')
    recipe = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
    if destination.is_dir() and stamp.is_file():
        saved = json.loads(stamp.read_text(encoding='utf-8'))
        if saved.get('recipe') == recipe and saved.get('tree') == tree_hash(destination):
            print('{}: verified cache'.format(folder))
            return
    archive = archives / (folder + '.crate')
    if not archive.is_file() or sha256(archive) != spec['sha256']:
        if offline:
            raise ValueError('{}: verified archive is unavailable offline'.format(folder))
        temporary = archives / (folder + '.part')
        try:
            request = urllib.request.Request(spec['url'], headers={'User-Agent': 'pilot-build'})
            with urllib.request.urlopen(request, timeout=30) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, 64 * 1024)
            if sha256(temporary) != spec['sha256']:
                raise ValueError('{}: official archive SHA-256 mismatch'.format(folder))
            os.replace(str(temporary), str(archive))
        finally:
            if temporary.exists():
                temporary.unlink()
    with tempfile.TemporaryDirectory(prefix='.extract-', dir=str(cache)) as staging:
        with tarfile.open(str(archive), 'r:gz') as source:
            members = source.getmembers()
            for member in members:
                parts = member.name.split('/')
                if parts[0] != folder or '..' in parts or not (member.isfile() or member.isdir()):
                    raise ValueError('unsafe path or file type in dependency archive')
            source.extractall(staging, members=members)
        prepared = Path(staging) / folder
        manifest = prepared / 'Cargo.toml'
        contents = manifest.read_text(encoding='utf-8')
        old = '[dependencies.{}]\nversion = "{}"'.format(spec['dependency'], spec['old_requirement'])
        new = '[dependencies.{}]\nversion = "{}"'.format(spec['dependency'], spec['new_requirement'])
        if contents.count(old) != 1:
            raise ValueError('{}: pinned manifest no longer matches the patch'.format(folder))
        manifest.write_text(contents.replace(old, new), encoding='utf-8')
        digest = tree_hash(prepared)
        if destination.exists():
            shutil.rmtree(str(destination))
        os.replace(str(prepared), str(destination))
        temporary_stamp = stamp.with_suffix('.part')
        temporary_stamp.write_text(json.dumps({'recipe': recipe, 'tree': digest}), encoding='utf-8')
        os.replace(str(temporary_stamp), str(stamp))
    print('{}: official source verified; {} {}'.format(folder, spec['dependency'], spec['new_requirement']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='use previously verified sources or archives only')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    specs = json.loads((Path(__file__).with_name('rust-dependencies.json')).read_text(encoding='utf-8'))
    started = time.monotonic()
    for spec in specs:
        prepare(root, spec, args.offline)
    print('Rust build dependencies ready in {:.2f}s'.format(time.monotonic() - started))


if __name__ == '__main__':
    main()
