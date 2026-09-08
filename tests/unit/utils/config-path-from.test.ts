import { describe, expect, it, vi, afterEach } from 'vitest';
import * as os from 'node:os';
import { configJsonPath, configJsonPathFrom } from '../../../src/utils/data-dir.js';
import { resolveHome } from '../../../src/utils/fs-utils.js';

afterEach(() => vi.unstubAllEnvs());
describe('shared config path resolution', () => {
  it.each(['~\\pilot\\config.json', '~/pilot/config.json'])('expands Windows %s using USERPROFILE, not HOME', value => {
    const env = { HOME: 'C:\\wrong', USERPROFILE: 'C:\\Users\\agent', AGENT_DATA_COLLECTION_CONFIG: value };
    expect(configJsonPathFrom(env, { platform: 'win32' })).toBe('C:\\Users\\agent\\pilot\\config.json');
  });
  it('uses system home when the platform home variable is absent', () => {
    expect(configJsonPathFrom({}, { platform: 'linux', homedir: () => '/system/user' }))
      .toBe('/system/user/.loongsuite-pilot/config.json');
    expect(configJsonPathFrom({ HOME: 'wrong' }, { platform: 'win32', homedir: () => 'C:\\system' }))
      .toBe('C:\\system\\.loongsuite-pilot\\config.json');
  });
  it.each(['', '   ', undefined])('shares the default for empty overrides (%s)', override => {
    expect(configJsonPathFrom({ HOME: '/test', AGENT_DATA_COLLECTION_CONFIG: override }, { platform: 'linux' }))
      .toBe('/test/.loongsuite-pilot/config.json');
  });
  it('preserves absolute paths and resolves a bare tilde consistently', () => {
    expect(configJsonPathFrom({ AGENT_DATA_COLLECTION_CONFIG: ' /custom/config.json ' })).toBe('/custom/config.json');
    expect(resolveHome('~', { env: { HOME: '/test' }, platform: 'linux' })).toBe('/test');
    expect(resolveHome('~')).toBe(os.homedir());
  });
  it('uses exactly the same path as the live config loader', () => {
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', '~/pilot/config.json');
    expect(configJsonPathFrom(process.env)).toBe(configJsonPath());
    expect(configJsonPath()).toBe(resolveHome('~/pilot/config.json'));
  });
});
