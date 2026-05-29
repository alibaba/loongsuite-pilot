import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('installer SLS config output', () => {
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

  it.each(installers)('%s writes user SLS fields without destinationOverride', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('if (slsEndpoint || slsProject || slsLogstore)');
    expect(content).toContain('delete config.sls.destinationOverride');
    expect(content).not.toContain('config.sls.destinationOverride = true');
    expect(content).not.toContain('config.sls.destinationOverride = false');
  });

  it.each(installers)('%s rejects --default-sls-override as unsupported', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('--default-sls-override is no longer supported');
  });
});
