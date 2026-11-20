import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handlePiSdkAgentCli } from '../../../src/pi-sdk/pi-sdk-agent-cli.js';

const loggerMocks = vi.hoisted(() => ({
  redirectRootLoggerToStderr: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  redirectRootLoggerToStderr: loggerMocks.redirectRootLoggerToStderr,
}));

describe('PI SDK Agent CLI', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-sdk-agent-cli-'));
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = path.join(tmpDir, 'pilot-data');
    const piTarget = path.join(process.env.LOONGSUITE_PILOT_DATA_DIR, 'plugins', 'pi-coding-agent');
    const sharedTarget = path.join(process.env.LOONGSUITE_PILOT_DATA_DIR, 'plugins', 'shared');
    await fs.mkdir(piTarget, { recursive: true });
    await fs.mkdir(sharedTarget, { recursive: true });
    await fs.copyFile(
      path.join(process.cwd(), 'assets', 'plugins', 'pi-coding-agent', 'index.mjs'),
      path.join(piTarget, 'index.mjs'),
    );
    await fs.copyFile(
      path.join(process.cwd(), 'assets', 'plugins', 'shared', 'resource-context.mjs'),
      path.join(sharedTarget, 'resource-context.mjs'),
    );
    process.exitCode = undefined;
    loggerMocks.redirectRootLoggerToStderr.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('registers repeated detection flags and unregisters through the public command shape', async () => {
    const agentDir = path.join(tmpDir, 'agent-dir');
    const pathA = path.join(tmpDir, 'detected-a');
    const pathB = path.join(tmpDir, 'detected-b');

    expect(await handlePiSdkAgentCli([
      'agent', 'register', 'pi-sdk',
      '--id', 'acme-code',
      '--name', 'Acme Code',
      '--agent-dir', agentDir,
      '--detect-path', pathA,
      '--detect-path', pathB,
      '--detect-command', 'acme-code',
    ])).toBe(true);
    expect(process.exitCode).toBeUndefined();

    const definitionPath = path.join(
      process.env.LOONGSUITE_PILOT_DATA_DIR!,
      'agents.d.local',
      'acme-code.json',
    );
    const definition = JSON.parse(await fs.readFile(definitionPath, 'utf8'));
    expect(definition.detection).toEqual({
      paths: [pathA, pathB],
      commands: ['acme-code'],
    });

    expect(await handlePiSdkAgentCli(['agent', 'unregister', 'acme-code'])).toBe(true);
    await expect(fs.access(definitionPath)).rejects.toThrow();
  });

  it('does not claim unrelated commands and reports invalid agent commands', async () => {
    expect(await handlePiSdkAgentCli(['worker', 'list'])).toBe(false);
    expect(await handlePiSdkAgentCli(['agent', 'register', 'pi-sdk', '--id', 'missing-fields'])).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--name is required'));
  });

  it('routes operational logs away from stdout in JSON mode', async () => {
    const agentDir = path.join(tmpDir, 'json-agent-dir');
    const detected = path.join(tmpDir, 'json-detected');
    await fs.mkdir(detected, { recursive: true });

    expect(await handlePiSdkAgentCli([
      'agent', 'register', 'pi-sdk',
      '--id', 'json-code',
      '--name', 'JSON Code',
      '--agent-dir', agentDir,
      '--detect-path', detected,
      '--json',
    ])).toBe(true);

    expect(process.exitCode).toBeUndefined();
    expect(loggerMocks.redirectRootLoggerToStderr).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledOnce();
    const output = String(vi.mocked(console.log).mock.calls[0][0]);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toMatchObject({ id: 'json-code', name: 'JSON Code' });
  });
});
