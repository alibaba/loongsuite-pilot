import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectFileManifest } from '../../../scripts/hook-asset-manifest.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hook-manifest-'));
  roots.push(root);
  await mkdir(path.join(root, 'shared'), { recursive: true });
  await writeFile(path.join(root, 'hook.sh'), 'sh\n');
  await writeFile(path.join(root, 'hook.ps1'), 'ps1\n');
  await writeFile(path.join(root, 'processor.mjs'), 'mjs\n');
  await writeFile(path.join(root, 'shared', 'common.ps1'), 'common\n');
  await writeFile(path.join(root, 'README.md'), 'readme\n');
  return root;
}

describe('collectFileManifest', () => {
  it('keeps only paths matched by the pattern', async () => {
    const root = await fixture();

    const manifest = await collectFileManifest(root, new Set(), /\.(sh|ps1)$/);

    expect(manifest).toEqual({
      'hook.ps1': hash('ps1\n'),
      'hook.sh': hash('sh\n'),
      'shared/common.ps1': hash('common\n'),
    });
  });

  it('drops the paths named in skip', async () => {
    const root = await fixture();

    const manifest = await collectFileManifest(root, new Set(['hook.ps1', 'README.md']));

    expect(Object.keys(manifest).sort()).toEqual([
      'hook.sh',
      'processor.mjs',
      'shared/common.ps1',
    ]);
  });
});
