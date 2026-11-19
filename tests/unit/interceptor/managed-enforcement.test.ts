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
const pattern = (id: string, enforcement?: string) => ({ ...base, kind: 'pattern', id, match: 'substring', pattern: 'MATCH',
  ...(enforcement === undefined ? {} : { enforcement }), title: id, message: `reminder ${id}` });
function engine(rules: unknown[], options: Record<string, unknown> = {}): ManagedRuleEngine {
  return new ManagedRuleEngine({ config: parseManagedInterceptorConfig({ interceptor: { rules } }), rules: [], runners: {}, ...options });
}

describe('managed enforcement', () => {
  it('defaults omitted enforcement to enforce and rejects other values', () => {
    expect(parseManagedInterceptorConfig({ interceptor: { rules: [pattern('default')] } }).rules[0].enforcement).toBe('enforce');
    for (const enforcement of [null, '', 'observe', 0, false]) {
      expect(() => parseManagedInterceptorConfig({ interceptor: { rules: [{ ...pattern('bad'), enforcement }] } })).toThrow('enforcement');
    }
  });

  it('keeps audits before the first enforced match and stops there', async () => {
    const result = await engine([pattern('audit-1', 'audit'), pattern('block'), pattern('unreached', 'audit')]).evaluate(request);
    expect(result).toEqual({ action: 'block', matched: true, enforcement: 'enforce', ruleId: 'block', ruleVersion: '1',
      reason: '[PATTERN_BLOCKED]', title: 'block', message: 'reminder block', evaluatedRules: ['audit-1', 'block'],
      matches: [
        { matched: true, enforcement: 'audit', action: 'allow', ruleId: 'audit-1', ruleVersion: '1', reason: '[PATTERN_BLOCKED]', title: 'audit-1', message: 'reminder audit-1' },
        { matched: true, enforcement: 'enforce', action: 'block', ruleId: 'block', ruleVersion: '1', reason: '[PATTERN_BLOCKED]', title: 'block', message: 'reminder block' },
      ] });
  });

  it('preserves each severity and selects the blocking rule severity for the final verdict', async () => {
    const result = await engine([
      { ...pattern('observe', 'audit'), severity: 'HIGH' },
      { ...pattern('block'), severity: 'CRITICAL' },
    ]).evaluate(request);
    expect(result).toMatchObject({ action: 'block', severity: 'CRITICAL',
      matches: [{ ruleId: 'observe', severity: 'HIGH' }, { ruleId: 'block', severity: 'CRITICAL' }] });
  });

  it('allows multiple audits, preserving all matches and the first representative', async () => {
    const result = await engine([pattern('first', 'audit'), pattern('second', 'audit')]).evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', ruleId: 'first', evaluatedRules: ['first', 'second'] });
    expect(result.matches!.map(match => [match.ruleId, match.enforcement, match.action])).toEqual([
      ['first', 'audit', 'allow'], ['second', 'audit', 'allow'],
    ]);
    expect(result.failOpen).toBeUndefined();
  });

  it('applies audit semantics to regex hits too', async () => {
    const test = vi.fn(async () => true);
    const result = await engine([{ ...pattern('regex', 'audit'), match: 'regex' }], { regex: { test } }).evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', ruleId: 'regex' });
    expect(result.matches).toHaveLength(1);
    expect(test).toHaveBeenCalledWith('MATCH', 'MATCH', expect.any(Number), expect.any(Function));
  });

  it('reports matched=false only after a complete check without a hit', async () => {
    expect(await engine([pattern('audit', 'audit')]).evaluate({ ...request, prompt: 'nothing' })).toEqual({
      action: 'allow', matched: false, matches: [], evaluatedRules: ['audit'],
    });
    const timedOut = await engine([pattern('audit', 'audit')], { budgetMs: 0 }).evaluate(request);
    expect(timedOut).toEqual({ action: 'allow', failOpen: true, matches: [], evaluatedRules: [] });
    expect(timedOut).not.toHaveProperty('matched');
  });

  it('retains audit matches when the shared budget expires before another substring rule', async () => {
    const evaluator = engine([pattern('first', 'audit'), pattern('second', 'audit')], { budgetMs: 10 });
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(11);
    const result = await evaluator.evaluate(request);
    expect(result).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', failOpen: true,
      ruleId: 'first', evaluatedRules: ['first'] });
    expect(result.matches).toHaveLength(1);
  });

  it('retains audit matches after a later script timeout or rejected runner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enforcement-'));
    dirs.push(dir);
    const file = join(dir, 'rule.sh');
    await writeFile(file, 'unused');
    const rules = parseManagedInterceptorConfig({ interceptor: { rules: [pattern('audit', 'audit'), {
      ...base, id: 'broken', kind: 'script', shell: 'sh',
    }] } }).rules;
    const script = rules[1] as Extract<ManagedRule, { kind: 'script' }>;
    for (const run of [vi.fn(async () => ({ ok: false as const, error: 'timeout' })), vi.fn(async () => { throw new Error('runner failed'); })]) {
      const evaluator = new ManagedRuleEngine({ config: { rules }, rules: [{ rule: script, file, shell: 'sh' }], runners: { sh: { run, stop() {} } } });
      const result = await evaluator.evaluate(request);
      expect(result).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', ruleId: 'audit', failOpen: true });
      expect(result.matches).toHaveLength(1);
      expect(run).toHaveBeenCalledOnce();
    }
  });
});
