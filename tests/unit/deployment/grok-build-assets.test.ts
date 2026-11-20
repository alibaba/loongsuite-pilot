import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  areGrokBuildHookAssetsHealthy,
  GROK_BUILD_HOOK_ASSETS,
  restoreGrokBuildHookAssets,
} from '../../../src/deployment/grok-build-assets.js';

describe('Grok Build hook runtime integrity', () => {
  let root: string;
  let pilotDir: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-assets-'));
    pilotDir = path.join(root, 'pilot');
    dataDir = path.join(root, 'data');
    for (const relativePath of GROK_BUILD_HOOK_ASSETS) {
      const source = path.join(pilotDir, 'assets', 'hooks', relativePath);
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, `asset:${relativePath}\n`, {
        mode: relativePath.endsWith('.sh') ? 0o755 : 0o644,
      });
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('atomically restores all exact Grok dependencies and shell execution permission', async () => {
    expect(await areGrokBuildHookAssetsHealthy(pilotDir, dataDir)).toBe(false);
    await restoreGrokBuildHookAssets(pilotDir, dataDir);
    expect(await areGrokBuildHookAssetsHealthy(pilotDir, dataDir)).toBe(true);

    const shell = path.join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh');
    if (process.platform !== 'win32') {
      expect((await fs.stat(shell)).mode & 0o111).not.toBe(0);
    }

    const processor = path.join(dataDir, 'hooks', 'grok-build-hook-processor.mjs');
    await fs.writeFile(processor, 'corrupt');
    expect(await areGrokBuildHookAssetsHealthy(pilotDir, dataDir)).toBe(false);
    await restoreGrokBuildHookAssets(pilotDir, dataDir);
    expect(await areGrokBuildHookAssetsHealthy(pilotDir, dataDir)).toBe(true);
  });
});
