import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

async function installPlugin(pluginDir: string): Promise<string> {
  const pluginPath = path.join(pluginDir, 'plugin.mjs');
  const sharedDir = path.join(path.dirname(pluginDir), 'shared');
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.copyFile(path.resolve('assets/plugins/dsh/plugin.mjs'), pluginPath);
  await fs.copyFile(
    path.resolve('assets/plugins/shared/resource-context.mjs'),
    path.join(sharedDir, 'resource-context.mjs'),
  );
  return pluginPath;
}

describe('DSH plugin collection enabled marker', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-'));
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = path.join(tmpDir, 'data');
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function loadPlugin() {
    const pluginDir = path.join(tmpDir, 'plugin');
    const pluginPath = await installPlugin(pluginDir);
    const module = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    return { apply: module.default, pluginDir };
  }

  it('stops an already-loaded plugin from writing after disable and resumes after enable', async () => {
    const { apply, pluginDir } = await loadPlugin();
    const marker = path.join(pluginDir, '.collection-enabled');
    await fs.writeFile(marker, 'enabled\n');
    const handlers = new Map<string, (...args: any[]) => void>();
    const ctx = {
      on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
      logger: () => ({ info: () => {} }),
    };
    apply(ctx);

    await fs.unlink(marker);
    handlers.get('session/event')?.(
      { id: 'session-a' },
      { seq: 1, time: 1, type: 'user/message', data: { content: 'disabled' } },
    );
    const sessionFile = path.join(process.env.LOONGSUITE_PILOT_DATA_DIR!, 'logs', 'dsh', 'dsh-session-a.jsonl');
    await expect(fs.stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.writeFile(marker, 'enabled\n');
    handlers.get('session/event')?.(
      { id: 'session-a' },
      { seq: 2, time: 2, type: 'user/message', data: { content: 'enabled' } },
    );
    expect(await fs.readFile(sessionFile, 'utf-8')).toContain('enabled');
  });

  it('does not register collectors or create logs when loaded while disabled', async () => {
    const { apply } = await loadPlugin();
    const handlers = new Map<string, (...args: any[]) => void>();
    apply({
      on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
      logger: () => ({ info: () => {} }),
    });
    expect(handlers.size).toBe(0);
    await expect(fs.stat(path.join(process.env.LOONGSUITE_PILOT_DATA_DIR!, 'logs', 'dsh')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('DSH plugin worker identity', () => {
  let tmpDir: string;
  let previousDataDir: string | undefined;
  let previousWorkerName: string | undefined;
  let previousInstanceId: string | undefined;
  let previousToken: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-worker-'));
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    previousWorkerName = process.env.AGENTTEAMS_WORKER_NAME;
    previousInstanceId = process.env.AGENTTEAMS_INSTANCE_ID;
    previousToken = process.env.AGENTTEAMS_TOKEN;
    process.env.LOONGSUITE_PILOT_DATA_DIR = path.join(tmpDir, 'data');
    delete process.env.AGENTTEAMS_WORKER_NAME;
    delete process.env.AGENTTEAMS_INSTANCE_ID;
    delete process.env.AGENTTEAMS_TOKEN;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    if (previousWorkerName === undefined) delete process.env.AGENTTEAMS_WORKER_NAME;
    else process.env.AGENTTEAMS_WORKER_NAME = previousWorkerName;
    if (previousInstanceId === undefined) delete process.env.AGENTTEAMS_INSTANCE_ID;
    else process.env.AGENTTEAMS_INSTANCE_ID = previousInstanceId;
    if (previousToken === undefined) delete process.env.AGENTTEAMS_TOKEN;
    else process.env.AGENTTEAMS_TOKEN = previousToken;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function applyEnabled() {
    const pluginDir = path.join(tmpDir, 'plugin');
    const pluginPath = await installPlugin(pluginDir);
    await fs.writeFile(path.join(pluginDir, '.collection-enabled'), 'enabled\n');
    const module = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    const handlers = new Map<string, (...args: any[]) => void>();
    module.default({
      on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
      logger: () => ({ info: () => {} }),
    });
    return handlers;
  }

  async function sessionLine(): Promise<Record<string, unknown>> {
    const handlers = await applyEnabled();
    handlers.get('session/event')?.(
      { id: 'session-a' },
      { seq: 1, time: 1, type: 'user/message', data: { content: 'hello' } },
    );
    const sessionFile = path.join(process.env.LOONGSUITE_PILOT_DATA_DIR!, 'logs', 'dsh', 'dsh-session-a.jsonl');
    return JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
  }

  it('stamps AGENTTEAMS_WORKER_NAME onto session events and drops other AGENTTEAMS variables', async () => {
    process.env.AGENTTEAMS_WORKER_NAME = ' planner ';
    process.env.AGENTTEAMS_INSTANCE_ID = 'task-42-worker-1';
    process.env.AGENTTEAMS_TOKEN = 'must-not-leak';

    const record = await sessionLine();
    expect(record.resourceAttributes).toEqual({
      'agentteams.worker.name': 'planner',
      'agentteams.instance.id': 'task-42-worker-1',
    });
    expect(JSON.stringify(record)).not.toContain('must-not-leak');
  });

  it('omits worker context when AGENTTEAMS_WORKER_NAME is blank or too long', async () => {
    process.env.AGENTTEAMS_WORKER_NAME = ' ';
    expect((await sessionLine()).resourceAttributes).toBeUndefined();

    process.env.AGENTTEAMS_WORKER_NAME = 'x'.repeat(513);
    const pluginDir = path.join(tmpDir, 'plugin-long');
    const pluginPath = await installPlugin(pluginDir);
    await fs.writeFile(path.join(pluginDir, '.collection-enabled'), 'enabled\n');
    const module = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`);
    const handlers = new Map<string, (...args: any[]) => void>();
    module.default({
      on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
      logger: () => ({ info: () => {} }),
    });
    handlers.get('session/event')?.(
      { id: 'session-b' },
      { seq: 1, time: 1, type: 'user/message', data: { content: 'hello' } },
    );
    const sessionFile = path.join(process.env.LOONGSUITE_PILOT_DATA_DIR!, 'logs', 'dsh', 'dsh-session-b.jsonl');
    const record = JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
    expect(record.resourceAttributes).toBeUndefined();
  });
});
