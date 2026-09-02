import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DirectoryPluginStrategy } from '../../../src/deployment/directory-plugin-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/deployment/detect-utils.js', () => ({
  detectAgent: vi.fn(),
}));

import { detectAgent } from '../../../src/deployment/detect-utils.js';

const MARKER_FILE = '.loongsuite-pilot-managed.json';

describe('DirectoryPluginStrategy', () => {
  let tmpDir: string;
  let sourceDir: string;
  let targetDir: string;
  let strategy: DirectoryPluginStrategy;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'directory-plugin-'));
    sourceDir = path.join(tmpDir, 'source');
    targetDir = path.join(tmpDir, 'plugins', 'loongsuite-pilot');
    strategy = new DirectoryPluginStrategy(path.join(tmpDir, 'pilot-data'));

    await fs.mkdir(path.join(sourceDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'plugin.yaml'), 'name: loongsuite-pilot\n');
    await fs.writeFile(path.join(sourceDir, 'nested', 'plugin.py'), 'VERSION = 1\n');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      id: 'hermes-agent',
      displayName: 'Hermes Agent',
      deployMode: 'directory-plugin',
      detection: { paths: ['/tmp/hermes'], commands: ['hermes'] },
      directoryPlugin: { sourceDir, targetDir },
      ...overrides,
    };
  }

  async function readMarker(): Promise<Record<string, unknown>> {
    return JSON.parse(
      await fs.readFile(path.join(targetDir, MARKER_FILE), 'utf8'),
    ) as Record<string, unknown>;
  }

  function withActivation(def: AgentDefinition): AgentDefinition {
    return {
      ...def,
      directoryPlugin: {
        ...def.directoryPlugin!,
        activation: {
          command: '/opt/hermes/bin/hermes',
          probeArgs: ['plugins', 'enable', '--help'],
          enableArgs: ['plugins', 'enable', 'loongsuite-pilot'],
          disableArgs: ['plugins', 'disable', 'loongsuite-pilot'],
        },
      },
    };
  }

  it('delegates detection and returns false when the agent is absent', async () => {
    vi.mocked(detectAgent).mockResolvedValue(false);
    const def = makeDef();

    await expect(strategy.detect(def)).resolves.toBe(false);
    expect(detectAgent).toHaveBeenCalledWith(def.detection);
  });

  it('copies a plugin directory and writes its ownership marker', async () => {
    const def = makeDef();
    await expect(strategy.needsDeploy(def)).resolves.toBe(true);

    await expect(strategy.deploy(def)).resolves.toMatchObject({
      success: true,
      agentId: 'hermes-agent',
      deployMode: 'directory-plugin',
    });

    await expect(fs.readFile(path.join(targetDir, 'plugin.yaml'), 'utf8'))
      .resolves.toBe('name: loongsuite-pilot\n');
    await expect(fs.readFile(path.join(targetDir, 'nested', 'plugin.py'), 'utf8'))
      .resolves.toBe('VERSION = 1\n');
    expect(await readMarker()).toMatchObject({
      schemaVersion: 1,
      owner: 'loongsuite-pilot',
      agentId: 'hermes-agent',
      sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      dataDir: path.join(tmpDir, 'pilot-data'),
    });
  });

  it('activates supported target plugins and records the activation contract', async () => {
    const commands: string[][] = [];
    class RecordingStrategy extends DirectoryPluginStrategy {
      protected override async runActivationCommand(
        _command: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string }> {
        commands.push(args);
        return { stdout: '', stderr: '' };
      }
    }
    const activatedStrategy = new RecordingStrategy();
    const def = withActivation(makeDef());

    await expect(activatedStrategy.deploy(def)).resolves.toMatchObject({ success: true });
    expect(commands).toEqual([
      ['plugins', 'enable', '--help'],
      ['plugins', 'enable', 'loongsuite-pilot'],
    ]);
    expect(await readMarker()).toMatchObject({
      activationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    await expect(activatedStrategy.needsDeploy(def)).resolves.toBe(false);

    await expect(activatedStrategy.undeploy(def)).resolves.toBe(true);
    expect(commands.slice(-2)).toEqual([
      ['plugins', 'enable', '--help'],
      ['plugins', 'disable', 'loongsuite-pilot'],
    ]);
  });

  it('only appends optional enable arguments advertised by the target CLI', async () => {
    const commands: string[][] = [];
    class RecordingStrategy extends DirectoryPluginStrategy {
      constructor(private readonly help: string) {
        super();
      }

      protected override async runActivationCommand(
        _command: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string }> {
        commands.push(args);
        return {
          stdout: args.includes('--help') ? this.help : '',
          stderr: '',
        };
      }
    }
    const def = withActivation(makeDef());
    def.directoryPlugin!.activation!.optionalEnableArgs = ['--no-allow-tool-override'];

    await expect(new RecordingStrategy(
      'usage: hermes plugins enable [--no-allow-tool-override] name',
    ).deploy(def)).resolves.toMatchObject({ success: true });
    expect(commands.slice(-1)).toEqual([[
      'plugins', 'enable', 'loongsuite-pilot', '--no-allow-tool-override',
    ]]);

    commands.length = 0;
    await expect(new RecordingStrategy(
      'usage: hermes plugins enable [-h] name',
    ).deploy(def)).resolves.toMatchObject({ success: true });
    expect(commands.slice(-1)).toEqual([['plugins', 'enable', 'loongsuite-pilot']]);
  });

  it('keeps compatibility with targets that do not expose activation commands', async () => {
    const commands: string[][] = [];
    class LegacyStrategy extends DirectoryPluginStrategy {
      protected override async runActivationCommand(
        _command: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string }> {
        commands.push(args);
        if (args.includes('--help')) {
          throw Object.assign(new Error('unknown command: plugins'), {
            code: 2,
            stderr: 'unknown command: plugins',
          });
        }
        return { stdout: '', stderr: '' };
      }
    }
    const legacyStrategy = new LegacyStrategy();
    const def = withActivation(makeDef());

    await expect(legacyStrategy.deploy(def)).resolves.toMatchObject({ success: true });
    expect(commands).toEqual([['plugins', 'enable', '--help']]);
    expect(await readMarker()).toMatchObject({
      activationHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      activationStatus: 'unsupported',
    });
    await expect(legacyStrategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('keeps activation pending when the probe times out', async () => {
    class TimedOutProbeStrategy extends DirectoryPluginStrategy {
      protected override async runActivationCommand(): Promise<{ stdout: string; stderr: string }> {
        throw Object.assign(new Error('probe timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
        });
      }
    }
    const timedOutStrategy = new TimedOutProbeStrategy();
    const def = withActivation(makeDef());

    const result = await timedOutStrategy.deploy(def);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('probe timed out');
    expect(await readMarker()).not.toHaveProperty('activationHash');
    await expect(timedOutStrategy.needsDeploy(def)).resolves.toBe(true);
  });

  it('passes the configured activation timeout to probe and enable commands', async () => {
    const calls: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
    class TimeoutRecordingStrategy extends DirectoryPluginStrategy {
      protected override async runActivationCommand(
        _command: string,
        args: string[],
        timeoutMs?: number,
      ): Promise<{ stdout: string; stderr: string }> {
        calls.push({ args, timeoutMs });
        return { stdout: '', stderr: '' };
      }
    }
    const def = withActivation(makeDef());
    def.directoryPlugin!.activation!.timeoutMs = 45_000;

    await expect(new TimeoutRecordingStrategy().deploy(def))
      .resolves.toMatchObject({ success: true });
    expect(calls).toEqual([
      { args: ['plugins', 'enable', '--help'], timeoutMs: 45_000 },
      { args: ['plugins', 'enable', 'loongsuite-pilot'], timeoutMs: 45_000 },
    ]);
  });

  it('leaves activation pending when a supported target rejects enablement', async () => {
    class FailingActivationStrategy extends DirectoryPluginStrategy {
      protected override async runActivationCommand(
        _command: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string }> {
        if (!args.includes('--help')) throw Object.assign(new Error('enable failed'), { code: 1 });
        return { stdout: '', stderr: '' };
      }
    }
    const failingStrategy = new FailingActivationStrategy();
    const def = withActivation(makeDef());

    const result = await failingStrategy.deploy(def);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('enable failed');
    expect(await readMarker()).not.toHaveProperty('activationHash');
    await expect(failingStrategy.needsDeploy(def)).resolves.toBe(true);
  });

  it('is idempotent when source and managed target are unchanged', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);
    const firstMarker = await readMarker();

    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
    expect((await strategy.deploy(def)).success).toBe(true);
    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
    expect(await readMarker()).toEqual(firstMarker);
  });

  it('redeploys when the Pilot data directory changes', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    const newDataDir = path.join(tmpDir, 'other-pilot-data');
    const movedStrategy = new DirectoryPluginStrategy(newDataDir);

    await expect(movedStrategy.needsDeploy(def)).resolves.toBe(true);
    expect((await movedStrategy.deploy(def)).success).toBe(true);
    expect(await readMarker()).toMatchObject({ dataDir: newDataDir });
    await expect(movedStrategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('ignores Python runtime artifacts added to the managed target', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    const pycacheDir = path.join(targetDir, 'nested', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    await fs.writeFile(path.join(pycacheDir, 'plugin.cpython-312.pyc'), 'bytecode\n');
    await fs.writeFile(path.join(targetDir, 'legacy.pyc'), 'legacy bytecode\n');
    await fs.writeFile(path.join(targetDir, 'optimized.pyo'), 'optimized bytecode\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('detects an ordinary extra file even inside a runtime cache directory', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    const pycacheDir = path.join(targetDir, 'nested', '__pycache__');
    await fs.mkdir(pycacheDir, { recursive: true });
    await fs.writeFile(path.join(pycacheDir, 'unexpected.txt'), 'unexpected\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
  });

  it('still detects tampering of a source-managed Python runtime artifact', async () => {
    await fs.writeFile(path.join(sourceDir, 'managed.pyc'), 'managed bytecode\n');
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    await fs.writeFile(path.join(targetDir, 'managed.pyc'), 'tampered bytecode\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
  });

  it('updates a managed target when the source version changes', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);
    const oldHash = (await readMarker()).sourceHash;

    await fs.writeFile(path.join(sourceDir, 'nested', 'plugin.py'), 'VERSION = 2\n');
    await fs.writeFile(path.join(sourceDir, 'new-module.py'), 'ENABLED = True\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
    expect((await strategy.deploy(def)).success).toBe(true);
    await expect(fs.readFile(path.join(targetDir, 'nested', 'plugin.py'), 'utf8'))
      .resolves.toBe('VERSION = 2\n');
    await expect(fs.readFile(path.join(targetDir, 'new-module.py'), 'utf8'))
      .resolves.toBe('ENABLED = True\n');
    expect((await readMarker()).sourceHash).not.toBe(oldHash);
    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('detects managed content tampering and self-heals from source', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    await fs.writeFile(path.join(targetDir, 'nested', 'plugin.py'), 'TAMPERED = True\n');
    await fs.writeFile(path.join(targetDir, 'unexpected.py'), 'unexpected\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
    expect((await strategy.deploy(def)).success).toBe(true);
    await expect(fs.readFile(path.join(targetDir, 'nested', 'plugin.py'), 'utf8'))
      .resolves.toBe('VERSION = 1\n');
    await expect(fs.stat(path.join(targetDir, 'unexpected.py'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('refuses to overwrite an unmanaged non-empty target', async () => {
    const def = makeDef();
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'user-plugin.py'), 'keep me\n');

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
    const result = await strategy.deploy(def);
    expect(result).toMatchObject({
      success: false,
      agentId: 'hermes-agent',
      deployMode: 'directory-plugin',
    });
    expect(result.error).toContain('refusing to overwrite unmanaged non-empty directory');
    await expect(fs.readFile(path.join(targetDir, 'user-plugin.py'), 'utf8'))
      .resolves.toBe('keep me\n');
  });

  it('only undeploys a directory managed for the same agent', async () => {
    const def = makeDef();
    expect((await strategy.deploy(def)).success).toBe(true);

    const otherAgent = makeDef({ id: 'other-agent' });
    await expect(strategy.undeploy(otherAgent)).resolves.toBe(false);
    await expect(fs.stat(targetDir)).resolves.toMatchObject({});

    await expect(strategy.undeploy(def)).resolves.toBe(true);
    await expect(fs.stat(targetDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(strategy.undeploy(def)).resolves.toBe(true);
  });

  it('treats an invalid marker as unmanaged and preserves the target', async () => {
    const def = makeDef();
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'user-plugin.py'), 'keep me\n');
    await fs.writeFile(path.join(targetDir, MARKER_FILE), JSON.stringify({
      schemaVersion: 99,
      owner: 'loongsuite-pilot',
      agentId: 'hermes-agent',
      sourceHash: `sha256:${'0'.repeat(64)}`,
    }));

    await expect(strategy.needsDeploy(def)).resolves.toBe(true);
    await expect(strategy.deploy(def)).resolves.toMatchObject({ success: false });
    await expect(strategy.undeploy(def)).resolves.toBe(false);
    await expect(fs.readFile(path.join(targetDir, 'user-plugin.py'), 'utf8'))
      .resolves.toBe('keep me\n');
  });

  it('allows first deployment into an existing empty target', async () => {
    const def = makeDef();
    await fs.mkdir(targetDir, { recursive: true });

    await expect(strategy.deploy(def)).resolves.toMatchObject({ success: true });
    await expect(strategy.needsDeploy(def)).resolves.toBe(false);
  });

  it('cleans the staging directory when copying fails', async () => {
    class FailingCopyStrategy extends DirectoryPluginStrategy {
      protected override async copyDirectoryContents(
        _sourceDir: string,
        _targetDir: string,
      ): Promise<void> {
        throw new Error('copy failed');
      }
    }

    const result = await new FailingCopyStrategy().deploy(makeDef());
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('copy failed');

    const pluginParent = path.dirname(targetDir);
    const entries = await fs.readdir(pluginParent);
    expect(entries.filter(name => name.startsWith('.loongsuite-pilot.loongsuite-pilot-')))
      .toEqual([]);
  });
});
