import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseManagedInterceptorConfig, patternRuleMatches, buildSubstringMatchPlan, SUBSTRING_REGEX_CHUNK_CHARS,
  type SubstringMatchPlan } from '../../../src/interceptor/managed/config.js';
import { ManagedRuleEngine } from '../../../src/interceptor/managed/engine.js';
import { ManagedRegexRunner } from '../../../src/interceptor/managed/regex-runner.js';

const runners: ManagedRegexRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stop(); });
const base = { kind: 'pattern', id: 'literal', version: '1', agents: ['qoder'], events: ['UserPromptSubmit'], match: 'substring' };
const request = { agent: 'qoder' as const, event: 'UserPromptSubmit' as const, prompt: '', raw: {} };

const planMatches = (plan: SubstringMatchPlan, text: string) => plan.steps.some(step =>
  step.kind === 'literal' ? text.includes(step.text) : new RegExp(step.source).test(text));

describe('substring match plan', () => {
  it('escapes metacharacters and preserves Unicode, whitespace and UTF-16 literals in the Worker', async () => {
    const keywords = ['.*+?^${}()|[]\\', '/', '-', '中文', ' spaced ', '\n\t\0', '\uD800', '\uDC00', '😀'];
    const source = buildSubstringMatchPlan(keywords);
    const runner = new ManagedRegexRunner(1000);
    runners.push(runner);
    for (const keyword of keywords) await expect(runner.test(source, `prefix${keyword}suffix`)).resolves.toBe(true);
    for (const miss of ['unrelated', 'SPACED', 'spaced', 'abc']) await expect(runner.test(source, miss)).resolves.toBe(false);
    // includes can match a single surrogate code unit inside a paired character.
    await expect(runner.test(buildSubstringMatchPlan(['\uD83D']), '😀')).resolves.toBe(true);
    await expect(runner.test(buildSubstringMatchPlan([]), 'anything')).resolves.toBe(false);
    await expect(runner.test(buildSubstringMatchPlan([]), '')).resolves.toBe(false);
  });

  it('agrees with includes for seeded literal keyword sets and texts', () => {
    let seed = 739;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const alphabet = ['a', 'B', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '-', '\n', '\0', ' ', '中', '\uD800', '\uDC00'];
    const word = () => Array.from({ length: next() % 7 + 1 }, () => alphabet[next() % alphabet.length]).join('');
    for (let i = 0; i < 500; i++) {
      const keywords = Array.from({ length: next() % 8 + 1 }, () => word().repeat(i % 10 === 0 ? 200 : 1));
      const text = i % 2 ? word() + keywords[next() % keywords.length] + word() : word();
      const expected = keywords.some(keyword => text.includes(keyword));
      expect(planMatches(buildSubstringMatchPlan(keywords), text)).toBe(expected);
      const rule = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, keywords }] } }).rules[0];
      if (rule.kind !== 'pattern') throw new Error('expected pattern');
      expect(patternRuleMatches(rule, text)).toBe(expected);
    }
  });

  it('builds one bounded plan per generation while accepting expanded terms above the chunk budget', async () => {
    const keywords = ['a.'.repeat(1000), 'b*'.repeat(1000)];
    const config = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, keywords }] } });
    const rule = config.rules[0];
    if (rule.kind !== 'pattern' || rule.match !== 'substring') throw new Error('expected substring');
    const iterate = vi.spyOn(rule.keywords, Symbol.iterator);
    const test = vi.fn(async (_plan: string | SubstringMatchPlan) => false);
    const engine = new ManagedRuleEngine({ config, rules: [], runners: {}, regex: { test } as unknown as ManagedRegexRunner });
    expect(iterate).toHaveBeenCalledOnce();
    await engine.evaluate(request);
    await engine.evaluate(request);
    expect(iterate).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledTimes(2);
    expect(test.mock.calls[0][0]).toEqual(buildSubstringMatchPlan(keywords));
    expect(test.mock.calls[0][0]).toBe(test.mock.calls[1][0]);
    expect((test.mock.calls[0][0] as SubstringMatchPlan).steps.map(step => step.kind)).toEqual(['literal', 'literal']);
    iterate.mockRestore();
  });

  it('runs scoped rules in order, preserves logs and stops at the first blocking keyword list', async () => {
    const config = parseManagedInterceptorConfig({ interceptor: { rules: [
      { ...base, id: 'wrong-agent', agents: ['qodercli'], keywords: ['MATCH'] },
      { ...base, id: 'wrong-event', events: ['PreToolUse'], keywords: ['MATCH'] },
      { ...base, id: 'audit', keywords: ['no-hit', 'MATCH'], action: 'log' },
      { ...base, id: 'block', keywords: ['MATCH', 'other'] },
      { ...base, id: 'unreached', keywords: ['MATCH'] },
    ] } });
    const runner = new ManagedRegexRunner(1000);
    runners.push(runner);
    const test = vi.spyOn(runner, 'test');
    const engine = new ManagedRuleEngine({ config, rules: [], runners: {}, regex: runner, regexTimeoutMs: 1000 });
    const result = await engine.evaluate({ ...request, prompt: 'MATCH' });
    expect(result).toMatchObject({ action: 'block', ruleId: 'block', evaluatedRules: ['audit', 'block'] });
    expect(result.matches!.map(match => [match.ruleId, match.action])).toEqual([['audit', 'log'], ['block', 'block']]);
    expect(test.mock.calls.map(call => call[0])).toEqual([
      buildSubstringMatchPlan(['no-hit', 'MATCH']), buildSubstringMatchPlan(['MATCH', 'other']),
    ]);
  });

  it('packs chunks at the escaped source boundary and preserves order around expanded literals', () => {
    const keywords = ['a'.repeat(999), 'b'.repeat(1000), 'c', '.*'.repeat(1000), 'last'];
    const plan = buildSubstringMatchPlan(keywords);
    expect(plan.steps.map(step => step.kind)).toEqual(['regex', 'regex', 'literal', 'regex']);
    for (const step of plan.steps) if (step.kind === 'regex') expect(step.source.length).toBeLessThanOrEqual(SUBSTRING_REGEX_CHUNK_CHARS);
    for (const keyword of keywords) expect(planMatches(plan, keyword)).toBe(true);
    expect(planMatches(plan, 'unrelated')).toBe(false);
  });

  it.each(['random', 'shared-prefix', 'escaped'])('blocks review long-word regression with the default Worker budget: %s', async variant => {
    let seed = 42;
    const keywords = variant === 'random'
      ? Array.from({ length: 100 }, () => Array.from({ length: 2000 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return String.fromCharCode(97 + seed % 26);
      }).join(''))
      : variant === 'shared-prefix'
        ? Array.from({ length: 64 }, (_, index) => `k${index.toString().padStart(5, '0')}${'x'.repeat(1994)}`)
        : ['not-matched', '.*'.repeat(1000)];
    const config = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, keywords }] } });
    const runner = new ManagedRegexRunner();
    runners.push(runner);
    const test = vi.spyOn(runner, 'test');
    const engine = new ManagedRuleEngine({ config, rules: [], runners: {}, regex: runner });
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = variant === 'random' ? keywords[0] : keywords[keywords.length - 1];
      const result = await engine.evaluate({ ...request, prompt });
      expect(result).toMatchObject({ action: 'block', ruleId: 'literal' });
      expect(result.failOpen).toBeUndefined();
    }
    expect(test).toHaveBeenCalledTimes(3);
    for (const call of test.mock.calls) expect(call[2]).toBe(200);
  });
});
