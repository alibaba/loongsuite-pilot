import { existsSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInterceptorService, type InterceptorService } from '../../../src/interceptor/daemon/lifecycle.js';
import {
  MAX_RULE_SEVERITY_CHARS,
  managedInterceptorPath,
  managedScriptFileName,
  managedScriptsDir,
  parseManagedInterceptorConfig,
  platformManagedShell,
  type ManagedScriptRule,
} from '../../../src/interceptor/managed/config.js';
import { ManagedInterceptor } from '../../../src/interceptor/managed/controller.js';
import { ShScriptRunner } from '../../../src/interceptor/managed/sh-runner.js';
import { interceptorRuntimePath } from '../../../src/interceptor/paths.js';
import { collectHookText } from '../../../src/interceptor/rules/hook-text.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

// Synthetic low-entropy fixture; never use an issued credential in a test.
const SYNTHETIC_ACCESS_KEY = 'LTAI' + '0'.repeat(16);

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

function request(overrides: Partial<HookRequest> = {}): HookRequest {
  return { agent: 'qoder', event: 'UserPromptSubmit', prompt: 'hello', raw: {}, ...overrides };
}

function rule(id: string, version: string, overrides: Partial<ManagedScriptRule> = {}): ManagedScriptRule {
  return {
    kind: 'script',
    id,
    version,
    shell: 'sh',
    enforcement: 'enforce',
    agents: ['qoder'],
    events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
    ...overrides,
  };
}

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'managed-interceptor-'));
  await mkdir(managedScriptsDir(dataDir), { recursive: true });
  return dataDir;
}

async function writeRules(dataDir: string, rules: ManagedScriptRule[]): Promise<void> {
  await writeFile(managedInterceptorPath(dataDir), JSON.stringify({ interceptor: { rules } }));
}

async function writeScript(dataDir: string, r: ManagedScriptRule, body: string): Promise<string> {
  const file = join(managedScriptsDir(dataDir), managedScriptFileName(r));
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o600);
  return file;
}

const blockWith = (reason: string) => `cat >/dev/null; printf '%s\\n' '{"matched":true,"reason":"${reason}"}'`;
const ALLOW = `cat >/dev/null; printf '%s\\n' '{"matched":false}'`;

describe('platformManagedShell', () => {
  it('maps Windows to powershell and everyone else to sh', () => {
    expect(platformManagedShell('win32')).toBe('powershell');
    expect(platformManagedShell('darwin')).toBe('sh');
    expect(platformManagedShell('linux')).toBe('sh');
  });
});

