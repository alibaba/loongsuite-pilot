import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleWorkerCli } from '../../../src/local-workers/worker-cli.js';
import { bootstrapTokenPath, readLocalWorkerInstance } from '../../../src/local-workers/instance-store.js';

describe('local worker CLI', () => {
  let tmpDir: string;
  let dataDir: string;
  let originalDataDir: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-worker-cli-'));
    dataDir = path.join(tmpDir, 'data');
    originalDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    } else {
      process.env.LOONGSUITE_PILOT_DATA_DIR = originalDataDir;
    }
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function token(workerUuid = '550e8400-e29b-41d4-a716-446655440000'): string {
    return Buffer.from(JSON.stringify({
      workerUuid,
      matrixUrl: 'https://matrix.example.com',
      controllerUrl: 'https://controller.example.com',
      modelGatewayUrl: 'https://model.example.com',
    })).toString('base64');
  }

  it('reconnects a disconnected worker by instance id without requiring bootstrap token', async () => {
    await handleWorkerCli([
      'worker',
      'connect',
      '--runtime',
      'claude-code',
      '--bootstrap-token',
      token(),
      '--work-dir',
      path.join(tmpDir, 'project'),
    ]);
    const firstLine = String(logSpy.mock.calls[0]?.[0] ?? '');
    const instanceId = firstLine.replace(/^connected\s+/, '');

    await handleWorkerCli(['worker', 'disconnect', instanceId]);
    await handleWorkerCli(['worker', 'connect', instanceId]);

    const instance = await readLocalWorkerInstance(dataDir, instanceId);
    expect(instance?.enabled).toBe(true);
    expect(instance?.workDir).toBe(path.join(tmpDir, 'project'));
    expect(instance && await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).toBe(token());
    expect(logSpy.mock.calls.some(call => call[0] === `reconnected ${instanceId}`)).toBe(true);
  });

  it('updates an existing worker token by instance id', async () => {
    await handleWorkerCli([
      'worker',
      'connect',
      '--runtime',
      'claude-code',
      '--bootstrap-token',
      token(),
      '--work-dir',
      path.join(tmpDir, 'project'),
    ]);
    const firstLine = String(logSpy.mock.calls[0]?.[0] ?? '');
    const instanceId = firstLine.replace(/^connected\s+/, '');
    const rotatedToken = token('rotated-worker-uuid');

    await handleWorkerCli(['worker', 'connect', instanceId, '--bootstrap-token', rotatedToken]);

    const instance = await readLocalWorkerInstance(dataDir, instanceId);
    expect(instance?.enabled).toBe(true);
    expect(instance && await fs.readFile(bootstrapTokenPath(dataDir, instance), 'utf-8')).toBe(rotatedToken);
    expect(logSpy.mock.calls.some(call => call[0] === `reconnected ${instanceId}`)).toBe(true);
  });

  it('stores runtime worker options after -- without interpreting them', async () => {
    await handleWorkerCli([
      'worker',
      'connect',
      '--runtime',
      'claude-code',
      '--bootstrap-token',
      token(),
      '--work-dir',
      path.join(tmpDir, 'project'),
      '--',
      '--model-config-mode',
      'managed-global',
      '--plugin-install-scope=global',
      '--enable-trace-hook',
    ]);
    const firstLine = String(logSpy.mock.calls[0]?.[0] ?? '');
    const instanceId = firstLine.replace(/^connected\s+/, '');

    const instance = await readLocalWorkerInstance(dataDir, instanceId);
    expect(instance?.runtimeOptions).toEqual({
      'model-config-mode': 'managed-global',
      'plugin-install-scope': 'global',
      'enable-trace-hook': true,
    });
  });

  it('rejects runtime worker arguments before --', async () => {
    await handleWorkerCli([
      'worker',
      'connect',
      '--runtime',
      'claude-code',
      '--bootstrap-token',
      token(),
      '--model-config-mode',
      'managed-global',
    ]);

    expect(process.exitCode).toBe(1);
    expect(await fs.readdir(dataDir).catch(() => [])).toEqual([]);
  });

  it('rejects runtime worker options on non-connect commands', async () => {
    await handleWorkerCli(['worker', 'list', '--', '--model-config-mode', 'managed-global']);

    expect(process.exitCode).toBe(1);
  });
});
