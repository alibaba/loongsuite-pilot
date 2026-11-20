import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedInterceptorPath, managedScriptFileName, managedScriptsDir, type ManagedScriptRule } from '../../../src/interceptor/managed/config.js';
import { ManagedInterceptor } from '../../../src/interceptor/managed/controller.js';
import type { ScriptRunResult, ScriptRunner } from '../../../src/interceptor/managed/runner.js';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => logs }));

const directories: string[] = [];
const controllers: ManagedInterceptor[] = [];
const probe: ManagedScriptRule = {
  kind: 'script', id: 'policy', version: '1', shell: 'powershell', action: 'block',
  agents: ['qoder'], events: ['UserPromptSubmit'],
};
const request = { agent: 'qoder' as const, event: 'UserPromptSubmit' as const, prompt: 'hello', raw: {} };

async function setup(scriptCache?: string): Promise<{ dataDir: string; file: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-managed-controller-'));
  directories.push(dataDir);
  const dir = managedScriptsDir(dataDir, scriptCache);
  await mkdir(dir, { recursive: true });
  const file = join(dir, managedScriptFileName(probe));
  await writeFile(file, 'fixture');
  await writeRules(dataDir, [probe], scriptCache);
  return { dataDir, file };
}
async function writeRules(dataDir: string, rules: unknown[], scriptCache?: string): Promise<void> {
  await writeFile(managedInterceptorPath(dataDir), JSON.stringify({ interceptor: { rules, ...(scriptCache ? { scriptCache } : {}) } }));
}
function fakeRunner(): ScriptRunner {
  return { warm: vi.fn(), stop: vi.fn(), run: vi.fn(async () => ({ ok: true, stdout: '{"matched":false}' })) };
}
afterEach(async () => {
  for (const c of controllers.splice(0)) c.stop();
  for (const dir of directories.splice(0)) await rm(dir, { force: true, recursive: true });
  vi.clearAllMocks();
});

describe('managed script runner generation lifecycle', () => {
  it('stops idle PowerShell runners when rules are withdrawn and creates a new pool when enabled again', async () => {
    const { dataDir } = await setup();
    const pools: ScriptRunner[] = [];
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: () => {
      const powershell = fakeRunner(); pools.push(powershell); return { powershell };
    } });
    controllers.push(c);
    c.reload();
    expect(pools[0].warm).toHaveBeenCalledOnce();
    await c.evaluate(request);
    await writeRules(dataDir, []);
    c.reload();
    expect(pools[0].stop).toHaveBeenCalledOnce();
    expect(c.active).toBe(false);

    // Withdrawal also retires the old script file.
    await writeFile(join(managedScriptsDir(dataDir), managedScriptFileName(probe)), 'fixture');
    await writeRules(dataDir, [probe]);
    c.reload();
    expect(pools).toHaveLength(2);
    await expect(c.evaluate(request)).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['policy'] });
  });

  it('waits for in-flight old-generation work before stopping runners after withdrawal', async () => {
    const { dataDir, file } = await setup();
    const powershell = fakeRunner();
    let complete!: (result: ScriptRunResult) => void;
    vi.mocked(powershell.run).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: () => ({ powershell }) });
    controllers.push(c);
    c.reload();
    const inflight = c.evaluate(request);
    await writeRules(dataDir, []);
    c.reload();
    expect(c.evaluate(request)).toBeNull();
    expect(powershell.stop).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
    complete({ ok: true, stdout: '{"matched":true,"reason":"old verdict"}' });
    await expect(inflight).resolves.toMatchObject({ action: 'block', reason: 'old verdict' });
    expect(powershell.stop).toHaveBeenCalledOnce();
    expect(existsSync(file)).toBe(false);
  });

  it('releases runners when replaced by a pattern-only generation', async () => {
    const { dataDir } = await setup();
    const powershell = fakeRunner();
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: () => ({ powershell }) });
    controllers.push(c);
    c.reload();
    await writeRules(dataDir, [{ ...probe, kind: 'pattern', shell: undefined, match: 'substring', pattern: 'hello' }]);
    c.reload();
    expect(powershell.stop).toHaveBeenCalledOnce();
    await expect(c.evaluate(request)).resolves.toMatchObject({ action: 'block', ruleId: 'policy' });
  });

  it('swaps identical id/version scripts across target directories without stopping in-flight old runners', async () => {
    const oldScope = 'a'.repeat(64);
    const newScope = 'b'.repeat(64);
    const { dataDir, file: oldFile } = await setup(oldScope);
    const oldRunner = fakeRunner();
    const newRunner = fakeRunner();
    let complete!: (result: ScriptRunResult) => void;
    vi.mocked(oldRunner.run).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    vi.mocked(newRunner.run).mockResolvedValue({ ok: true, stdout: '{"matched":true,"reason":"new target"}' });
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: dir => ({
      powershell: dir.endsWith(oldScope) ? oldRunner : newRunner,
    }) });
    controllers.push(c);
    c.reload();
    const inflight = c.evaluate(request);
    const nextDir = managedScriptsDir(dataDir, newScope);
    await mkdir(nextDir, { recursive: true });
    await writeFile(join(nextDir, managedScriptFileName(probe)), 'new body');
    await writeRules(dataDir, [probe], newScope);
    c.reload();
    await expect(c.evaluate(request)).resolves.toMatchObject({ action: 'block', reason: 'new target' });
    expect(oldRunner.stop).not.toHaveBeenCalled();
    complete({ ok: true, stdout: '{"matched":true,"reason":"old target"}' });
    await expect(inflight).resolves.toMatchObject({ reason: 'old target' });
    expect(oldRunner.stop).toHaveBeenCalledOnce();
    expect(newRunner.stop).not.toHaveBeenCalled();
    expect(existsSync(oldFile)).toBe(false);
  });

  it('refuses previous-generation fallback across script cache targets', async () => {
    const oldScope = 'a'.repeat(64);
    const newScope = 'b'.repeat(64);
    const { dataDir } = await setup(oldScope);
    const powershell = fakeRunner();
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: () => ({ powershell }) });
    controllers.push(c);
    c.reload();
    await mkdir(managedScriptsDir(dataDir, newScope), { recursive: true });
    await writeRules(dataDir, [{ ...probe, version: '2' }], newScope);
    c.reload();
    expect(c.active).toBe(false);
    expect(c.evaluate(request)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked target cache directories', async () => {
    const scope = 'a'.repeat(64);
    const { dataDir } = await setup();
    const outside = join(dataDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, managedScriptFileName(probe)), 'fixture');
    await symlink(outside, managedScriptsDir(dataDir, scope));
    await writeRules(dataDir, [probe], scope);
    const c = new ManagedInterceptor({ dataDir, platform: 'win32', createRunners: () => ({ powershell: fakeRunner() }) });
    controllers.push(c);
    c.reload();
    expect(c.active).toBe(false);
  });
});

describe('managed HTTP placeholder warning', () => {
  it('warns once per published generation and keeps the existing fail-open behavior', async () => {
    const { dataDir } = await setup();
    await writeRules(dataDir, [{ ...probe, kind: 'http', shell: undefined, url: 'https://example.com/evaluate' }]);
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    c.reload();
    await expect(c.evaluate(request)).resolves.toMatchObject({ action: 'allow' });
    await c.evaluate(request);
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.warn).toHaveBeenCalledWith('managed HTTP rules are not implemented and will be skipped', {
      rules: ['policy@1'],
    });
  });
});
