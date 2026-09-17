import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { injectClaudeDirectory, mergeClaudeHooks, parseInjectCommandArgs, runInjectCommand } from '../../../src/deployment/inject-command.js';
import { loadConfig } from '../../../src/core/config-loader.js';
import { acquireSingleInstanceLock } from '../../../src/utils/single-instance-lock.js';
import type { AgentHookConfig } from '../../../src/types/deployment.js';

let root: string;
let hook: AgentHookConfig;
vi.mock('../../../src/core/config-loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../../src/deployment/deploy-command.js', () => ({
  resolvePilotDir: () => process.cwd(),
  isAgentGatedEnabled: (config: any) => config.agents?.['claude-code']?.enabled !== false,
}));
let bundleDir: string;
beforeAll(async () => {
  bundleDir = await fs.mkdtemp(path.join(process.cwd(), '.inject-test-'));
  await build({ stdin: { contents: `import { injectClaudeDirectory } from './src/deployment/inject-command.ts';
    const [dir, data, hook] = process.argv.slice(2);
    console.log(JSON.stringify(await injectClaudeDirectory(dir, data, JSON.parse(hook))));`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: path.join(bundleDir, 'worker.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
});
afterAll(async () => { await fs.rm(bundleDir, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-inject-'));
  const def = JSON.parse(await fs.readFile('agents.d/claude-code.json', 'utf8'));
  hook = { ...def.hook, hookCommand: path.join(root, 'hooks', 'claude-code-loongsuite-pilot-hook.sh') };
  await fs.mkdir(path.dirname(hook.hookCommand));
  await fs.writeFile(hook.hookCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'hooks', 'claude-code-hook-processor.mjs'), '');
  vi.mocked(loadConfig).mockResolvedValue({ enabled: true, dataDir: root } as any);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('session inject', () => {
  it('parses both option forms and rejects unsupported or empty arguments', () => {
    expect(parseInjectCommandArgs(['--agents=claude-code', '--config-dir', '/tmp/a', '--json'])).toMatchObject({ configDir: '/tmp/a', json: true });
    for (const args of [[], ['--agents=codex'], ['--agents=claude-code', '--config-dir='], ['--agents=claude-code', '--typo']]) expect(() => parseInjectCommandArgs(args)).toThrow();
  });
  it('adopts manual entries, preserves mixed third-party groups and is idempotent', () => {
    const customer = { permissions: { allow: ['Read'] }, env: { CUSTOMER: 'keep' }, hooks: { Stop: [{ matcher: '*', hooks: [
      { type: 'command', command: '/old/hooks/claude-code-loongsuite-pilot-hook.sh stop' },
      { type: 'command', command: 'echo claude-code-loongsuite-pilot-hook.sh' },
    ] }] } };
    const result = mergeClaudeHooks(customer, hook, root);
    expect(result.permissions).toEqual(customer.permissions);
    expect(result.env).toEqual({ CUSTOMER: 'keep', LOONGSUITE_PILOT_DATA_DIR: root });
    expect(result.hooks.Stop).toHaveLength(2);
    expect(result.hooks.Stop[0].hooks).toEqual([customer.hooks.Stop[0].hooks[1]]);
    expect(Object.keys(result.hooks)).toEqual(expect.arrayContaining(hook.events));
    expect(mergeClaudeHooks(result, hook, root)).toEqual(result);
    expect(customer.hooks.Stop[0].hooks).toHaveLength(2);
  });
  it('preserves permissions and raw bytes when unchanged', async () => {
    const dir = path.join(root, 'session');
    await fs.mkdir(dir);
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, '{"env":{"CUSTOM":"value"}}', { mode: 0o640 });
    expect((await injectClaudeDirectory(dir, root, hook)).status).toBe('updated');
    const before = await fs.stat(file);
    const raw = await fs.readFile(file, 'utf8');
    expect((await injectClaudeDirectory(dir, root, hook)).status).toBe('unchanged');
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
  });
  it('quotes shell-sensitive paths without executing path contents', async () => {
    const scripts = path.join(root, "space ' $(touch should-not-exist)");
    await fs.mkdir(scripts);
    const script = path.join(scripts, 'claude-code-loongsuite-pilot-hook.sh');
    await fs.writeFile(script, '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
    const result = mergeClaudeHooks({}, { ...hook, hookCommand: script }, root);
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', result.hooks.Stop[0].hooks[0].command], { cwd: root });
    expect(stdout).toBe('stop');
    await expect(fs.stat(path.join(root, 'should-not-exist'))).rejects.toThrow();
  });
  it('keeps different directories independent', async () => {
    await Promise.all(['a', 'b'].map(async name => {
      const dir = path.join(root, name); await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ env: { SESSION: name } }));
      await injectClaudeDirectory(dir, root, hook);
      expect(JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8')).env.SESSION).toBe(name);
    }));
  });
  it('serializes callers including directory aliases', async () => {
    const dir = path.join(root, 'session');
    await fs.mkdir(dir);
    await fs.symlink(dir, path.join(root, 'alias'));
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => injectClaudeDirectory(i % 2 ? dir : path.join(root, 'alias'), root, hook)));
    expect(results.filter(r => r.status === 'updated')).toHaveLength(1);
    const settings = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
    for (const event of hook.events) expect(settings.hooks[event]).toHaveLength(1);
  });
  it('fails closed on invalid JSON and linked settings without touching the target', async () => {
    const dir = path.join(root, 'session'); await fs.mkdir(dir);
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, '{broken');
    await expect(injectClaudeDirectory(dir, root, hook)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    await fs.rename(file, path.join(root, 'original'));
    await fs.symlink(path.join(root, 'original'), file);
    await expect(injectClaudeDirectory(dir, root, hook)).rejects.toThrow('non-linked');
  });
  it('times out without stealing a live lock', async () => {
    const dir = path.join(root, 'session'); await fs.mkdir(dir);
    const { lock } = acquireSingleInstanceLock(path.join(await fs.realpath(dir), '.loongsuite-pilot-inject.lock'));
    try { await expect(injectClaudeDirectory(dir, root, hook, 30)).rejects.toThrow('lock'); }
    finally { lock?.release(); }
    await expect(fs.stat(path.join(dir, 'settings.json'))).rejects.toThrow();
  });
  it('refuses malformed structures and hook-disabling policy', () => {
    for (const settings of [{ hooks: [] }, { env: [] }, { hooks: { Stop: {} } }, { disableAllHooks: true }]) {
      expect(() => mergeClaudeHooks(settings, hook, root)).toThrow();
    }
  });
  it('merges safely across independent processes', async () => {
    const dir = path.join(root, 'process-session');
    const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath,
      [path.join(bundleDir, 'worker.mjs'), dir, root, JSON.stringify(hook)])));
    expect(results.map(r => JSON.parse(r.stdout)).filter(r => r.status === 'updated')).toHaveLength(1);
    const result = JSON.parse(await fs.readFile(path.join(dir, 'settings.json'), 'utf8'));
    for (const event of hook.events) expect(result.hooks[event]).toHaveLength(1);
    await expect(fs.stat(path.join(root, 'deployed-agents.json'))).rejects.toThrow();
  });
  it('resolves explicit, environment and default targets and reports JSON', async () => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'env-session'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runInjectCommand(['--agents=claude-code', '--json', '--config-dir', path.join(root, 'explicit')])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).settingsPath).toContain('/explicit/settings.json');
    expect(await runInjectCommand(['--agents=claude-code', '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).settingsPath).toContain('/env-session/settings.json');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(await runInjectCommand(['--agents=claude-code', '--json'])).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).settingsPath).toContain('/.claude/settings.json');
  });
  it('reports disabled collection and missing assets without creating settings', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue({ enabled: false, dataDir: root } as any);
    const args = ['--agents=claude-code', '--json', '--config-dir', path.join(root, 'missing')];
    expect(await runInjectCommand(args)).toBe(1);
    expect(JSON.parse(output.mock.calls.at(-1)![0]).error).toContain('disabled');
    vi.mocked(loadConfig).mockResolvedValue({ enabled: true, dataDir: root } as any);
    await fs.unlink(hook.hookCommand);
    expect(await runInjectCommand(args)).toBe(1);
    await expect(fs.stat(path.join(root, 'missing'))).rejects.toThrow();
  });
});
