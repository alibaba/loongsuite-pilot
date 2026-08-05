import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('internal installer SLS config output', () => {
  const installers = [
    'deploy/installer.sh',
    'deploy/installer-inner.sh',
  ];

  it.each(installers)('%s does not default to a user-visible SLS destination', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('SLS_ENDPOINT=""');
    expect(content).toContain('SLS_PROJECT=""');
    expect(content).toContain('SLS_LOGSTORE=""');
  });

  it('deploy/installer.sh writes user SLS fields without destinationOverride', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    expect(content).toContain('if (slsEndpoint || slsProject || slsLogstore)');
    expect(content).toContain('delete config.sls.destinationOverride');
    expect(content).not.toContain('config.sls.destinationOverride = true');
    expect(content).not.toContain('config.sls.destinationOverride = false');
  });

  it('deploy/installer-inner.sh writes user SLS to config.json and internal SLS to data_config.json', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-inner.sh'), 'utf8');

    expect(content).toContain('if (slsProject && slsLogstore)');
    expect(content).toContain('config.sls = [userEp]');
    expect(content).toContain('delete config.sls');
    expect(content).toContain('innerDataConfig');
    expect(content).toContain('configs/inner');
    expect(content).not.toContain('config.sls = [userEp, INTERNAL_SLS]');
    expect(content).not.toContain('config.sls.destinationOverride = true');
    expect(content).not.toContain('config.sls.destinationOverride = false');
  });

  it.each(installers)('%s rejects --default-sls-override as unsupported', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('--default-sls-override is no longer supported');
  });

  it('deploy/installer.sh supports mask mode and custom mask types flags', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    expect(content).toContain('MASK_MODE=""');
    expect(content).toContain('MASK_TYPES=""');
    expect(content).toContain('--mask-mode)');
    expect(content).toContain('--mask-types)');
    expect(content).toContain('Unknown mask mode');
    expect(content).not.toContain('Unknown mask type');
    expect(content).toContain('config.mask.mode = maskMode');
    expect(content).toContain('delete config.mask.types');
    expect(content).toContain('const normalizeCsv = value =>');
    expect(content).toContain('if (maskMode) {');
    expect(content).toContain("if (maskMode === 'custom')");
  });
});
