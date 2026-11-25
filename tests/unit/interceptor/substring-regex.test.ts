import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseManagedInterceptorConfig, patternRuleMatches, substringRegexSource } from '../../../src/interceptor/managed/config.js';
import { ManagedRuleEngine } from '../../../src/interceptor/managed/engine.js';
import { ManagedRegexRunner } from '../../../src/interceptor/managed/regex-runner.js';

const runners: ManagedRegexRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stop(); });
const base = { kind: 'pattern', id: 'literal', version: '1', agents: ['qoder'], events: ['UserPromptSubmit'], match: 'substring' };
const request = { agent: 'qoder' as const, event: 'UserPromptSubmit' as const, prompt: '', raw: {} };

describe('substring regex source', () => {
  it('escapes metacharacters and preserves Unicode, whitespace and UTF-16 literals in the Worker', async () => {
    const keywords = ['.*+?^${}()|[]\\', '/', '-', '中文', ' spaced ', '\n\t\0', '\uD800', '\uDC00', '😀'];
    const source = substringRegexSource(keywords);
    const runner = new ManagedRegexRunner(1000);
    runners.push(runner);
    for (const keyword of keywords) await expect(runner.test(source, `prefix${keyword}suffix`)).resolves.toBe(true);
    for (const miss of ['unrelated', 'SPACED', 'spaced', 'abc']) await expect(runner.test(source, miss)).resolves.toBe(false);
    // includes can match a single surrogate code unit inside a paired character.
    await expect(runner.test(substringRegexSource(['\uD83D']), '😀')).resolves.toBe(true);
    expect(new RegExp(substringRegexSource([])).test('anything')).toBe(false);
    expect(new RegExp(substringRegexSource([])).test('')).toBe(false);
  });

  it('agrees with includes for seeded literal keyword sets and texts', () => {
    let seed = 739;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const alphabet = ['a', 'B', '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/', '-', '\n', '\0', ' ', '中', '\uD800', '\uDC00'];
    const word = () => Array.from({ length: next() % 7 + 1 }, () => alphabet[next() % alphabet.length]).join('');
    for (let i = 0; i < 500; i++) {
      const keywords = Array.from({ length: next() % 8 + 1 }, word);
      const text = i % 2 ? word() + keywords[next() % keywords.length] + word() : word();
      const expected = keywords.some(keyword => text.includes(keyword));
      expect(new RegExp(substringRegexSource(keywords)).test(text)).toBe(expected);
      const rule = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, keywords }] } }).rules[0];
      if (rule.kind !== 'pattern') throw new Error('expected pattern');
      expect(patternRuleMatches(rule, text)).toBe(expected);
    }
  });

  it('builds one source per engine generation and does not apply the user regex length limit to it', async () => {
    const keywords = ['a.'.repeat(1000), 'b*'.repeat(1000)];
    const config = parseManagedInterceptorConfig({ interceptor: { rules: [{ ...base, keywords }] } });
    const rule = config.rules[0];
    if (rule.kind !== 'pattern' || rule.match !== 'substring') throw new Error('expected substring');
    const map = vi.spyOn(rule.keywords, 'map');
    const test = vi.fn(async (_source: string) => false);
    const engine = new ManagedRuleEngine({ config, rules: [], runners: {}, regex: { test } as unknown as ManagedRegexRunner });
    expect(map).toHaveBeenCalledOnce();
    await engine.evaluate(request);
    await engine.evaluate(request);
    expect(map).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledTimes(2);
    expect(test.mock.calls[0][0]).toBe(substringRegexSource(keywords));
    expect(test.mock.calls[0][0].length).toBeGreaterThan(2000);
    map.mockRestore();
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
    expect(test.mock.calls.map(call => call[0])).toEqual(['no-hit|MATCH', 'MATCH|other']);
  });
});
