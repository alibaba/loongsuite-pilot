import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { loadConfig } from '../../../src/core/config-loader.js';
import {
  DEFAULT_DATA_DIR,
  configJsonPath,
  pickDataDir,
  readConfigFileDataDir,
  resolveDataDir,
} from '../../../src/utils/data-dir.js';
import { resolveHome } from '../../../src/utils/fs-utils.js';

/**
 * One precedence chain, three consumers: loadConfig() (the daemon),
 * inject-hooks.ts, and k8s-preload.cjs (which mirrors it in plain CJS — pinned
 * separately in k8s-preload-coordination.test.mjs). This test pins the first
 * two to each other: if loadConfig() ever grows a new dataDir source that
 * resolveDataDir() misses, the preload's symlinks/sentinels/lock and the
 * injected hookCommand strings land in a different directory than the daemon
 * reads, isHookInstalled() sees every hook as "not installed", and the daemon
 * appends duplicates — every event fires twice, silently.
 */

let tmp: string;

function setConfig(contents: string | null, name = 'config.json'): string {
  const p = path.join(tmp, name);
  if (contents !== null) fs.writeFileSync(p, contents, 'utf8');
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', p);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dir-parity-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Both sides resolve from the same env state; they must land identically. */
async function assertParity(): Promise<void> {
  const config = await loadConfig();
  // The daemon resolves the raw config value at use time (orchestrator); the
  // eager path resolves up front. Both views of the SAME chain must agree.
  expect(resolveDataDir()).toBe(resolveHome(config.dataDir || DEFAULT_DATA_DIR));
}

describe('data-dir precedence parity: loadConfig vs resolveDataDir', () => {
  it('falls back to the default when neither env nor config file says anything', async () => {
    setConfig(JSON.stringify({ sls: { enabled: true } }));
    await assertParity();
    expect(resolveDataDir()).toBe(resolveHome(DEFAULT_DATA_DIR));
  });

  it('reads the config-file dataDir when the env var is absent', async () => {
    const custom = path.join(tmp, 'from-config');
    setConfig(JSON.stringify({ dataDir: custom }));
    await assertParity();
    expect(resolveDataDir()).toBe(custom);
  });

  it('lets the env var win over the config-file dataDir', async () => {
    setConfig(JSON.stringify({ dataDir: path.join(tmp, 'from-config') }));
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', path.join(tmp, 'from-env'));
    await assertParity();
    expect(resolveDataDir()).toBe(path.join(tmp, 'from-env'));
  });

  it('expands ~ in the config-file dataDir on both sides', async () => {
    setConfig(JSON.stringify({ dataDir: '~/some-dir' }));
    await assertParity();
    expect(resolveDataDir()).toBe(path.join(os.homedir(), 'some-dir'));
  });

  it('treats an empty config-file dataDir as unset on both sides', async () => {
    // Historical quirk, pinned deliberately: `?? ` would keep '' and the
    // orchestrator's `|| DEFAULT` turned it into the default only later in the
    // chain — the shared pickDataDir() collapses both views to one answer.
    setConfig(JSON.stringify({ dataDir: '' }));
    await assertParity();
    expect(resolveDataDir()).toBe(resolveHome(DEFAULT_DATA_DIR));
  });

  it('survives an unreadable config file (both sides fall through)', async () => {
    setConfig(null); // AGENT_DATA_COLLECTION_CONFIG points at a missing file
    await assertParity();
    expect(resolveDataDir()).toBe(resolveHome(DEFAULT_DATA_DIR));
  });

  it('survives an unparsable config file', async () => {
    setConfig('this is not json');
    await assertParity();
    expect(resolveDataDir()).toBe(resolveHome(DEFAULT_DATA_DIR));
  });

  it('strips a leading BOM exactly like readJsonFile does', async () => {
    // Windows writes BOMs routinely; JSON.parse rejects them. loadConfig()
    // reads via readJsonFile() which strips; resolveDataDir() must too, or the
    // two diverge on exactly the machines that produce BOMs.
    const custom = path.join(tmp, 'bom-dir');
    setConfig('\uFEFF' + JSON.stringify({ dataDir: custom }));
    expect(readConfigFileDataDir()).toBe(custom);
    await assertParity();
    expect(resolveDataDir()).toBe(custom);
  });
});

describe('win32 env padding parity', () => {
  // Windows environment variables routinely carry leading/trailing padding.
  // loadConfig() reads LOONGSUITE_PILOT_DATA_DIR through env(), which trims on
  // win32; the eager path used to read the raw, untrimmed process.env, so the
  // two resolved different directories and the daemon re-appended hooks. This
  // pins both consumers to the same trimmed answer.
  it('loadConfig and resolveDataDir agree on a padded LOONGSUITE_PILOT_DATA_DIR', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      setConfig(JSON.stringify({ sls: { enabled: true } }));
      const dir = path.join(tmp, 'padded-dir');
      vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', `  ${dir}  `);
      await assertParity();
      // The resolved dir must be the trimmed value — any surviving padding means
      // the two sides diverged again.
      expect(resolveDataDir()).toBe(resolveHome(dir));
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe('pickDataDir', () => {
  it.each([
    ['/explicit', '/from/file', '/explicit'],
    [undefined, '/from/file', '/from/file'],
    [undefined, undefined, DEFAULT_DATA_DIR],
    ['', '/from/file', '/from/file'],
    ['', '', DEFAULT_DATA_DIR],
    ['/explicit', undefined, '/explicit'],
  ])('(%s, %s) -> %s', (explicit, fileDataDir, expected) => {
    expect(pickDataDir(explicit, fileDataDir)).toBe(expected);
  });
});

describe('configJsonPath', () => {
  it('uses AGENT_DATA_COLLECTION_CONFIG when set', () => {
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(tmp, 'elsewhere.json'));
    expect(configJsonPath()).toBe(path.join(tmp, 'elsewhere.json'));
  });

  it('treats a whitespace-only value as unset', () => {
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', '   ');
    expect(configJsonPath()).toBe(resolveHome(`${DEFAULT_DATA_DIR}/config.json`));
  });
});
