import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PluginProbeStrategy } from '../../../../src/deployment/plugin-probe-strategy.js';
import type { AgentDefinition } from '../../../../src/types/index.js';

vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn().mockResolvedValue(true),
}));

describe('PluginProbeStrategy — builtin source (Trae)', () => {
  let tmpDir: string;
  let dataDir: string;
  let pilotDir: string;
  let strategy: PluginProbeStrategy;
  let realHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-builtin-'));
    dataDir = path.join(tmpDir, 'data');
    pilotDir = path.join(tmpDir, 'pilot');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(pilotDir, { recursive: true });

    // Sandbox HOME so the real install.sh (if reached) cannot edit rc files
    // outside the test tmpdir.
    realHome = process.env.HOME;
    process.env.HOME = tmpDir;

    strategy = new PluginProbeStrategy(dataDir, pilotDir);
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeTraeDef(sourceDir: string, destDir: string): AgentDefinition {
    return {
      id: 'trae',
      displayName: 'Trae',
      deployMode: 'plugin-probe',
      detection: { paths: [], commands: [] },
      pluginProbe: {
        source: { type: 'builtin', sourceDir, destDir },
        mountType: 'env-inject',
      },
    };
  }

  it('deploy() returns success:true and copies builtin sourceDir contents into destDir', async () => {
    const sourceDir = path.join(pilotDir, 'assets', 'plugins', 'trae');
    const destDir = path.join(dataDir, 'plugins', 'trae');
    await fs.mkdir(path.join(sourceDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'probe.mjs'), '// probe\n');
    // Minimal install.sh — touches a marker so we can prove it ran after copy.
    const installMarker = path.join(tmpDir, 'install-ran');
    await fs.writeFile(
      path.join(sourceDir, 'scripts', 'install.sh'),
      `#!/usr/bin/env bash\ntouch "${installMarker}"\nexit 0\n`,
    );

    const result = await strategy.deploy(makeTraeDef(sourceDir, destDir));

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Source files were copied verbatim into destDir.
    await expect(fs.readFile(path.join(destDir, 'probe.mjs'), 'utf-8')).resolves.toBe('// probe\n');
    await expect(fs.readFile(path.join(destDir, 'scripts', 'install.sh'), 'utf-8')).resolves.toContain('touch');

    // Install script ran from the copied bundle.
    await expect(fs.stat(installMarker)).resolves.toBeTruthy();
  });

  it('deploy() returns failure when builtin sourceDir is missing', async () => {
    const destDir = path.join(dataDir, 'plugins', 'trae');
    const missingSourceDir = path.join(pilotDir, 'assets', 'plugins', 'trae-missing');

    const result = await strategy.deploy(makeTraeDef(missingSourceDir, destDir));

    expect(result.success).toBe(false);
    expect(result.error).toBe('failed to acquire package');
    await expect(fs.stat(destDir)).rejects.toThrow();
  });

  it('computeSourceHash returns a stable hash for builtin sourceDir across calls', async () => {
    const sourceDir = path.join(pilotDir, 'assets', 'plugins', 'trae');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'probe.mjs'), 'abc\n');

    const h1 = await strategy.computeSourceHash(undefined, undefined, sourceDir);
    const h2 = await strategy.computeSourceHash(undefined, undefined, sourceDir);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h2).toBe(h1);

    // Mutating sourceDir contents changes the hash.
    await fs.writeFile(path.join(sourceDir, 'probe.mjs'), 'def\n');
    const h3 = await strategy.computeSourceHash(undefined, undefined, sourceDir);
    expect(h3).not.toBe(h1);
  });

  it('isRemoteOnly returns false for a builtin source (no url / remoteUrl)', () => {
    expect(strategy.isRemoteOnly({ sourceDir: '/x', destDir: '/d' })).toBe(false);
  });
});
