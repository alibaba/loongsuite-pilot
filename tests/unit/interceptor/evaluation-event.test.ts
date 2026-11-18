import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGuardrailEvaluationEntry } from '../../../src/interceptor/evaluation-event.js';
import { buildBlockedQoderPromptEntry } from '../../../src/interceptor/blocked-prompt.js';
import { parseHookRequest } from '../../../src/interceptor/adapters/qoder.js';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { maskAgentActivityEntry } from '../../../src/mask/entry-masker.js';
import { serialiseLogEntry } from '../../../src/normalization/entry-builder.js';
import { prepareTraceEvents } from '../../../src/flushers/trace-event-compat.js';
import type { HookRequest, ManagedRuleMatch } from '../../../src/interceptor/types.js';

describe('guardrail evaluation event', () => {
  it.each([
    ['qoder', { product: 'app' }, 'qoder-app', 'qoder-app'],
    ['qodercli', { product: 'app' }, 'qoder-app', 'qoder-app'],
    ['qoder', { product: 'cli' }, 'qoder', 'qoder-cli'],
    ['qodercli', { product: 'cli' }, 'qoder-cli', 'qoder-cli'],
    ['qoder', undefined, 'qoder', 'qoder-cli'],
    ['qodercli', undefined, 'qoder-cli', 'qoder-cli'],
    ['qoder', { product: 'APP' }, 'qoder', 'qoder-cli'],
    ['qodercli', [{ product: 'app' }], 'qoder-cli', 'qoder-cli'],
  ] as const)('uses the owning product for %s events with metadata %j', (surface, metadata, auditType, blockedType) => {
    const request = parseHookRequest({ hook_event_name: 'UserPromptSubmit', session_id: 'session',
      parent_business_info: metadata }, surface)!;
    const match: ManagedRuleMatch = { matched: true, action: 'allow', enforcement: 'audit',
      ruleId: 'observe', ruleVersion: '1', reason: 'hit' };
    expect(buildGuardrailEvaluationEntry(request, match)['gen_ai.agent.type']).toBe(auditType);
    expect(buildBlockedQoderPromptEntry(request)['gen_ai.agent.type']).toBe(blockedType);
  });

  it('keeps audit metadata through masking, JSONL and SLS serialization without copying hook content', async () => {
    const request: HookRequest = { agent: 'qodercli', event: 'PostToolUse', sessionId: 'session', toolUseId: 'tool',
      toolName: 'Bash', prompt: 'private prompt', toolInput: { secret: 'private input' }, toolResponse: 'private output', raw: {} };
    const match: ManagedRuleMatch = { matched: true, action: 'allow', enforcement: 'audit', ruleId: 'audit', ruleVersion: '7',
      reason: 'sk-1234567890abcdefghijklmnop', title: 'audit label', message: 'audit reminder', severity: 'HIGH' };
    const entry = buildGuardrailEvaluationEntry(request, match, true);
    const masked = maskAgentActivityEntry(entry, { mode: 'all', types: [], replacementMode: 'placeholder' });
    expect(masked).toMatchObject({ 'event.name': 'guardrail.evaluation', 'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.session.id': 'session', 'gen_ai.tool.call.id': 'tool', 'gen_ai.guardrail.phase': 'PostToolUse',
      'gen_ai.guardrail.triggered': true, 'gen_ai.guardrail.matched': true, 'gen_ai.guardrail.action': 'allow',
      'gen_ai.guardrail.enforcement': 'audit', 'gen_ai.guardrail.fail_open': true, 'gen_ai.guardrail.rule_id': 'audit',
      'gen_ai.guardrail.rule_version': '7', 'gen_ai.guardrail.reason': '[APIKEY_MASKED]', 'gen_ai.guardrail.severity': 'HIGH' });
    expect(JSON.stringify(masked)).not.toContain('private prompt');
    expect(JSON.stringify(masked)).not.toContain('private input');
    expect(JSON.stringify(masked)).not.toContain('private output');
    expect(prepareTraceEvents([masked])).toEqual([]);
    const serialized = serialiseLogEntry(masked);
    expect(serialized['event.name']).toBe('guardrail.evaluation');
    expect(serialized['gen_ai.guardrail.matched']).toBe('true');
    expect(serialized['gen_ai.guardrail.enforcement']).toBe('audit');
    expect(serialized['gen_ai.guardrail.severity']).toBe('HIGH');
    const root = await mkdtemp(join(tmpdir(), 'guardrail-evaluation-'));
    const flusher = new JsonlFlusher({ outputDir: root, rotateDaily: false });
    try {
      await flusher.start();
      await flusher.send(masked);
      await flusher.flush();
      expect(JSON.parse((await readFile(join(root, 'qoder-cli-all.jsonl'), 'utf8')).trim())).toEqual(JSON.parse(JSON.stringify(masked)));
    } finally {
      await flusher.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
