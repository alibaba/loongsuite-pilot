import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { injectClaudeDirectory } from '../../../src/deployment/inject-command.js';
import { withClaudeSettingsLock } from '../../../src/hooks/claude-settings.js';
import * as locks from '../../../src/utils/single-instance-lock.js';
import * as files from '../../../src/utils/fs-utils.js';
import type { AgentDefinition } from '../../../src/types/index.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

let root: string;
let def: AgentDefinition;
let manager: HookManager;
let strategy: HookStrategy;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-review-'));
  def = JSON.parse(await fs.readFile('agents.d/claude-code.json', 'utf8'));
  def.hook = { ...def.hook!, settingsPath: path.join(root, 'session', 'settings.json'),
    hookCommand: path.join(root, 'claude-code-loongsuite-pilot-hook.sh'), env: { DEPLOY_ENV: 'kept' } };
  await fs.writeFile(def.hook.hookCommand, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await fs.writeFile(path.join(root, 'claude-code-hook-processor.mjs'), '');
  manager = new HookManager(root, path.join(root, 'logs'));
  strategy = new HookStrategy(manager);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('Claude inject review regressions', () => {
  it.each(['中文', 'with space', "with ' quote"] )('migrates %s paths and agrees with deploy, repair and uninstall', async suffix => {
    const scripts = path.join(root, suffix);
    await fs.mkdir(scripts);
    await fs.rename(def.hook!.hookCommand, path.join(scripts, 'claude-code-loongsuite-pilot-hook.sh'));
    await fs.rename(path.join(root, 'claude-code-hook-processor.mjs'), path.join(scripts, 'claude-code-hook-processor.mjs'));
    def.hook!.hookCommand = path.join(scripts, 'claude-code-loongsuite-pilot-hook.sh');
    const dir = path.dirname(def.hook!.settingsPath);
    await fs.mkdir(dir);
    const customer = { type: 'command', command: 'echo customer' };
    await fs.writeFile(def.hook!.settingsPath, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `${def.hook!.hookCommand} stop` }, customer] }],
    } }));
    await injectClaudeDirectory(dir, root, def.hook!);
    expect(await strategy.needsDeploy(def)).toBe(false);
    // Reintroduce the legacy spelling, as an older installer could do.
    const settings = JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8'));
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: `${def.hook!.hookCommand} stop` }] });
    await fs.writeFile(def.hook!.settingsPath, JSON.stringify(settings));
    expect(await strategy.needsDeploy(def)).toBe(true);
    expect((await strategy.deploy(def)).success).toBe(true);
    expect(await strategy.needsDeploy(def)).toBe(false);
    const fixed = JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8'));
    expect(fixed.hooks.Stop.flatMap((g: any) => g.hooks)).toHaveLength(2);
    expect((await injectClaudeDirectory(dir, root, def.hook!)).status).toBe('unchanged');
    expect(await strategy.undeploy(def)).toBe(true);
    const removed = JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8'));
    expect(removed.hooks.Stop.flatMap((g: any) => g.hooks)).toEqual([customer]);
    expect(removed.permissions).toEqual({ allow: ['Read'] });
  });

  it.each(['install', 'env', 'uninstall'] as const)('serializes injection behind an in-flight %s write through a directory alias', async operation => {
    const dir = path.dirname(def.hook!.settingsPath);
    await fs.mkdir(dir);
    const alias = path.join(root, 'alias'); await fs.symlink(dir, alias);
    if (operation === 'uninstall') await injectClaudeDirectory(dir, root, def.hook!);
    else await fs.writeFile(def.hook!.settingsPath, JSON.stringify({ customer: true }));
    const definitions = (strategy as any).buildHookDefinitions(def);
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { reached = resolve; });
    const original = files.writeJsonFile;
    vi.spyOn(files, 'writeJsonFile').mockImplementationOnce(async (...args) => {
      reached(); await blocked; await original(...args);
    });
    const operationPromise = operation === 'install' ? manager.installHook(definitions[0])
      : operation === 'uninstall' ? manager.uninstallHook(definitions[0]) : strategy.deploy(def);
    await writing;
    let finished = false;
    const injection = injectClaudeDirectory(alias, root, def.hook!).then(result => { finished = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(finished).toBe(false);
    } finally { release(); }
    await operationPromise; await injection;
    const result = JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8'));
    for (const event of def.hook!.events) expect(result.hooks[event]).toHaveLength(1);
    expect(result.env.LOONGSUITE_PILOT_DATA_DIR).toBe(root);
    if (operation === 'env') expect(result.env.DEPLOY_ENV).toBe('kept');
    if (operation !== 'uninstall') expect(result.customer).toBe(true);
  });

  it.each(['EACCES', 'EROFS', 'ENOSPC'])('surfaces %s without polling', async code => {
    await fs.mkdir(path.dirname(def.hook!.settingsPath));
    const error = Object.assign(new Error(code), { code });
    const write = vi.spyOn(syncFs, 'writeFileSync').mockImplementation(() => { throw error; });
    expect(locks.acquireSingleInstanceLock(path.join(root, 'test.lock'))).toMatchObject({ lock: null, error });
    write.mockClear();
    await expect(withClaudeSettingsLock(def.hook!.settingsPath, async () => {})).rejects.toMatchObject({ code });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries a recovery race with no holder instead of treating it as a permanent error', async () => {
    vi.spyOn(locks, 'acquireSingleInstanceLock').mockReturnValueOnce({ lock: null });
    expect(await withClaudeSettingsLock(def.hook!.settingsPath, async () => 'ok')).toBe('ok');
  });

  it.each(['node', 'version', 'entry'])('returns parseable JSON and stderr for wrapper %s failure', async failure => {
    const script = await fs.readFile('scripts/loongsuite-pilot.sh', 'utf8');
    const functions = ['inject_failure', 'cmd_inject'].map(name => script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`))![0]).join('\n');
    const stubs = `resolve_node() { ${failure === 'node' ? 'return 1' : 'echo /fake/node'}; }\nresolve_current_version() { ${failure === 'version' ? 'return 1' : `echo '${root}'`}; }`;
    for (const json of [true, false]) {
      const result = spawnSync('bash', ['-c', `${stubs}\n${functions}\ncmd_inject --agents=claude-code ${json ? '--json' : ''}`], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('loongsuite-pilot inject:');
      if (json) expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed', error: expect.any(String) });
      else expect(result.stdout).toBe('');
    }
  });
});
