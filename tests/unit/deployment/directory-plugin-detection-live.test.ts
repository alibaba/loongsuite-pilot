import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { DirectoryPluginStrategy } from '../../../src/deployment/directory-plugin-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

describe('directory plugin detection with a stray Hermes home', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks activation when the home exists but the executable is missing', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-detection-'));
    const hermesHome = path.join(root, '.hermes');
    const sourceDir = path.join(root, 'source');
    const missingCli = path.join(root, 'missing-hermes-cli');
    await fs.mkdir(hermesHome);
    await fs.mkdir(sourceDir);
    await fs.writeFile(path.join(sourceDir, 'plugin.py'), '# test plugin\n');
    const def: AgentDefinition = {
      id: 'hermes-agent',
      displayName: 'Hermes Agent',
      deployMode: 'directory-plugin',
      detection: { paths: [hermesHome], commands: ['missing-hermes-cli'] },
      directoryPlugin: {
        sourceDir,
        targetDir: path.join(hermesHome, 'plugins', 'loongsuite-pilot'),
        activation: {
          command: missingCli,
          probeArgs: ['plugins', 'enable', '--help'],
          enableArgs: ['plugins', 'enable', 'loongsuite-pilot'],
        },
      },
    };
    const strategy = new DirectoryPluginStrategy(root);

    // The old generic OR detection sees the stray directory as an installation.
    expect(await detectAgent(def.detection)).toBe(true);
    // The directory-plugin gate now checks the executable it would spawn.
    expect(await strategy.detect(def)).toBe(false);
    // Forcing deployment past that gate reproduces the reported ENOENT failure.
    const forced = await strategy.deploy(def);
    expect(forced.success).toBe(false);
    expect(forced.error).toContain('ENOENT');

    const missingFingerprint = await strategy.repairInputsFingerprint(def);
    await fs.writeFile(missingCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await strategy.detect(def)).toBe(true);
    const installedFingerprint = await strategy.repairInputsFingerprint(def);
    expect(installedFingerprint).not.toBe(missingFingerprint);
    await fs.writeFile(path.join(sourceDir, 'plugin.py'), '# updated plugin\n');
    expect(await strategy.repairInputsFingerprint(def)).not.toBe(installedFingerprint);
  });
});