describe('parseManagedInterceptorConfig', () => {
  it('only accepts a script cache namespace when local parsing is explicitly enabled', () => {
    const scriptCache = 'a'.repeat(64);
    const document = { interceptor: { rules: [], scriptCache } };
    expect(parseManagedInterceptorConfig(document)).not.toHaveProperty('scriptCache');
    expect(parseManagedInterceptorConfig(document, { allowLocalScriptCache: true }).scriptCache).toBe(scriptCache);
    for (const invalid of ['../outside', 'a'.repeat(63), 'A'.repeat(64), '/absolute']) {
      const malformed = { interceptor: { rules: [], scriptCache: invalid } };
      expect(parseManagedInterceptorConfig(malformed)).not.toHaveProperty('scriptCache');
      expect(() => parseManagedInterceptorConfig(malformed, { allowLocalScriptCache: true })).toThrow('SHA-256');
    }
  });

  it.each([
    { kind: 'pattern', match: 'regex', pattern: 'TOKEN', shell: 'future-shell' },
    { kind: 'script', shell: 'sh', match: 'future-match' },
    { kind: 'http', url: 'https://audit.example.com/', shell: 'future-shell' },
  ])('ignores extensions at every document level for $kind rules', extra => {
    const { kind } = extra;
    const base = { id: 'future', version: '1', agents: ['qoder'], events: ['PreToolUse'], ...extra };
    const parsed = parseManagedInterceptorConfig({
      revision: 2,
      interceptor: { agents: ['future-agent'], options: { enabled: true }, rules: [{
        ...base, path: '/bin/x', metadata: { future: [null, 1] },
      }] },
    });
    expect(parsed.rules[0]).toMatchObject({ id: 'future', kind, enforcement: 'enforce' });
    expect(parsed).not.toHaveProperty('revision');
    expect(parsed).not.toHaveProperty('options');
    expect(parsed.rules[0]).not.toHaveProperty('path');
    expect(parsed.rules[0]).not.toHaveProperty('metadata');
    if (kind !== 'script') expect(parsed.rules[0]).not.toHaveProperty('shell');
    if (kind !== 'pattern') expect(parsed.rules[0]).not.toHaveProperty('match');
  });

  it.each([
    { kind: 'pattern', match: 'substring', pattern: 'TOKEN' },
    { kind: 'script', shell: 'sh' },
    { kind: 'http', url: 'https://audit.example.com/' },
  ])('accepts optional severity metadata for $kind rules', extra => {
    const base = { id: 'risk', version: '1', agents: ['qoder'], events: ['PreToolUse'], ...extra };
    for (const severity of ['low', 'medium', 'high', 'critical', 'custom-risk', 'x'.repeat(MAX_RULE_SEVERITY_CHARS)]) {
      const parsed = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, severity: ` ${severity} ` }] } });
      expect(parsed.rules[0]).toMatchObject({ ...base, severity, enforcement: 'enforce' });
    }
    expect(parseManagedInterceptorConfig({ interceptor: { rules: [base] } }).rules[0]).not.toHaveProperty('severity');
  });

  it.each([null, '', '   ', 1, false, {}, [], 'x'.repeat(MAX_RULE_SEVERITY_CHARS + 1)])('rejects invalid severity %j', severity => {
    expect(() => parseManagedInterceptorConfig({
      interceptor: { rules: [{ ...rule('risk', '1'), severity }] },
    })).toThrow('interceptor.rules[0].severity');
  });

  it.each([['prompt'], [], ['message'], null, 'prompt'].map(fields => ({ fields })))('accepts and discards the retired fields key: $fields', ({ fields }) => {
    const base = rule('legacy', '1');
    expect(parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, fields }] } })).toEqual({ rules: [base] });
  });
  it('accepts the documented script shape', () => {
    expect(parseManagedInterceptorConfig({
      interceptor: {
        rules: [{
          kind: 'script',
          id: 'sensitive-info',
          shell: 'sh',
          version: '3',
          agents: ['qoder', 'qwen-work-cn', 'qoder'],
          events: ['UserPromptSubmit'],
          title: 'ak-leak',
          message: '不要在对话里粘贴 AccessKey',
        }],
      },
    })).toEqual({
      rules: [{
        kind: 'script',
        id: 'sensitive-info',
        shell: 'sh',
        version: '3',
        agents: ['qoder', 'qwen-work-cn'],
        events: ['UserPromptSubmit'],
        enforcement: 'enforce',
        title: 'ak-leak',
        message: '不要在对话里粘贴 AccessKey',
      }],
    });
  });

  it.each([
    ['missing interceptor', { rules: [] }],
    ['missing rule list', { interceptor: { options: {} } }],
    ['unknown rule kind', { interceptor: { rules: [{ ...rule('a', '1'), kind: 'future' }] } }],
    ['path in id', { interceptor: { rules: [rule('../x', '1')] } }],
    ['dot-dot id', { interceptor: { rules: [rule('..', '1')] } }],
    ['separator in version', { interceptor: { rules: [rule('a', '1@2')] } }],
    ['unknown shell', { interceptor: { rules: [rule('a', '1', { shell: 'bash' as 'sh' })] } }],
    ['unknown event', { interceptor: { rules: [rule('a', '1', { events: ['Stop' as 'PreToolUse'] })] } }],
    ['empty message', { interceptor: { rules: [rule('a', '1', { message: '   ' })] } }],
    ['empty title', { interceptor: { rules: [rule('a', '1', { title: '' })] } }],
    ['duplicate id', { interceptor: { rules: [rule('a', '1'), rule('a', '2')] } }],
    ['http without https', { interceptor: { rules: [{ kind: 'http', agents: ['qoder'], id: 'audit', version: '1', events: ['UserPromptSubmit'], url: 'http://audit.example.com' }] } }],
    ['missing rule agents', { interceptor: { rules: [{ ...rule('a', '1'), agents: undefined }] } }],
    ['empty rule agents', { interceptor: { rules: [rule('a', '1', { agents: [] })] } }],
    ['unknown agent', { interceptor: { rules: [rule('a', '1', { agents: ['cursor' as 'qoder'] })] } }],
  ])('rejects %s', (_name, doc) => {
    expect(() => parseManagedInterceptorConfig(doc)).toThrow();
  });

  it('accepts in-process regex and substring rules', () => {
    expect(parseManagedInterceptorConfig({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'internal-token',
          version: '1',
          events: ['UserPromptSubmit', 'PreToolUse'],
          match: 'regex',
          pattern: String.raw`INTERNAL_TOKEN\s*=\s*['"][^'"]+['"]`,
          message: '不要粘贴内部 token',
        }],
      },
    })).toEqual({
      rules: [{
        kind: 'pattern',
        agents: ['qoder'],
        id: 'internal-token',
        version: '1',
        events: ['UserPromptSubmit', 'PreToolUse'],
        enforcement: 'enforce',
        match: 'regex',
        pattern: String.raw`INTERNAL_TOKEN\s*=\s*['"][^'"]+['"]`,
        message: '不要粘贴内部 token',
      }],
    });
  });

  it.each([
    ['lookahead', String.raw`foo(?=bar)`],
    ['negative lookahead', String.raw`foo(?!bar)`],
    ['lookbehind', String.raw`(?<=foo)bar`],
    ['negative lookbehind', String.raw`(?<!foo)bar`],
    ['unclosed regex', '['],
    ['empty pattern', ''],
  ])('rejects pattern %s', (_name, pattern) => {
    expect(() => parseManagedInterceptorConfig({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'bad',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'regex',
          pattern,
        }],
      },
    })).toThrow();
  });

  it.each([
    ['unknown match', { match: 're', pattern: 'foo' }],
    ['missing match', { pattern: 'foo' }],
  ])('rejects pattern rule %s', (_name, extra) => {
    expect(() => parseManagedInterceptorConfig({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'bad',
          version: '1',
          events: ['UserPromptSubmit'],
          ...extra,
        }],
      },
    })).toThrow();
  });

  it('accepts a non-capturing group', () => {
    expect(parseManagedInterceptorConfig({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'ok',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'regex',
          pattern: String.raw`(?:foo|bar)\s+baz`,
        }],
      },
    }).rules[0].kind).toBe('pattern');
  });

  it('derives the script file name from id, version, and shell only', () => {
    expect(managedScriptFileName(rule('sensitive-info', '3'))).toBe('sensitive-info@3.sh');
    expect(managedScriptFileName(rule('sensitive-info', '3', { shell: 'powershell' }))).toBe('sensitive-info@3.ps1');
  });

  it('accepts pattern, script, and http in one list with unique ids', () => {
    const parsed = parseManagedInterceptorConfig({
      interceptor: {
        rules: [
          {
            kind: 'pattern',
            agents: ['qoder'],
            id: 'internal-token',
            version: '1',
            events: ['UserPromptSubmit'],
            match: 'substring',
            pattern: 'TOKEN',
          },
          rule('ak-leak-sh', '1'),
          {
            kind: 'http',
            agents: ['qoder'],
            id: 'audit',
            version: '1',
            events: ['UserPromptSubmit'],
            url: 'https://check.example.com/audit',
          },
        ],
      },
    });
    expect(parsed.rules.map(item => item.kind)).toEqual(['pattern', 'script', 'http']);
  });
});

