import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentDefinition, DeployedAgentRecord } from '../../../src/types/index.js';

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';
import { DshRuntimeLocator } from '../../../src/deployment/dsh-runtime-locator.js';
import { DshYamlPatchStrategy } from '../../../src/deployment/dsh-yaml-patch-strategy.js';

describe('DshRuntimeLocator', () => {
  let tmpDir: string;
  let procRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-runtime-locator-'));
    procRoot = path.join(tmpDir, 'proc');
    await fs.mkdir(procRoot);
    vi.mocked(detectAgent).mockResolvedValue(false);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeDef(patchPath?: string): AgentDefinition {
    return {
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      deployMode: 'dsh-yaml-patch',
      detection: { paths: ['~/.dsh'], commands: ['dsh'] },
      dshYamlPatch: {
        pluginSource: '/pilot/plugins/dsh/plugin.mjs',
        ...(patchPath === undefined ? {} : { patchPath }),
        entryId: 'loongsuite-pilot-observability',
        marker: 'PILOT-OBSERVABILITY-MANAGED',
      },
    };
  }

  function locator(env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux') {
    return new DshRuntimeLocator({
      procRoot,
      platform,
      env,
      cwd: () => tmpDir,
      uid: process.getuid?.(),
    });
  }

  async function writeProcess(pid: number, options: {
    home?: string;
    cwd?: string;
    dsh?: boolean;
  }): Promise<void> {
    const processDir = path.join(procRoot, String(pid));
    await fs.mkdir(processDir);
    const script = options.dsh === false
      ? '/code/node_modules/some-other-package/lib/bin.js'
      : '/code/node_modules/@deepseek-ai/dsh/lib/bin.js';
    await fs.writeFile(
      path.join(processDir, 'cmdline'),
      Buffer.from(['node', script, 'web', '--port', '13080', ''].join('\0')),
    );
    await fs.writeFile(
      path.join(processDir, 'environ'),
      Buffer.from([
        'PATH=/usr/bin',
        ...(options.home === undefined ? [] : [`DSH_HOME=${options.home}`]),
        'DEEPSEEK_API_KEY=must-not-be-read-or-logged',
        '',
      ].join('\0')),
    );
    if (options.cwd) await fs.symlink(options.cwd, path.join(processDir, 'cwd'));
  }

  it('uses the Pilot service DSH_HOME without requiring a PATH command or default home', async () => {
    const home = path.join(tmpDir, 'custom-home');
    const target = await locator({ DSH_HOME: home }).locate(makeDef());

    expect(target).toEqual({
      home,
      patchPath: path.join(home, 'cordis.patch.yml'),
      source: 'pilot-env',
    });
    expect(detectAgent).not.toHaveBeenCalled();
  });

  it('discovers a non-standard home from the environment of a running DSH process', async () => {
    const home = path.join(tmpDir, 'runtime-home');
    await writeProcess(321, { home });

    const target = await locator().locate(makeDef());

    expect(target).toEqual({
      home,
      patchPath: path.join(home, 'cordis.patch.yml'),
      source: 'running-process',
      pid: 321,
    });
    expect(detectAgent).not.toHaveBeenCalled();
  });

  it('writes the managed patch to the home discovered from a running DSH process', async () => {
    const home = path.join(tmpDir, 'runtime-home');
    const dataDir = path.join(tmpDir, 'pilot-data');
    const pluginPath = path.join(dataDir, 'plugins', 'dsh', 'plugin.mjs');
    await fs.mkdir(path.dirname(pluginPath), { recursive: true });
    await fs.writeFile(pluginPath, 'export default function apply() {}\n');
    await writeProcess(323, { home });
    const def = makeDef();
    if (!def.dshYamlPatch) throw new Error('test definition is missing dshYamlPatch');
    def.dshYamlPatch.pluginSource = pluginPath;

    const result = await new DshYamlPatchStrategy(dataDir, locator()).deploy(def);

    expect(result.success).toBe(true);
    expect(await fs.readFile(path.join(home, 'cordis.patch.yml'), 'utf-8'))
      .toContain('PILOT-OBSERVABILITY-MANAGED');
    expect(await fs.readFile(path.join(path.dirname(pluginPath), '.collection-enabled'), 'utf-8'))
      .toBe('enabled\n');
  });

  it('resolves a relative process DSH_HOME against that DSH process cwd', async () => {
    if (process.platform === 'win32') return;
    const cwd = path.join(tmpDir, 'dsh-cwd');
    await fs.mkdir(cwd);
    await writeProcess(322, { home: '.state/dsh', cwd });

    const target = await locator().locate(makeDef());

    expect(target?.home).toBe(path.join(cwd, '.state', 'dsh'));
  });

  it('accepts several DSH processes when they use the same home', async () => {
    const home = path.join(tmpDir, 'shared-home');
    await writeProcess(401, { home });
    await writeProcess(402, { home });

    const target = await locator().locate(makeDef());

    expect(target?.home).toBe(home);
    expect(target?.pid).toBe(401);
  });

  it('rejects several distinct running DSH homes instead of choosing one', async () => {
    await writeProcess(501, { home: path.join(tmpDir, 'home-a') });
    await writeProcess(502, { home: path.join(tmpDir, 'home-b') });

    await expect(locator().locate(makeDef())).rejects.toThrow(/ambiguous DSH runtime homes/);
  });

  it('ignores unrelated Node processes and preserves standard detection fallback', async () => {
    await writeProcess(601, { home: path.join(tmpDir, 'unrelated-home'), dsh: false });
    vi.mocked(detectAgent).mockResolvedValue(true);

    const target = await locator().locate(makeDef());

    expect(target).toEqual({
      home: path.join(os.homedir(), '.dsh'),
      patchPath: path.join(os.homedir(), '.dsh', 'cordis.patch.yml'),
      source: 'standard-detection',
    });
  });

  it('keeps persisted lifecycle ownership ahead of changed runtime discovery', async () => {
    const ownedPath = path.join(tmpDir, 'owned-home', 'cordis.patch.yml');
    const record: DeployedAgentRecord = {
      deployMode: 'dsh-yaml-patch',
      deployedAt: new Date().toISOString(),
      dshPatchPath: ownedPath,
    };
    await writeProcess(701, { home: path.join(tmpDir, 'other-home') });

    const target = await locator({ DSH_HOME: path.join(tmpDir, 'pilot-home') })
      .locate(makeDef(path.join(tmpDir, 'configured', 'cordis.patch.yml')), record);

    expect(target).toEqual({
      home: path.dirname(ownedPath),
      patchPath: ownedPath,
      source: 'persisted',
    });
  });

  it('uses an explicit patchPath before environment or process discovery', async () => {
    const configured = path.join(tmpDir, 'configured-home', 'cordis.patch.yml');
    await writeProcess(801, { home: path.join(tmpDir, 'runtime-home') });

    const target = await locator({ DSH_HOME: path.join(tmpDir, 'pilot-home') })
      .locate(makeDef(configured));

    expect(target?.patchPath).toBe(configured);
    expect(target?.source).toBe('configured-patch');
  });

  it('does not inspect procfs on non-Linux platforms', async () => {
    await writeProcess(901, { home: path.join(tmpDir, 'runtime-home') });

    await expect(locator({}, 'darwin').locate(makeDef())).resolves.toBeNull();
    expect(detectAgent).toHaveBeenCalledOnce();
  });
});
