import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolVerdictStore, TOOL_VERDICT_TTL_MS } from '../../../src/interceptor/tool-verdict-store.js';
import { PROMPT_CORRELATION_FIELD, promptHash, promptRequestId, promptKeyFromRequest, promptLookupFromEntry } from '../../../src/interceptor/prompt-verdict.js';
import { InterceptResultLinker } from '../../../src/core/intercept-result-linker.js';
import { applyAgentContentPolicy } from '../../../src/normalization/agent-content-policy.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const text = 'synthetic policy probe';
function key(id = 'request-1', agent = 'qodercli' as 'qodercli' | 'qoder', product?: string) {
  return promptKeyFromRequest({ agent, event: 'UserPromptSubmit', sessionId: 'session', prompt: text,
    raw: { request_set_id: id, ...(product ? { parent_business_info: { product } } : {}) } })!;
}
function entry(id?: string, at = Date.now(), agentType = 'qoder-cli') {
  return buildTestEntry({ 'event.name': 'llm.request', 'event.id': 'native-request',
    'gen_ai.agent.type': agentType, 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn',
    time_unix_nano: String(BigInt(at) * 1_000_000n),
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: text }] }],
    ...(id ? { [PROMPT_CORRELATION_FIELD]: { hash: promptHash(text), at, requestId: promptRequestId(id) } } : {}) });
}