describe('ManagedInterceptor pattern rules', () => {
  const controllers: ManagedInterceptor[] = [];
  afterEach(() => {
    for (const c of controllers.splice(0)) c.stop();
  });

  it.each([
    { pattern: String.raw`\.aliyun/config\.json`, hit: 'cat ~/.aliyun/config.json', miss: 'cat ~/.aliyun/configXjson' },
    { pattern: String.raw`\bTOKEN\s*=\s*\d+\b`, hit: 'TOKEN = 123', miss: 'TOKEN = abc' },
    { pattern: String.raw`C:\\Users\\[^\\]+\\\.kube\\config`, hit: String.raw`C:\Users\test\.kube\config`, miss: 'C:Userstest.kubeconfig' },
    { pattern: String.raw`\\n`, hit: String.raw`literal \n`, miss: 'actual newline\n' },
  ])('preserves regex $pattern through JSON persistence and evaluation', async ({ pattern, hit, miss }) => {
    const dataDir = await makeDataDir();
    const c = new ManagedInterceptor({ dataDir });
    try {
      const document = { interceptor: { rules: [{
        kind: 'pattern', id: 'escaped', version: '1', agents: ['qoder'], events: ['UserPromptSubmit'],
        match: 'regex', pattern,
      }] } };
      await writeFile(managedInterceptorPath(dataDir), JSON.stringify(document));
      const stored = JSON.parse(await readFile(managedInterceptorPath(dataDir), 'utf8'));
      expect(stored.interceptor.rules[0].pattern).toBe(pattern);
      c.reload();
      await expect(c.evaluate(request({ prompt: hit }))).resolves.toMatchObject({ action: 'block' });
      await expect(c.evaluate(request({ prompt: miss }))).resolves.toMatchObject({ action: 'allow' });
    } finally {
      c.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('collects the aggregate once for all rules in one request', async () => {
    const dataDir = await makeDataDir();
    const base = { kind: 'pattern', version: '1', agents: ['qoder'], events: ['UserPromptSubmit'], match: 'substring' };
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({ interceptor: { rules: [
      { ...base, id: 'first', pattern: 'absent-1' }, { ...base, id: 'second', pattern: 'absent-2' },
    ] } }));
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    let reads = 0;
    const req = request();
    Object.defineProperty(req, 'prompt', { get: () => { reads++; return 'hello'; } });
    await expect(c.evaluate(req)).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['first', 'second'] });
    expect(reads).toBe(1);
  });

  it('blocks in process and does not look for a script file', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'internal-token',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'regex',
          pattern: String.raw`INTERNAL_TOKEN\s*=\s*['"][^'"]+['"]`,
          message: '不要粘贴内部 token',
        }],
      },
    }));
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    expect(c.active).toBe(true);
    await expect(c.evaluate(request({ prompt: 'INTERNAL_TOKEN = "abc"' }))).resolves.toMatchObject({
      action: 'block',
      reason: '[PATTERN_BLOCKED]',
      ruleId: 'internal-token',
      ruleVersion: '1',
      message: '不要粘贴内部 token',
      evaluatedRules: ['internal-token'],
    });
    await expect(c.evaluate(request({ prompt: 'hello' }))).resolves.toMatchObject({
      action: 'allow',
      evaluatedRules: ['internal-token'],
    });
  });

  it('ignores legacy fields selection while preserving agents and events filters', async () => {
    const dataDir = await makeDataDir();
    const base = { kind: 'pattern', version: '1', events: ['PreToolUse'], match: 'substring', pattern: 'abc' };
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [
          { ...base, id: 'desktop', agents: ['qoder'], fields: ['prompt'] },
          { ...base, id: 'cli', agents: ['qodercli'], fields: ['tool_input'] },
        ],
      },
    }));
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    const toolCall = { event: 'PreToolUse' as const, prompt: undefined, toolName: 'Bash', toolInput: { command: 'echo abc' } };

    await expect(c.evaluate(request(toolCall))).resolves.toMatchObject({
      action: 'block', reason: '[PATTERN_BLOCKED]', ruleId: 'desktop', ruleVersion: '1', evaluatedRules: ['desktop'],
    });
    await expect(c.evaluate(request({ ...toolCall, prompt: 'abc' }))).resolves.toMatchObject({
      action: 'block', ruleId: 'desktop',
    });
    await expect(c.evaluate(request({ ...toolCall, agent: 'qodercli' }))).resolves.toMatchObject({
      action: 'block', ruleId: 'cli', evaluatedRules: ['cli'],
    });
    await expect(c.evaluate(request({ ...toolCall, toolInput: {}, toolResponse: { stdout: 'abc' } }))).resolves.toMatchObject({
      action: 'block', ruleId: 'desktop',
    });
    await expect(c.evaluate(request({ ...toolCall, event: 'PostToolUse' }))).resolves.toMatchObject({ action: 'allow', evaluatedRules: [] });
    await expect(c.evaluate(request({ ...toolCall, agent: 'openclaw' }))).resolves.toMatchObject({ action: 'allow', evaluatedRules: [] });
  });

  it('does not block the collector event loop on a catastrophic regex', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'catastrophic',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'regex',
          pattern: '(a+)+$',
          message: 'no',
        }],
      },
    }));
    const c = new ManagedInterceptor({ dataDir, regexTimeoutMs: 80 });
    controllers.push(c);
    c.reload();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const pending = c.evaluate(request({ prompt: `${'a'.repeat(30)}!` }));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(ticks).toBeGreaterThan(0);
    await expect(pending).resolves.toMatchObject({
      action: 'allow',
      failOpen: true,
      evaluatedRules: ['catastrophic'],
    });
    clearInterval(timer);
  });
});

