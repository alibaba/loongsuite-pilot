import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
  commandExists: vi.fn(),
}));

import { commandExists, detectAgent } from '../../../src/deployment/detect-utils.js';
import {
  probeAgentDefinition,
  probeAgentDefinitions,
} from '../../../src/deployment/cli-probe-detector.js';
import { DshRuntimeLocator } from '../../../src/deployment/dsh-runtime-locator.js';

describe('CLI probe detector', () => {
  let tmpDir: string;
  let procRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-probe-detector-'));
    procRoot = path.join(tmpDir, 'proc');
    await fs.mkdir(procRoot);
    vi.mocked(detectAgent).mockResolvedValue(false);
    vi.mocked(commandExists).mockResolvedValue(false);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function dshDef(): AgentDefinition {
    return {
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      deployMode: 'dsh-yaml-patch',
      detection: { paths: ['~/.dsh'], commands: ['dsh'] },
      dshYamlPatch: {
        pluginSource: '/pilot/plugins/dsh/plugin.mjs',
        entryId: 'loongsuite-pilot-observability',
        marker: 'PILOT-OBSERVABILITY-MANAGED',
      },
    };
  }

  function genericDef(): AgentDefinition {
    return {
      id: 'generic-cli',
      displayName: 'Generic CLI',
      deployMode: 'detection-only',
      detection: { paths: [], commands: ['generic-cli'] },
    };
  }

  function locator(): DshRuntimeLocator {
    return new DshRuntimeLocator({
      procRoot,
      platform: 'linux',
      env: {},
      cwd: () => tmpDir,
      uid: process.getuid?.(),
    });
  }

  async function writeDshProcess(pid: number, home: string): Promise<void> {
    const processDir = path.join(procRoot, String(pid));
    await fs.mkdir(processDir);
    await fs.writeFile(
      path.join(processDir, 'cmdline'),
      Buffer.from(['node', '/code/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', ''].join('\0')),
    );
    await fs.writeFile(
      path.join(processDir, 'environ'),
      Buffer.from([
        'PATH=/usr/bin',
        `DSH_HOME=${home}`,
        'DEEPSEEK_API_KEY=must-not-appear-in-the-probe-result',
        '',
      ].join('\0')),
    );
  }

  it('discovers OpenClaw for the installer without calling which or generic detection', async () => {
    const executable = path.join(tmpDir, 'openclaw.mjs');
    await fs.writeFile(executable, '/* never executed */');
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.3.8' }));
    vi.stubEnv('OPENCLAW_CLI_PATH', executable);
    const def = { ...genericDef(), id: 'openclaw', displayName: 'OpenClaw' };
    const result = await probeAgentDefinition(def);
    expect(result.detected).toBe(true);
    expect(result.reason).toContain('2026.3.8');
    expect(detectAgent).not.toHaveBeenCalled();
    expect(commandExists).not.toHaveBeenCalled();
  });

  it('reports an unbound OpenClaw PATH candidate as not ready with an actionable reason', async () => {
    const executable = path.join(tmpDir, process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
    await fs.writeFile(executable, '/* never executed */');
    await fs.chmod(executable, 0o755);
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.6.10' }));
    vi.stubEnv('PATH', tmpDir);
    vi.stubEnv('OPENCLAW_CLI_PATH', undefined);
    vi.stubEnv('OPENCLAW_BUNDLE_ROOT', undefined);
    // Vitest 1 stringifies undefined; retain restoration but actually unset it.
    delete process.env.OPENCLAW_CLI_PATH;
    delete process.env.OPENCLAW_BUNDLE_ROOT;
    const result = await probeAgentDefinition({ ...genericDef(), id: 'openclaw', displayName: 'OpenClaw' });
    expect(result.detected).toBe(false);
    expect(result.reason).toContain('candidate found');
    expect(result.reason).toContain('OPENCLAW_CLI_PATH');
    expect(detectAgent).not.toHaveBeenCalled();
    expect(commandExists).not.toHaveBeenCalled();
  });

  it('detects a Node-launched DSH from procfs when the installer environment misses it', async () => {
    const home = path.join(tmpDir, 'runtime-home');
    await writeDshProcess(321, home);

    const result = await probeAgentDefinition(dshDef(), { dshRuntimeLocator: locator() });

    expect(result).toEqual({
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      detected: true,
      reason: `running process: DSH_HOME=${home} (pid 321)`,
    });
    expect(JSON.stringify(result)).not.toContain('DEEPSEEK_API_KEY');
    expect(detectAgent).not.toHaveBeenCalled();
  });

  it('returns a normal miss when no DSH runtime is discoverable', async () => {
    await expect(probeAgentDefinition(dshDef(), { dshRuntimeLocator: locator() })).resolves.toEqual({
      id: 'dsh',
      displayName: 'DeepSeek Harness',
      detected: false,
      reason: '',
    });
  });

  it('contains an ambiguous DSH failure and preserves other Agent results', async () => {
    await writeDshProcess(401, path.join(tmpDir, 'home-a'));
    await writeDshProcess(402, path.join(tmpDir, 'home-b'));
    vi.mocked(detectAgent).mockImplementation(async detection => detection.commands.includes('generic-cli'));
    vi.mocked(commandExists).mockImplementation(async command => command === 'generic-cli');

    const results = await probeAgentDefinitions(
      [dshDef(), genericDef()],
      { dshRuntimeLocator: locator() },
    );

    expect(results).toEqual([
      {
        id: 'dsh',
        displayName: 'DeepSeek Harness',
        detected: false,
        reason: '',
      },
      {
        id: 'generic-cli',
        displayName: 'Generic CLI',
        detected: true,
        reason: 'command: generic-cli',
      },
    ]);
  });

  it('preserves generic Agent detection errors', async () => {
    const failure = new Error('generic detector failed');
    vi.mocked(detectAgent).mockRejectedValueOnce(failure);

    await expect(probeAgentDefinition(genericDef())).rejects.toBe(failure);
  });

  it('preserves list-only behavior without consulting runtime discovery', async () => {
    const locate = vi.fn();

    const result = await probeAgentDefinition(dshDef(), {
      listOnly: true,
      dshRuntimeLocator: { locate },
    });

    expect(result.detected).toBe(false);
    expect(result.reason).toBe('');
    expect(locate).not.toHaveBeenCalled();
    expect(detectAgent).not.toHaveBeenCalled();
  });
});
