import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseManagedInterceptorConfig, type ManagedRule } from '../../../src/interceptor/managed/config.js';
import { ManagedRuleEngine } from '../../../src/interceptor/managed/engine.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const request: HookRequest = { agent: 'qoder', event: 'PreToolUse', prompt: 'MATCH', raw: {} };
const base = { version: '1', agents: ['qoder'], events: ['PreToolUse'] };
const pattern = (id: string, action?: string) => ({ ...base, kind: 'pattern', id, match: 'substring', keywords: ['MATCH'],
  ...(action === undefined ? {} : { action }), title: id, message: `reminder ${id}` });
function engine(rules: unknown[], options: Record<string, unknown> = {}): ManagedRuleEngine {
  return new ManagedRuleEngine({ config: parseManagedInterceptorConfig({ interceptor: { rules } }), rules: [], runners: {}, ...options });
}

describe('managed action', () => {
  it('defaults omitted action to block and rejects other values', () => {
    expect(parseManagedInterceptorConfig({ interceptor: { rules: [pattern('default')] } }).rules[0].action).toBe('block');
    for (const action of [null, '', 'observe', 'allow', 'warn', 'enforce', 'audit', 0, false]) {
      expect(() => parseManagedInterceptorConfig({ interceptor: { rules: [{ ...pattern('bad'), action }] } })).toThrow('action');
    }
  });

  it('rejects the enforcement field instead of translating it', () => {
    for (const enforcement of ['enforce', 'audit']) {
      expect(() => parseManagedInterceptorConfig({ interceptor: { rules: [{
        ...pattern('unsupported'), enforcement,
      }] } })).toThrow('unknown keys: enforcement');
    }
  });

  it('keeps audits before the first enforced match and stops there', async () => {
    const result = await engine([pattern('audit-1', 'log'), pattern('block'), pattern('unreached', 'log')]).evaluate(request);
    expect(result).toEqual({ action: 'block', matched: true, ruleId: 'block', ruleVersion: '1',
      reason: '[PATTERN_BLOCKED]', title: 'block', message: 'reminder block', evaluatedRules: ['audit-1', 'block'],
      matches: [
        { matched: true, action: 'log', ruleId: 'audit-1', ruleVersion: '1', reason: '[PATTERN_BLOCKED]', title: 'audit-1', message: 'reminder audit-1' },
        { matched: true, action: 'block', ruleId: 'block', ruleVersion: '1', reason: '[PATTERN_BLOCKED]', title: 'block', message: 'reminder block' },
      ] });
  });

  it('preserves each severity and selects the blocking rule severity for the final verdict', async () => {
    const result = await engine([
      { ...pattern('observe', 'log'), severity: 'HIGH' },
      { ...pattern('block'), severity: 'CRITICAL' },
    ]).evaluate(request);
    expect(result).toMatchObject({ action: 'block', severity: 'CRITICAL',
      matches: [{ ruleId: 'observe', severity: 'HIGH' }, { ruleId: 'block', severity: 'CRITICAL' }] });
  });

  it('allows multiple audits, preserving all matches and the first representative', async () => {
    const result = await engine([pattern('first', 'log'), pattern('second', 'log')]).evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, ruleId: 'first', evaluatedRules: ['first', 'second'] });
    expect(result.matches!.map(match => [match.ruleId, match.action])).toEqual([
      ['first', 'log'], ['second', 'log'],
    ]);
    expect(result.failOpen).toBeUndefined();
  });

  it('applies audit semantics to regex hits too', async () => {
    const test = vi.fn(async () => true);
    const result = await engine([{ ...pattern('regex', 'log'), match: 'regex', pattern: 'MATCH' }], { regex: { test } }).evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, ruleId: 'regex' });
    expect(result.matches).toHaveLength(1);
    expect(test).toHaveBeenCalledWith('MATCH', 'MATCH', expect.any(Number), expect.any(Function));
  });

  it('reports matched=false only after a complete check without a hit', async () => {
    expect(await engine([pattern('audit', 'log')]).evaluate({ ...request, prompt: 'nothing' })).toEqual({
      action: 'allow', matched: false, matches: [], evaluatedRules: ['audit'],
    });
    const timedOut = await engine([pattern('audit', 'log')], { budgetMs: 0 }).evaluate(request);
    expect(timedOut).toEqual({ action: 'allow', failOpen: true, matches: [], evaluatedRules: [] });
    expect(timedOut).not.toHaveProperty('matched');
  });

  it('retains audit matches when the shared budget expires before another substring rule', async () => {
    const evaluator = engine([pattern('first', 'log'), pattern('second', 'log')], { budgetMs: 10 });
    // Deadline, first rule, first keyword before/after scan; next rule is expired.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0)
      .mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(11);
    const result = await evaluator.evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, failOpen: true,
      ruleId: 'first', evaluatedRules: ['first'] });
    expect(result.matches).toHaveLength(1);
  });

  it.each([false, true])('stops within a keyword list when the budget expires (prior audit=%s)', async priorAudit => {
    const evaluator = engine([
      ...(priorAudit ? [pattern('audit', 'log')] : []),
      { ...pattern('list'), keywords: ['absent', 'MATCH'] },
      pattern('unreached'),
    ], { budgetMs: 10 });
    // Allow the audit, rule entry and first scan, then expire before the matching keyword.
    const clock = vi.spyOn(Date, 'now');
    for (let i = 0; i < (priorAudit ? 7 : 4); i++) clock.mockReturnValueOnce(0);
    clock.mockReturnValue(10);
    const result = await evaluator.evaluate(request);
    expect(result).toMatchObject({ action: 'allow', failOpen: true,
      evaluatedRules: priorAudit ? ['audit', 'list'] : ['list'] });
    expect(result.matches!.map(match => match.ruleId)).toEqual(priorAudit ? ['audit'] : []);
    if (priorAudit) expect(result).toMatchObject({ matched: true, ruleId: 'audit' });
    else expect(result).not.toHaveProperty('matched');
  });

  it.each(['MATCH', 'absent'])('fails open when the final keyword scan exhausts the budget (%s)', async keyword => {
    const evaluator = engine([{ ...pattern('list'), keywords: [keyword] }, pattern('unreached')], { budgetMs: 10 });
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10);
    const result = await evaluator.evaluate(request);
    expect(result).toEqual({ action: 'allow', failOpen: true, matches: [], evaluatedRules: ['list'] });
  });

  it('retains audit matches after a later script timeout or rejected runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'action-'));
    dirs.push(dir);
    const file = join(dir, 'rule.sh');
    await writeFile(file, 'unused');
    const rules = parseManagedInterceptorConfig({ interceptor: { rules: [pattern('audit', 'log'), {
      ...base, id: 'broken', kind: 'script', shell: 'sh',
    }] } }).rules;
    const script = rules[1] as Extract<ManagedRule, { kind: 'script' }>;
    for (const run of [vi.fn(async () => ({ ok: false as const, error: 'timeout' })), vi.fn(async () => { throw new Error('runner failed'); })]) {
      const evaluator = new ManagedRuleEngine({ config: { rules }, rules: [{ rule: script, file, shell: 'sh' }], runners: { sh: { run, stop() {} } } });
      const result = await evaluator.evaluate(request);
      expect(result).toMatchObject({ action: 'allow', matched: true, ruleId: 'audit', failOpen: true });
      expect(result.matches).toHaveLength(1);
      expect(run).toHaveBeenCalledOnce();
    }
  });
});
