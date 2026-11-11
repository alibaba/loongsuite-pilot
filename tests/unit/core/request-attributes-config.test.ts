import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../../src/core/config-loader.js';

describe('request attribute configuration', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-attribute-config-'));
    file = path.join(dir, 'config.json');
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', file);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', dir);
    vi.stubEnv('LOONGSUITE_PILOT_UPSTREAM_LINK', '');
    vi.stubEnv('LOONGSUITE_PILOT_REQUEST_ATTRIBUTES', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('defaults both independent features to disabled', async () => {
    fs.writeFileSync(file, '{}');
    const config = await loadConfig();
    expect(config.requestAttributes?.enabled).toBe(false);
    expect(config.upstreamLink.enabled).toBe(false);
  });

  it('enables attribute matching from config without enabling upstream Trace linking', async () => {
    fs.writeFileSync(file, JSON.stringify({ requestAttributes: { enabled: true } }));
    const config = await loadConfig();
    expect(config.requestAttributes?.enabled).toBe(true);
    expect(config.upstreamLink.enabled).toBe(false);
  });

  it('preserves a Trace-only config without implicitly enabling request attributes', async () => {
    fs.writeFileSync(file, JSON.stringify({ upstreamLink: { enabled: true } }));
    const config = await loadConfig();
    expect(config.upstreamLink.enabled).toBe(true);
    expect(config.requestAttributes?.enabled).toBe(false);
  });

  it.each(['true', '1'])('environment value %s overrides a disabled config', async value => {
    fs.writeFileSync(file, JSON.stringify({ requestAttributes: { enabled: false } }));
    vi.stubEnv('LOONGSUITE_PILOT_REQUEST_ATTRIBUTES', value);
    expect((await loadConfig()).requestAttributes?.enabled).toBe(true);
  });

  it.each(['false', '0'])('environment value %s overrides an enabled config', async value => {
    fs.writeFileSync(file, JSON.stringify({ requestAttributes: { enabled: true } }));
    vi.stubEnv('LOONGSUITE_PILOT_REQUEST_ATTRIBUTES', value);
    expect((await loadConfig()).requestAttributes?.enabled).toBe(false);
  });
});