describe('prompt verdict correlation', () => {
  function anonymous(product?: string) {
    return promptKeyFromRequest({ agent: 'qoder', event: 'UserPromptSubmit', sessionId: 'session', prompt: text,
      raw: product ? { parent_business_info: { product } } : {} })!;
  }

  it('joins a metadata-poor Qoder hook to one native App request and persists its ownership', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anonymous-prompt-')); dirs.push(dir);
    const file = join(dir, 'verdicts.json'); const now = new Date();
    const store = new ToolVerdictStore(file);
    store.put(anonymous(), { action: 'log', ruleId: 'policy', ruleVersion: '3' }, now);
    const app = entry('native', now.getTime() + 184, 'qoder-app');
    new InterceptResultLinker(store, true).enrich([app]);
    expect(app['gen_ai.guardrail.rule_id']).toBe('policy');
    expect(app).not.toHaveProperty(PROMPT_CORRELATION_FIELD);
    // An unrelated native request cannot consume the same anonymous observation.
    expect(store.getPromptSnapshot(promptLookupFromEntry(entry('another', now.getTime() + 200, 'qoder-app'))!, now)).toBeNull();
    await store.checkpoint();
    const restored = new ToolVerdictStore(file); restored.restore(now);
    const mirror = new ToolVerdictStore(join(dir, 'mirror.json')); mirror.merge(restored.records(now));
    expect(mirror.getPromptSnapshot(promptLookupFromEntry(entry('native', now.getTime() + 184, 'qoder-app'))!, now))
      .toMatchObject({ action: 'log', ruleId: 'policy' });
    expect(mirror.getPromptSnapshot(promptLookupFromEntry(entry('another', now.getTime() + 200, 'qoder-app'))!, now)).toBeNull();
    expect(await readFile(file, 'utf8')).not.toContain(text);
    expect(mirror.getPromptSnapshot(promptLookupFromEntry(entry('native', now.getTime() + 184, 'qoder-app'))!,
      new Date(now.getTime() + TOOL_VERDICT_TTL_MS + 1))).toBeNull();
  });

  it('keeps anonymous ownership across stale IPC and replacement snapshots', () => {
    const store = new ToolVerdictStore('/tmp/unused-anonymous.json'); const now = Date.now();
    store.put(anonymous(), { action: 'log' }, new Date(now));
    const unbound = store.records();
    const lookup = promptLookupFromEntry(entry('native', now, 'qoder-app'))!;
    expect(store.getPromptSnapshot(lookup)).toMatchObject({ action: 'log' });
    const writer = new ToolVerdictStore('/tmp/unused-writer.json'); writer.merge(unbound); writer.merge(store.records());
    store.replace(unbound); store.merge(unbound);
    store.put(anonymous(), { action: 'unknown' }, new Date(now + 100));
    for (const s of [store, writer]) {
      expect(s.getPromptSnapshot(lookup)).toMatchObject({ action: 'log' });
      expect(s.getPromptSnapshot({ ...lookup, requestId: promptRequestId('other') })).toBeNull();
    }
  });

  it.each(['unknown', 'block', 'allow'] as const)('counts an additional %s attempt as ambiguous', action => {
    const store = new ToolVerdictStore('/tmp/unused-anonymous.json'); const now = Date.now();
    store.put(anonymous(), { action: 'log', ruleId: 'older' }, new Date(now));
    store.put(anonymous(), { action }, new Date(now + 100));
    expect(store.getPromptSnapshot(promptLookupFromEntry(entry('native', now + 184, 'qoder-app'))!)).toBeNull();
  });

  it('allows sequential repeated prompts once an earlier attempt has a proven native owner', () => {
    const store = new ToolVerdictStore('/tmp/unused-repeated.json'); const now = Date.now();
    store.put(anonymous(), { action: 'log', ruleId: 'first' }, new Date(now));
    const first = promptLookupFromEntry(entry('first-native', now + 100, 'qoder-app'))!;
    expect(store.getPromptSnapshot(first)?.ruleId).toBe('first');
    store.put(anonymous(), { action: 'log', ruleId: 'second' }, new Date(now + 200));
    const second = promptLookupFromEntry(entry('second-native', now + 300, 'qoder-app'))!;
    expect(store.getPromptSnapshot(second)?.ruleId).toBe('second');
    expect(store.getPromptSnapshot(first)?.ruleId).toBe('first');
  });

  it('supports each missing metadata field independently without widening explicit identities', () => {
    const now = Date.now();
    const store = new ToolVerdictStore('/tmp/unused-partial.json');
    store.put(key('native', 'qoder'), { action: 'log', ruleId: 'id-known' }, new Date(now));
    const lookup = promptLookupFromEntry(entry('native', now, 'qoder-app'))!;
    expect(store.getPromptSnapshot(lookup)?.ruleId).toBe('id-known');
    expect(store.getPromptSnapshot({ ...lookup, requestId: promptRequestId('other') })).toBeNull();
    const app = new ToolVerdictStore('/tmp/unused-app.json'); app.put(anonymous('app'), { action: 'log' }, new Date(now));
    expect(app.getPromptSnapshot(promptLookupFromEntry(entry('native', now))!)).toBeNull();
    expect(app.getPromptSnapshot(lookup)?.action).toBe('log');
    const cli = anonymous('cli'); expect(cli.agentType).toBe('qoder-cli');
    expect(cli.missingAgentType).toBeUndefined();
    const legacy = new ToolVerdictStore('/tmp/unused-legacy.json');
    const old = { ...anonymous() }; delete old.missingRequestId; delete old.missingAgentType;
    legacy.put(old, { action: 'log' }, new Date(now));
    expect(legacy.getPromptSnapshot(lookup)).toBeNull();
    const stale = new ToolVerdictStore('/tmp/unused-stale.json'); stale.put(anonymous(), { action: 'log' }, new Date(now - 6000));
    expect(stale.getPromptSnapshot(lookup)).toBeNull();
  });

  it('stores only the digest and preserves it through checkpoint restore and IPC without extending expiry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prompt-verdict-')); dirs.push(dir);
    const file = join(dir, 'verdicts.json'); const now = new Date();
    const original = new ToolVerdictStore(file);
    original.put(key(), { action: 'log', ruleId: 'policy', ruleVersion: '2' }, now);
    await original.checkpoint();
    expect(await readFile(file, 'utf8')).not.toContain(text);
    expect(await readFile(file, 'utf8')).not.toContain('request-1');
    const restored = new ToolVerdictStore(file); restored.restore(now);
    const mirror = new ToolVerdictStore(join(dir, 'mirror.json')); mirror.merge(restored.records());
    const request = entry('request-1', now.getTime()); const lookup = promptLookupFromEntry(request)!;
    expect(mirror.getPromptSnapshot(lookup, now)).toEqual({ action: 'log', ruleId: 'policy', ruleVersion: '2' });
    expect(mirror.getPromptSnapshot(lookup, new Date(now.getTime() + TOOL_VERDICT_TTL_MS + 1))).toBeNull();
  });

  it('joins repeated text by request id and never guesses when the fallback is ambiguous', async () => {
    const store = new ToolVerdictStore('/tmp/unused-prompt-verdicts.json'); const now = Date.now();
    store.put(key('first'), { action: 'log', ruleId: 'old', ruleVersion: '1' }, new Date(now));
    store.put(key('second'), { action: 'allow' }, new Date(now + 100));
    const first = entry('first', now); const second = entry('second', now + 100); const unknown = entry(undefined, now);
    const linker = new InterceptResultLinker(store, true);
    linker.enrich([second, unknown, first]);
    expect(first).toMatchObject({ 'event.id': 'native-request', 'gen_ai.guardrail.action': 'log', 'gen_ai.guardrail.rule_id': 'old' });
    expect(second['gen_ai.guardrail.action']).toBe('allow');
    expect(second).not.toHaveProperty('gen_ai.guardrail.rule_id');
    expect(unknown).not.toHaveProperty('gen_ai.guardrail.action');
    const retry = entry('first', now); linker.enrich([retry]);
    expect(retry['gen_ai.guardrail.action']).toBe('log');
    expect(store.records()).toHaveLength(2);
  });

  it('retains failed attempts through IPC and restart and never exposes unknown or blocked prompt verdicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'failed-prompt-verdict-')); dirs.push(dir);
    const file = join(dir, 'verdicts.json'); const now = new Date();
    const original = new ToolVerdictStore(file);
    original.put(key('first'), { action: 'log', ruleId: 'old', ruleVersion: '1' }, now);
    original.put(key('failed'), { action: 'unknown' }, now);
    original.put(key('blocked'), { action: 'block', ruleId: 'blocked' }, now);
    await original.checkpoint();
    const restored = new ToolVerdictStore(file); restored.restore(now);
    const mirror = new ToolVerdictStore(join(dir, 'mirror.json')); mirror.merge(restored.records(now));
    expect(mirror.records(now)).toHaveLength(3);
    for (const id of [undefined, 'failed', 'blocked', 'missing']) {
      expect(mirror.getPromptSnapshot(promptLookupFromEntry(entry(id, now.getTime()))!, now)).toBeNull();
    }
    const lookup = promptLookupFromEntry(entry('first', now.getTime()))!;
    expect(mirror.getPromptSnapshot(lookup, now)).toMatchObject({ action: 'log', ruleId: 'old' });
    expect(mirror.getPromptSnapshot(lookup, now)).toMatchObject({ action: 'log', ruleId: 'old' });
    expect(await readFile(file, 'utf8')).not.toContain(text);
    const wrongText = { ...lookup, promptHash: promptHash('different prompt') };
    expect(mirror.getPromptSnapshot(wrongText, now)).toBeNull();
  });

  it('promotes pending to final across IPC even within one millisecond and rejects unknown tool records', () => {
    const now = new Date();
    const store = new ToolVerdictStore('/tmp/unused-pending-prompt-verdicts.json');
    const record = { ...key(), action: 'unknown' as const, recordedAt: now.toISOString() };
    store.merge([record]);
    store.merge([{ ...record, action: 'log', ruleId: 'policy', ruleVersion: '3' }]);
    store.merge([record]); // An older pending mirror cannot replace the final verdict on a timestamp tie.
    expect(store.getPromptSnapshot(promptLookupFromEntry(entry('request-1', now.getTime()))!, now))
      .toEqual({ action: 'log', ruleId: 'policy', ruleVersion: '3' });
    store.merge([{ sessionId: 'session', toolUseId: 'tool', phase: 'PreToolUse', action: 'unknown',
      recordedAt: now.toISOString() } as any]);
    store.put({ sessionId: 'session', toolUseId: 'tool', phase: 'PreToolUse' }, { action: 'unknown' });
    expect(store.records(now)).toHaveLength(1);
  });

  it('uses a bounded unique time window without borrowing another turn, session or App identity', () => {
    const store = new ToolVerdictStore('/tmp/unused-prompt-verdicts.json'); const now = Date.now();
    store.put(key(), { action: 'log', ruleId: 'cli-policy' }, new Date(now));
    store.put(key('app-request', 'qoder', 'app'), { action: 'log', ruleId: 'app-policy' }, new Date(now));
    const cli = entry(undefined, now); const app = entry(undefined, now, 'qoder-app');
    const other = { ...entry(undefined, now), 'gen_ai.session.id': 'other-session' };
    const stale = entry(undefined, now - 6000);
    new InterceptResultLinker(store, true).enrich([cli, app, other, stale]);
    expect(cli['gen_ai.guardrail.rule_id']).toBe('cli-policy');
    expect(app['gen_ai.guardrail.rule_id']).toBe('app-policy');
    expect(other).not.toHaveProperty('gen_ai.guardrail.action');
    expect(stale).not.toHaveProperty('gen_ai.guardrail.action');
  });

  it('does not reuse a prompt from full context in later tool steps or accept an unknown explicit request id', () => {
    const store = new ToolVerdictStore('/tmp/unused-prompt-verdicts.json'); store.put(key(), { action: 'log' });
    const continuation = entry();
    continuation['gen_ai.input.messages'] = continuation['gen_ai.input.messages_delta'];
    continuation['gen_ai.input.messages_delta'] = [{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'tool', response: 'ok' }] }];
    const wrongId = entry('unknown');
    new InterceptResultLinker(store, true).enrich([continuation, wrongId]);
    expect(continuation).not.toHaveProperty('gen_ai.guardrail.action');
    expect(wrongId).not.toHaveProperty('gen_ai.guardrail.action');
    const rawId = entry('request-1');
    rawId[PROMPT_CORRELATION_FIELD] = { hash: promptHash(text), at: Date.now(), requestId: 'request-1' };
    expect(promptLookupFromEntry(rawId)).toBeNull();
  });

  it('does not discard an explicit identity when its timestamp or prompt digest is invalid', () => {
    const now = Date.now();
    const store = new ToolVerdictStore('/tmp/unused-prompt-verdicts.json');
    store.put(key(), { action: 'log', ruleId: 'old' }, new Date(now));
    for (const invalid of [{ at: null }, { at: Number.NaN }, { hash: 'invalid' }]) {
      const request = entry('request-1', now);
      request[PROMPT_CORRELATION_FIELD] = {
        ...(request[PROMPT_CORRELATION_FIELD] as Record<string, unknown>), ...invalid,
      };
      expect(promptLookupFromEntry(request)).toBeNull();
      new InterceptResultLinker(store, true).enrich([request]);
      expect(request).not.toHaveProperty('gen_ai.guardrail.action');
    }
  });

  it('waits for the Worker barrier for model requests and keeps correlation private with content capture disabled', async () => {
    const store = new ToolVerdictStore('/tmp/unused-prompt-verdicts.json'); const now = Date.now();
    const barrier = vi.fn(async () => { store.put(key(), { action: 'log', ruleId: 'policy' }, new Date(now)); });
    const request = entry('request-1', now); delete request['gen_ai.input.messages_delta'];
    const linker = new InterceptResultLinker(store, true, barrier);
    await linker.sync([request]); linker.enrich([request]);
    expect(barrier).toHaveBeenCalledOnce();
    expect(request['gen_ai.guardrail.action']).toBe('log');
    expect(request).not.toHaveProperty(PROMPT_CORRELATION_FIELD);
    const untouched = entry('request-1', now);
    const safe = applyAgentContentPolicy(untouched, { qoder: { captureMessageContent: false } });
    expect(safe).not.toHaveProperty(PROMPT_CORRELATION_FIELD);
    expect(safe).not.toHaveProperty('gen_ai.input.messages_delta');
  });
});
