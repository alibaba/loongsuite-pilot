import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { runHook } from '../../../src/interceptor/cli/hook.js';
import { createInterceptorServer } from '../../../src/interceptor/daemon/server.js';
import { ManagedRuleEngine } from '../../../src/interceptor/managed/engine.js';
import { parseManagedInterceptorConfig } from '../../../src/interceptor/managed/config.js';
import type { AgentDefinition, AgentActivityEntry } from '../../../src/types/index.js';

const dirs: string[] = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'pilot-cn-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Qoder CN interception', () => {
  it('installs the shipped declaration at head and removes interception without losing collection or third-party hooks', async () => {
    const dir = temp();
    const def: AgentDefinition = JSON.parse(readFileSync(resolve('agents.d/qoder-cn.json'), 'utf8')
      .replaceAll('$PILOT_DATA', dir).replaceAll('~/.qoder-cn', join(dir, '.qoder-cn')));
    const file = def.hook!.settingsPath;
    mkdirSync(join(dir, '.qoder-cn'));
    writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'third-party' }] }] } }));
    const manager = new HookManager(join(dir, 'hooks'), join(dir, 'logs'));
    const on = new HookStrategy(manager, { deployInterceptorHooks: true });
    const commands = (event: string) => JSON.parse(readFileSync(file, 'utf8')).hooks[event]
      .flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map(hook => hook.command));
    expect((await on.deploy(def)).success).toBe(true);
    const installed = readFileSync(file, 'utf8');
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
      expect(commands(event)[0]).toBe(def.hook!.interceptor!.hookCommand);
      expect(commands(event)).toContain(def.hook!.hookCommand);
    }
    expect(commands('PreToolUse')).toContain('third-party');
    expect((await on.deploy(def)).success).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(installed);
    const off = new HookStrategy(manager, { deployInterceptorHooks: false });
    expect((await off.deploy(def)).success).toBe(true);
    for (const event of def.hook!.events) {
      expect(commands(event)).toContain(def.hook!.hookCommand);
      expect(commands(event)).not.toContain(def.hook!.interceptor!.hookCommand);
    }
    expect(commands('PreToolUse')).toContain('third-party');
    await expect(off.needsDeploy(def)).resolves.toBe(false);
  });

  it.each([
    ['qoder-cn', undefined], ['qoderclicn', undefined], ['qoderclicn', 'cli'], ['qoder-cn', 'app'],
  ] as const)('runs %s product %s through CLI, HTTP and managed rules with CN blocked identity', async (surface, product) => {
    const entries: AgentActivityEntry[] = [];
    const engine = new ManagedRuleEngine({ rules: [], runners: {}, config: parseManagedInterceptorConfig({ interceptor: {
      rules: [{ id: 'cn-policy', version: '1', agents: ['qoder-cn', 'qoderclicn'], events: ['UserPromptSubmit'],
        kind: 'pattern', match: 'substring', keywords: ['secret'] }],
    } }) });
    const options = { port: 0, version: 'test', engine,
      emitBlockedPrompt: (entry: AgentActivityEntry) => { entries.push(entry); } };
    const server = createInterceptorServer(options);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    options.port = address.port;
    const runtimePath = join(temp(), 'runtime.json');
    writeFileSync(runtimePath, JSON.stringify({ service: 'loongsuite-pilot-interceptor', status: 'ok',
      pid: process.pid, version: 'test', daemon_port: address.port }));
    const stdout: string[] = [];
    try {
      expect(await runHook(['--agent', 'qoder-cn-auto'], { runtimePath,
        resolveCnSurface: () => product ? (surface === 'qoder-cn' ? 'qoderclicn' : 'qoder-cn') : surface,
        log: () => undefined, writeStdout: text => { stdout.push(text); },
        readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'cn-session', prompt: 'secret',
          ...(product ? { parent_business_info: { product } } : {}) }),
      })).toBe(0);
      expect(JSON.parse(stdout[0]).decision).toBe(surface === 'qoder-cn' ? 'block' : 'deny');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ 'gen_ai.agent.type': 'qoder-cn', 'gen_ai.guardrail.rule_id': 'cn-policy' });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.skipIf(process.platform === 'win32')('forwards explicit CN target and stdin through the shipped bash wrapper', () => {
    const dir = temp();
    const hooks = join(dir, 'hooks'); mkdirSync(hooks);
    const script = join(hooks, 'interceptor-hook.sh');
    copyFileSync(resolve('assets/hooks/interceptor-hook.sh'), script);
    writeFileSync(join(dir, 'node-bin'), process.execPath);
    const cli = join(dir, 'capture.cjs');
    writeFileSync(cli, "console.log(JSON.stringify({args:process.argv.slice(2),stdin:require('fs').readFileSync(0,'utf8')}))");
    for (const args of [[], ['--agent', 'qoder-cn-auto']]) {
      const result = spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', input: '{"prompt":"中文"}',
        env: { ...process.env, LOONGSUITE_PILOT_CACHE_DIR: dir, INTERCEPTOR_CLI: cli } });
      expect(result.status).toBe(0); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ args: ['hook', '--agent', args.length ? 'qoder-cn-auto' : 'qoder-auto'], stdin: '{"prompt":"中文"}' });
    }
  });
});
