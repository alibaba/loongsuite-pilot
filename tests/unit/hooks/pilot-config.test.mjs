import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pilotConfigPath, readPilotConfig } from '../../../assets/plugins/shared/pilot-config.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('native plugin config reader', () => {
  it.each([
    [undefined, '.loongsuite-pilot/config.json'],
    ['', '.loongsuite-pilot/config.json'],
    ['   ', '.loongsuite-pilot/config.json'],
    ['  ~/pilot-custom.json  ', 'pilot-custom.json'],
  ])('uses the collector config path for override %s', (override, relative) => {
    const env = override === undefined ? {} : { AGENT_DATA_COLLECTION_CONFIG: override };
    expect(pilotConfigPath(env)).toBe(path.join(os.homedir(), relative));
  });

  it('reads a BOM-prefixed custom config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-plugin-config-'));
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, '\uFEFF' + JSON.stringify({
        agents: { opencode: { captureMessageContent: false } },
      }));
      vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', `  ${file}  `);
      expect(pilotConfigPath()).toBe(file);
      expect(readPilotConfig()).toMatchObject({
        agents: { opencode: { captureMessageContent: false } },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
