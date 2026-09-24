import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InterceptResultLinker } from '../../../src/core/intercept-result-linker.js';
import { writeToolVerdict } from '../../../src/interceptor/tool-verdict-store.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

function toolEntry(event: 'tool.call' | 'tool.result', overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.name': event,
    'gen_ai.agent.type': 'qoder',
    'gen_ai.session.id': 's1',
    'gen_ai.tool.call.id': 'call-1',
    ...overrides,
  } as AgentActivityEntry;
}

describe('InterceptResultLinker', () => {
  it('maps tool.call to PreToolUse and tool.result to PostToolUse', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intercept-linker-'));
    writeToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PreToolUse',
    }, 'allow', root);
    writeToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'call-1',
      phase: 'PostToolUse',
    }, 'deny', root);
    const entries = [toolEntry('tool.call'), toolEntry('tool.result')];

    new InterceptResultLinker(root).enrich(entries);

    expect(entries[0]['gen_ai.intercept.result']).toBe('allow');
    expect(entries[1]['gen_ai.intercept.result']).toBe('deny');
  });

  it('maps current interceptor agents and does not cross sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intercept-linker-'));
    writeToolVerdict({
      agent: 'openclaw',
      sessionId: 'open-session',
      toolUseId: 'call-2',
      phase: 'PreToolUse',
    }, 'unknown', root);
    const matching = toolEntry('tool.call', {
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.session.id': 'open-session',
      'gen_ai.tool.call.id': 'call-2',
    });
    const wrongSession = toolEntry('tool.call', {
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.session.id': 'other',
      'gen_ai.tool.call.id': 'call-2',
    });
    const unsupported = toolEntry('tool.call', {
      'gen_ai.agent.type': 'codex',
      'gen_ai.tool.call.id': 'call-2',
    });

    new InterceptResultLinker(root).enrich([matching, wrongSession, unsupported]);

    expect(matching['gen_ai.intercept.result']).toBe('unknown');
    expect(wrongSession['gen_ai.intercept.result']).toBeUndefined();
    expect(unsupported['gen_ai.intercept.result']).toBeUndefined();
  });

  it('omits the field when the tool call id or verdict record is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intercept-linker-'));
    writeToolVerdict({
      agent: 'qwen-work-cn',
      sessionId: 's1',
      toolUseId: 'present',
      phase: 'PreToolUse',
    }, 'allow', root);
    const missingId = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.tool.call.id': undefined,
    });
    const missingRecord = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qwen-work-cn',
      'gen_ai.tool.call.id': 'absent',
    });
    const idea = toolEntry('tool.call', {
      'gen_ai.agent.type': 'qoder-idea',
      'gen_ai.tool.call.id': 'present',
    });
    writeToolVerdict({
      agent: 'qoder',
      sessionId: 's1',
      toolUseId: 'present',
      phase: 'PreToolUse',
    }, 'deny', root);

    new InterceptResultLinker(root).enrich([missingId, missingRecord, idea]);

    expect(missingId['gen_ai.intercept.result']).toBeUndefined();
    expect(missingRecord['gen_ai.intercept.result']).toBeUndefined();
    expect(idea['gen_ai.intercept.result']).toBe('deny');
  });
});