describe('collectHookText', () => {
  it('aggregates all content in canonical order without scanning the raw envelope or metadata', () => {
    const req = request({ prompt: 'p', toolName: 'Bash', toolInput: { command: ['ls', 23, false, null, ''] },
      toolResponse: { out: 'r' }, raw: { prompt: 'raw-only' }, sessionId: 'session-only' });
    expect(collectHookText(req)).toBe('p\nBash\nls\n23\nfalse\nr');
  });

  it('limits nesting and tolerates cycles in tool content', () => {
    const input: Record<string, unknown> = { visible: 'root' };
    input.self = input;
    let nested: unknown = 'too deep';
    for (let i = 0; i < 40; i++) nested = { nested };
    input.deep = nested;
    expect(collectHookText(request({ prompt: undefined, toolInput: input, toolResponse: 'result' }))).toBe('root\nresult');
  });
});

describeUnix('ManagedInterceptor script execution', () => {
  const controllers: ManagedInterceptor[] = [];
  afterEach(() => {
    for (const c of controllers.splice(0)) c.stop();
    vi.unstubAllEnvs();
  });

  function controller(dataDir: string): ManagedInterceptor {
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    return c;
  }

  it('runs audit script side effects and switches enforcement without replacing its body', async () => {
    const dataDir = await makeDataDir();
    const r = rule('mode-switch', '1', { enforcement: 'audit', severity: 'HIGH' });
    const marker = join(dataDir, 'ran.txt');
    const file = await writeScript(dataDir, r, `printf 'ran' > '${marker}'; ${blockWith('observed')}`);
    const original = await readFile(file, 'utf8');
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', ruleId: r.id, severity: 'HIGH' });
    expect(await readFile(marker, 'utf8')).toBe('ran');
    await writeRules(dataDir, [{ ...r, severity: 'CRITICAL' }]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', enforcement: 'audit', severity: 'CRITICAL' });
    await writeRules(dataDir, [{ ...r, enforcement: 'enforce' }]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block', matched: true, enforcement: 'enforce', ruleId: r.id, severity: 'HIGH' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('is inactive without interceptor.json so the builtin rules keep running', async () => {
    const dataDir = await makeDataDir();
    expect(controller(dataDir).evaluate(request())).toBeNull();
  });

  it('feeds the script the same text as collectHookText and blocks on a match', async () => {
    const dataDir = await makeDataDir();
    const r = rule('echo', '1');
    const req = request({ event: 'PreToolUse', prompt: undefined, toolName: 'Bash', toolInput: { command: '张三 LTAI' } });
    const expected = JSON.stringify({ prompt: collectHookText(req) });
    await writeFile(join(dataDir, 'expected.json'), expected);
    await writeScript(dataDir, r, `input=$(cat)
if [ "$input" = "$(cat '${join(dataDir, 'expected.json')}')" ]; then
  printf '%s\\n' '{"matched":true,"reason":"same text"}'
else
  printf '%s\\n' '{"matched":false}'
fi`);
    await writeRules(dataDir, [r]);

    await expect(controller(dataDir).evaluate(req)).resolves.toMatchObject({
      action: 'block', reason: 'same text', ruleId: 'echo', ruleVersion: '1', evaluatedRules: ['echo'],
    });
  });

  it('feeds scripts the complete aggregate despite a legacy prompt-only selection', async () => {
    const dataDir = await makeDataDir();
    const r = { ...rule('aggregate', '1'), fields: ['prompt'] };
    await writeScript(dataDir, r, `input=$(cat)
if [ "$input" = '{"prompt":"hello\\nBash\\nls\\ntrue\\n42\\nresult"}' ]; then echo '{"matched":true,"reason":"complete input"}'; else echo '{"matched":false}'; fi`);
    await writeRules(dataDir, [r]);
    await expect(controller(dataDir).evaluate(request({
      event: 'PreToolUse', prompt: 'hello', toolName: 'Bash', toolInput: { command: 'ls', flag: true, count: 42 }, toolResponse: { stdout: 'result' },
    }))).resolves.toMatchObject({ action: 'block', reason: 'complete input' });
  });

  it('returns rule message and title with the script reason', async () => {
    const dataDir = await makeDataDir();
    const r = rule('echo', '2', { title: 'ak-leak', message: '不要在对话里粘贴 AccessKey' });
    await writeScript(dataDir, r, blockWith('flow-probe-v2'));
    await writeRules(dataDir, [r]);
    await expect(controller(dataDir).evaluate(request())).resolves.toMatchObject({
      action: 'block',
      reason: 'flow-probe-v2',
      ruleId: 'echo',
      ruleVersion: '2',
      title: 'ak-leak',
      message: '不要在对话里粘贴 AccessKey',
      evaluatedRules: ['echo'],
    });
  });

  it('skips rules whose agents or events do not include the hook', async () => {
    const dataDir = await makeDataDir();
    const r = rule('block', '1', { agents: ['qodercli'], events: ['PreToolUse'] });
    await writeScript(dataDir, r, blockWith('x'));
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);

    await expect(c.evaluate(request({ agent: 'qoder', event: 'PreToolUse' }))).resolves.toMatchObject({
      action: 'allow', evaluatedRules: [],
    });
    await expect(c.evaluate(request({ agent: 'qodercli', event: 'UserPromptSubmit' }))).resolves.toMatchObject({
      action: 'allow', evaluatedRules: [],
    });
    await expect(c.evaluate(request({ agent: 'qodercli', event: 'PreToolUse' }))).resolves.toMatchObject({
      action: 'block', ruleId: 'block', ruleVersion: '1',
    });
  });

  it('skips a failing rule and still runs the next one', async () => {
    const dataDir = await makeDataDir();
    const rules = [rule('noisy', '1'), rule('nonzero', '1'), rule('reasonless', '1'), rule('last', '1')];
    await writeScript(dataDir, rules[0], `cat >/dev/null; echo '{"matched":false}'; echo extra`);
    await writeScript(dataDir, rules[1], `cat >/dev/null; echo '{"matched":true,"reason":"no"}'; exit 3`);
    await writeScript(dataDir, rules[2], `cat >/dev/null; echo '{"matched":true}'`);
    await writeScript(dataDir, rules[3], blockWith('last'));
    await writeRules(dataDir, rules);

    await expect(controller(dataDir).evaluate(request())).resolves.toMatchObject({
      action: 'block',
      reason: 'last',
      ruleId: 'last',
      ruleVersion: '1',
      evaluatedRules: ['noisy', 'nonzero', 'reasonless', 'last'],
    });
  });

  it('kills a script at the shared budget, including its child processes', async () => {
    const dataDir = await makeDataDir();
    const slow = rule('slow', '1');
    const pidFile = join(dataDir, 'child.pid');
    await writeScript(dataDir, slow, `cat >/dev/null; sleep 5 & echo $! > '${pidFile}'; wait`);
    await writeRules(dataDir, [slow]);
    const c = new ManagedInterceptor({ dataDir, budgetMs: 300 });
    controllers.push(c);
    c.reload();

    const started = Date.now();
    await expect(c.evaluate(request())).resolves.toMatchObject({
      action: 'allow', evaluatedRules: ['slow'], failOpen: true,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    const childPid = Number((await readFile(pidFile, 'utf8')).trim());
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 1_000 });
  });

  it('reports fail-open when every rule failed', async () => {
    const dataDir = await makeDataDir();
    const r = rule('broken', '1');
    await writeScript(dataDir, r, 'cat >/dev/null; echo not-json');
    await writeRules(dataDir, [r]);
    await expect(controller(dataDir).evaluate(request())).resolves.toMatchObject({
      action: 'allow', evaluatedRules: ['broken'], failOpen: true,
    });
  });

  it('does not execute a script reached through a symlink', async () => {
    const dataDir = await makeDataDir();
    const outside = join(dataDir, 'outside.sh');
    await writeFile(outside, `#!/bin/sh\n${blockWith('escaped')}\n`);
    const r = rule('link', '1');
    symlinkSync(outside, join(managedScriptsDir(dataDir), managedScriptFileName(r)));
    await writeRules(dataDir, [r]);
    expect(controller(dataDir).evaluate(request())).toBeNull();
  });

  it('stays inactive when no rule can run on this platform', async () => {
    const dataDir = await makeDataDir();
    const r = rule('win-only', '1', { shell: 'powershell' });
    await writeFile(join(managedScriptsDir(dataDir), managedScriptFileName(r)), 'exit 0');
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);
    expect(c.active).toBe(false);
    expect(c.evaluate(request())).toBeNull();
  });

  it('drops a published script that was swapped for a symlink', async () => {
    const dataDir = await makeDataDir();
    const outside = join(dataDir, 'outside.sh');
    await writeFile(outside, `#!/bin/sh\n${blockWith('escaped')}\n`);
    const r = rule('swap', '1');
    const file = await writeScript(dataDir, r, ALLOW);
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['swap'] });

    await rm(file);
    symlinkSync(outside, file);
    // Before the next reload the engine refuses it at execution time.
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', evaluatedRules: [], failOpen: true });
    c.reload();
    expect(c.evaluate(request())).toBeNull();
  });

  it('a stopped sh runner refuses new scripts', async () => {
    const dataDir = await makeDataDir();
    const file = await writeScript(dataDir, rule('r', '1'), ALLOW);
    const runner = new ShScriptRunner();
    runner.stop();
    await expect(runner.run(file, '{}', 1_000)).resolves.toEqual({ ok: false, error: 'runner stopped' });
  });

  it('gives scripts no collector credentials from the environment', async () => {
    vi.stubEnv('LOONGSUITE_PILOT_SLS_ACCESS_KEY_SECRET', 'secret');
    const dataDir = await makeDataDir();
    const r = rule('env', '1');
    await writeScript(dataDir, r, `cat >/dev/null
if [ -n "$LOONGSUITE_PILOT_SLS_ACCESS_KEY_SECRET" ]; then echo '{"matched":true,"reason":"leaked"}'; else echo '{"matched":false}'; fi`);
    await writeRules(dataDir, [r]);
    await expect(controller(dataDir).evaluate(request())).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['env'] });
  });
});

