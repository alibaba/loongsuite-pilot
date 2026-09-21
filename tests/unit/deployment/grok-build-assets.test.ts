import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  areGrokBuildHookAssetsHealthy,
  GROK_BUILD_HOOK_ASSETS,
  resolveGrokBuildHookSourceRoot,
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

  it('prefers the packaged assets/hooks tree when both layouts exist', async () => {
    expect(await resolveGrokBuildHookSourceRoot(pilotDir)).toBe(
      path.join(pilotDir, 'assets', 'hooks'),
    );
  });
});

describe('Grok Build hook runtime integrity on the flattened K8s layout', () => {
  let root: string;
  let payloadRoot: string;

  async function seedFlattenedHooks(dir: string): Promise<void> {
    for (const relativePath of GROK_BUILD_HOOK_ASSETS) {
      const target = path.join(dir, 'hooks', relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `flat:${relativePath}\n`, {
        mode: relativePath.endsWith('.sh') ? 0o755 : 0o644,
      });
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-k8s-assets-'));
    payloadRoot = path.join(root, 'mnt-pilot');
    await seedFlattenedHooks(payloadRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('treats coinciding payload-root dataDir as healthy without assets/hooks', async () => {
    expect(await resolveGrokBuildHookSourceRoot(payloadRoot)).toBe(
      path.join(payloadRoot, 'hooks'),
    );
    expect(await areGrokBuildHookAssetsHealthy(payloadRoot, payloadRoot)).toBe(true);
    await expect(restoreGrokBuildHookAssets(payloadRoot, payloadRoot)).resolves.toBeUndefined();
    expect(await areGrokBuildHookAssetsHealthy(payloadRoot, payloadRoot)).toBe(true);
  });

  it('restores flattened payload hooks into a split dataDir', async () => {
    const dataDir = path.join(root, 'home-pilot');
    expect(await areGrokBuildHookAssetsHealthy(payloadRoot, dataDir)).toBe(false);
    await restoreGrokBuildHookAssets(payloadRoot, dataDir);
    expect(await areGrokBuildHookAssetsHealthy(payloadRoot, dataDir)).toBe(true);
    const shell = path.join(dataDir, 'hooks', 'grok-build-loongsuite-pilot-hook.sh');
    expect(await fs.readFile(shell, 'utf8')).toBe('flat:grok-build-loongsuite-pilot-hook.sh\n');
  });
});
