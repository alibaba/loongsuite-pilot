import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

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
    const source = path.resolve('assets/plugins/dsh/plugin.mjs');
    const pluginDir = path.join(tmpDir, 'plugin');
    const pluginPath = path.join(pluginDir, 'plugin.mjs');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.copyFile(source, pluginPath);
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