describeUnix('ManagedInterceptor hot swap', () => {
  const controllers: ManagedInterceptor[] = [];
  afterEach(() => {
    for (const c of controllers.splice(0)) c.stop();
  });

  function controller(dataDir: string): ManagedInterceptor {
    const c = new ManagedInterceptor({ dataDir });
    controllers.push(c);
    c.reload();
    return c;
  }

  it('keeps enforcing the old version until the new body is on disk, then removes the old file', async () => {
    const dataDir = await makeDataDir();
    const v3 = rule('sensitive-info', '3');
    const v4 = rule('sensitive-info', '4');
    const v3File = await writeScript(dataDir, v3, blockWith('v3'));
    await writeRules(dataDir, [v3]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block', reason: 'v3' });

    // The rule list announces version 4 before its body arrives.
    await writeRules(dataDir, [v4]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block', reason: 'v3' });
    expect(existsSync(v3File)).toBe(true);

    await writeScript(dataDir, v4, blockWith('v4'));
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block', reason: 'v4' });
    expect(existsSync(v3File)).toBe(false);
  });

  it('keeps the previous rule scope until the new script body arrives', async () => {
    const dataDir = await makeDataDir();
    const v1 = rule('sensitive-info', '1', {
      title: 'v1-title',
      message: 'v1-message',
      agents: ['qoder'],
    });
    const v2 = rule('sensitive-info', '2', {
      title: 'v2-title',
      message: 'v2-message',
      agents: ['qoder', 'openclaw'],
    });
    await writeScript(dataDir, v1, blockWith('v1'));
    await writeRules(dataDir, [v1]);
    const c = controller(dataDir);

    await writeRules(dataDir, [v2]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({
      action: 'block',
      reason: 'v1',
      ruleId: 'sensitive-info',
      ruleVersion: '1',
      title: 'v1-title',
      message: 'v1-message',
      evaluatedRules: ['sensitive-info'],
    });
    await expect(c.evaluate(request({ agent: 'openclaw' }))).resolves.toMatchObject({
      action: 'allow',
      evaluatedRules: [],
    });
  });

  it('swaps the engine when only title or message changes', async () => {
    const dataDir = await makeDataDir();
    const r = rule('echo', '1');
    await writeScript(dataDir, r, blockWith('flow-probe-v1'));
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({
      action: 'block', reason: 'flow-probe-v1', ruleId: 'echo', ruleVersion: '1', evaluatedRules: ['echo'],
    });

    await writeRules(dataDir, [rule('echo', '1', {
      title: 'ak-leak',
      message: '不要在对话里粘贴 AccessKey',
    })]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({
      action: 'block',
      reason: 'flow-probe-v1',
      ruleId: 'echo',
      ruleVersion: '1',
      title: 'ak-leak',
      message: '不要在对话里粘贴 AccessKey',
      evaluatedRules: ['echo'],
    });
  });

  it('lets an in-flight hook finish on the old generation and deletes its file afterwards', async () => {
    const dataDir = await makeDataDir();
    const v1 = rule('slow', '1');
    const v2 = rule('slow', '2');
    const v1File = await writeScript(dataDir, v1, `sleep 0.4; ${blockWith('v1')}`);
    await writeRules(dataDir, [v1]);
    const c = controller(dataDir);

    const inflight = c.evaluate(request())!;
    await writeScript(dataDir, v2, blockWith('v2'));
    await writeRules(dataDir, [v2]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ reason: 'v2' });
    expect(existsSync(v1File)).toBe(true);

    await expect(inflight).resolves.toMatchObject({ reason: 'v1' });
    expect(existsSync(v1File)).toBe(false);
  });

  it('swaps in complete rules from a list while a brand-new id waits for its body', async () => {
    const dataDir = await makeDataDir();
    const ready = rule('ready', '1');
    const fresh = rule('fresh', '1');
    await writeScript(dataDir, ready, ALLOW);
    await writeRules(dataDir, [fresh, ready]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['ready'] });

    await writeScript(dataDir, fresh, blockWith('fresh'));
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block', ruleId: 'fresh' });
  });

  it('stops a rule the server removed and deletes its script', async () => {
    const dataDir = await makeDataDir();
    const keep = rule('keep', '1');
    const gone = rule('gone', '1');
    await writeScript(dataDir, keep, ALLOW);
    const goneFile = await writeScript(dataDir, gone, blockWith('gone'));
    await writeRules(dataDir, [keep, gone]);
    const c = controller(dataDir);
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block' });

    await writeRules(dataDir, [keep]);
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'allow', evaluatedRules: ['keep'] });
    expect(existsSync(goneFile)).toBe(false);
  });

  it('keeps the last good rules when interceptor.json on disk is invalid, and goes inactive when it is removed', async () => {
    const dataDir = await makeDataDir();
    const r = rule('r', '1');
    await writeScript(dataDir, r, blockWith('r'));
    await writeRules(dataDir, [r]);
    const c = controller(dataDir);

    await writeFile(managedInterceptorPath(dataDir), '{"interceptor":{"rules":null,"x":1}}');
    c.reload();
    await expect(c.evaluate(request())).resolves.toMatchObject({ action: 'block' });

    await rm(managedInterceptorPath(dataDir));
    c.reload();
    expect(c.active).toBe(false);
    expect(c.evaluate(request())).toBeNull();
  });

  it('does not rebuild the engine when nothing resolved changed', async () => {
    const dataDir = await makeDataDir();
    const r = rule('r', '1');
    await writeScript(dataDir, r, ALLOW);
    await writeRules(dataDir, [r]);
    const onActiveChange = vi.fn();
    const c = new ManagedInterceptor({ dataDir, onActiveChange });
    controllers.push(c);
    c.reload();
    const first = (c as unknown as { current: unknown }).current;
    c.reload();
    c.reload();
    expect((c as unknown as { current: unknown }).current).toBe(first);
    expect(onActiveChange).toHaveBeenCalledTimes(1);
  });
});

