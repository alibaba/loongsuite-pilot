import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('installer SLS config output', () => {
  const installers = [
    'deploy/loongsuite-pilot-installer.sh',
    'deploy/loongsuite-pilot-installer-inner.sh',
  ];

  it.each(installers)('%s does not default to a user-visible SLS destination', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('SLS_ENDPOINT=""');
    expect(content).toContain('SLS_PROJECT=""');
    expect(content).toContain('SLS_LOGSTORE=""');
  });

  it.each(installers)('%s marks explicit SLS flag values as operator overrides', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('if (slsEndpoint || slsProject || slsLogstore)');
    expect(content).toContain('config.sls.destinationOverride = true;');
  });
});
