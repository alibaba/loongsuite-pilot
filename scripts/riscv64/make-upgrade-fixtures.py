#!/usr/bin/env python3
"""Derive local-only upgrade/rollback packages from a real public package."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base', type=Path, required=True)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
manifest = {'base_sha256': hashlib.sha256(args.base.read_bytes()).hexdigest(), 'local_test_only': True, 'packages': {}}
for label, version, commit in [('b', '1.2.1', 'riscv-b'), ('bad', '1.2.99', 'riscv-bad'),
                               ('deps-bad', '1.2.98', 'riscv-deps-bad')]:
    with tempfile.TemporaryDirectory(prefix='pilot-riscv-upgrade-') as temporary:
        root = Path(temporary)
        with tarfile.open(args.base) as archive:
            archive.extractall(root, filter='data')
        children = [p for p in root.iterdir() if p.is_dir() and (p / 'package.json').is_file()]
        if len(children) != 1:
            raise ValueError('Expected exactly one package root')
        package = children[0]
        metadata = json.loads((package / 'package.json').read_text())
        metadata['version'] = version
        if label in ('bad', 'deps-bad'):
            # A complete JS payload with deliberately failing startup. Avoid a
            # second native build just to exercise the public rollback branch.
            metadata['dependencies'] = {}
            metadata['devDependencies'] = {}
            metadata['optionalDependencies'] = {}
            lock = {'name': metadata['name'], 'version': version, 'lockfileVersion': 3,
                    'requires': True, 'packages': {'': {'name': metadata['name'], 'version': version}}}
            if label == 'bad':
                (package / 'dist/index.js').write_text("import './native-deps-guard.cjs';\nthrow new Error('riscv64 injected upgrade startup failure');\n")
            else:
                # npm may accept a missing directory as a dangling local link.
                # A missing tarball must actually be read during installation.
                metadata['dependencies'] = {'pilot-deliberately-missing': 'file:./deliberately-missing-package.tgz'}
                lock['packages']['']['dependencies'] = metadata['dependencies']
        else:
            lock = json.loads((package / 'package-lock.json').read_text())
            lock['version'] = version
            lock['packages']['']['version'] = version
        (package / 'package.json').write_text(json.dumps(metadata, indent=2)+'\n')
        (package / 'package-lock.json').write_text(json.dumps(lock, indent=2)+'\n')
        (package / 'VERSION').write_text(f'version={version}\ngit_commit={commit}\ngit_branch=riscv64-local-acceptance\n')
        target = args.output_dir / f'pilot-riscv64-{label}.tar.gz'
        with tarfile.open(target, 'w:gz') as archive:
            archive.add(package, arcname='loongsuite-pilot')
        manifest['packages'][label] = {'path': str(target.resolve()), 'version': version, 'git_commit': commit,
                                      'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
(args.output_dir / 'upgrade-fixtures.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps(manifest, indent=2))