describeUnix('interceptor service with managed rules', () => {
  const services: InterceptorService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.stop();
  });

  async function evaluate(port: number, body: HookRequest): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return res.json();
  }

  it.each(['none', undefined, 'custom'] as const)('ignores cached and newly published rules when mode is %s', async mode => {
    const dataDir = await makeDataDir();
    const r = rule('r', '1');
    await writeScript(dataDir, r, blockWith('managed'));
    await writeRules(dataDir, [r]);
    const configPath = join(dataDir, 'config.json');
    await writeFile(configPath, JSON.stringify(mode === undefined ? {} : { interceptor: { mode } }));
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', configPath);
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', '');
    const service = await startInterceptorService({ dataDir, version: '9.9.9', managedReloadIntervalMs: 10 });
    services.push(service);
    expect(service.port).toBeNull();
    expect(service.managedActive).toBe(false);
    await writeRules(dataDir, [rule('new', '2')]);
    await service.reloadManaged();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(service.port).toBeNull();
    expect(service.managedActive).toBe(false);
    expect(existsSync(interceptorRuntimePath(dataDir))).toBe(false);
    expect(existsSync(managedInterceptorPath(dataDir))).toBe(true);
  });

  it('keeps the builtin rules when only rules for another platform arrive', async () => {
    const dataDir = await makeDataDir();
    const r = rule('win-only', '1', { shell: 'powershell' });
    await writeFile(join(managedScriptsDir(dataDir), managedScriptFileName(r)), 'exit 0');
    await writeRules(dataDir, [r]);
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    await expect(evaluate(service.port!, request({ prompt: `key ${SYNTHETIC_ACCESS_KEY}` })))
      .resolves.toMatchObject({ action: 'block', ruleId: 'cloudAccessKey' });
  });

  it('can start again after the runtime directory bind failure is repaired', async () => {
    const dataDir = await makeDataDir();
    const r = rule('r', '1');
    await writeScript(dataDir, r, blockWith('managed'));
    await writeRules(dataDir, [r]);
    const runtimeDir = join(dataDir, 'interceptor');
    await writeFile(runtimeDir, 'not a directory');
    await expect(startInterceptorService({ dataDir, version: '9.9.9', mode: 'all' })).rejects.toThrow();
    await rm(runtimeDir);
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all' });
    services.push(service);
    await expect(evaluate(service.port!, request())).resolves.toMatchObject({ action: 'block', reason: 'managed' });
    await writeRules(dataDir, []);
    await service.reloadManaged();
    expect(service.port).not.toBeNull();
    expect(service.managedActive).toBe(false);
  });

  it('runs builtin rules first and skips managed scripts when they block', async () => {
    const dataDir = await makeDataDir();
    const r = rule('allow-all', '1');
    await writeScript(dataDir, r, ALLOW);
    await writeRules(dataDir, [r]);
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    const leaky = request({ prompt: `key ${SYNTHETIC_ACCESS_KEY}` });

    const blocked = await evaluate(service.port!, leaky) as { action: string; ruleId?: string; evaluatedRules: string[] };
    expect(blocked).toMatchObject({ action: 'block', ruleId: 'cloudAccessKey' });
    expect(blocked.evaluatedRules).not.toContain('allow-all');

    const allowed = await evaluate(service.port!, request({ prompt: 'hello' })) as { action: string; evaluatedRules: string[] };
    expect(allowed.action).toBe('allow');
    expect(allowed.evaluatedRules).toContain('allow-all');
  });

  it('evaluates pattern rules in process without a script file', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'internal-token',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'regex',
          pattern: String.raw`INTERNAL_TOKEN\s*=\s*['"][^'"]+['"]`,
          message: '不要粘贴内部 token',
        }],
      },
    }));
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    expect(service.managedActive).toBe(true);
    expect(existsSync(join(managedScriptsDir(dataDir), 'internal-token@1.sh'))).toBe(false);
    await expect(evaluate(service.port!, request({ prompt: 'INTERNAL_TOKEN = "abc"' }))).resolves.toMatchObject({
      action: 'block',
      reason: '[PATTERN_BLOCKED]',
      ruleId: 'internal-token',
      message: '不要粘贴内部 token',
    });
    await expect(evaluate(service.port!, request({ prompt: 'hello' }))).resolves.toMatchObject({
      action: 'allow',
    });
  });

  it('treats substring patterns as literals', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'dot',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'substring',
          pattern: 'foo.bar',
        }],
      },
    }));
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    await expect(evaluate(service.port!, request({ prompt: 'xxfoo.barxx' }))).resolves.toMatchObject({
      action: 'block',
      ruleId: 'dot',
    });
    await expect(evaluate(service.port!, request({ prompt: 'xxfooXbarxx' }))).resolves.toMatchObject({
      action: 'allow',
    });
  });

  it('keeps the builtin listener when the pattern rule list is empty', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: { rules: [] },
    }));
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    expect(service.managedActive).toBe(false);
    expect(service.port).not.toBeNull();
  });

  it('runs builtin rules first and skips pattern rules when they block', async () => {
    const dataDir = await makeDataDir();
    await writeFile(managedInterceptorPath(dataDir), JSON.stringify({
      interceptor: {
        rules: [{
          kind: 'pattern',
          agents: ['qoder'],
          id: 'allow-all',
          version: '1',
          events: ['UserPromptSubmit'],
          match: 'substring',
          pattern: 'LTAI',
          message: 'pattern would also hit',
        }],
      },
    }));
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);
    const leaky = request({ prompt: `key ${SYNTHETIC_ACCESS_KEY}` });
    const blocked = await evaluate(service.port!, leaky) as { action: string; ruleId?: string; evaluatedRules: string[] };
    expect(blocked).toMatchObject({ action: 'block', ruleId: 'cloudAccessKey' });
    expect(blocked.evaluatedRules).not.toContain('allow-all');
  });

  it('runs managed scripts after the builtin layer allows', async () => {
    const dataDir = await makeDataDir();
    const r = rule('policy', '1');
    await writeScript(dataDir, r, blockWith('managed'));
    await writeRules(dataDir, [r]);
    const service = await startInterceptorService({ dataDir, version: '9.9.9', mode: 'all', managedReloadIntervalMs: 60_000 });
    services.push(service);

    await expect(evaluate(service.port!, request({ prompt: 'hello' }))).resolves.toMatchObject({
      action: 'block',
      reason: 'managed',
      ruleId: 'policy',
    });
  });
});
