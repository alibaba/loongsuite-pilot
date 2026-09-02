import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: ['trace-1'], spanCount: 3, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { GlobalAttributesProvider } from '../../../../src/normalization/global-attributes.js';
import { expandAgentInputEvents } from '../../../../src/normalization/agent-input-dual-write.js';

function makeConfig() {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: { 'x-key': 'val' } }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
    resourceAttributes: { 'custom.attr': 'hello' },
  };
}

describe('OtlpTraceFlusher - conversion', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    vi.mocked(convertEventLogToTrace).mockClear();
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('calls convertEventLogToTrace with correct records on turn completion', async () => {
    const entries = [
      { 'event.name': 'llm.request', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't1' },
      { 'event.name': 'llm.response', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't1', 'gen_ai.response.finish_reasons': ['stop'] },
    ] as unknown as AgentActivityEntry[];

    for (const e of entries) await flusher.send(e);

    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    expect(callArgs[0]).toHaveLength(2);
    expect(callArgs[1]).toMatchObject({ strict: false });
  });

  it('reconciles an early OpenClaw fallback to the sender identity at turn conversion', async () => {
    const early = {
      'event.name': 'other',
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.turn.id': 'openclaw-turn',
      'user.id': 'collector-user',
      'agent.openclaw.hook': 'before_model_resolve',
      'gen_ai.input.messages_delta': [],
    } as unknown as AgentActivityEntry;
    const senderKnown = {
      ...early,
      'event.id': 'sender-known',
      'user.id': 'channel-sender',
      'agent.openclaw.hook': 'before_agent_run',
      'agent.openclaw.sender.id': 'channel-sender',
      'agent.openclaw.user.id.source': 'sender',
    } as unknown as AgentActivityEntry;
    const terminal = {
      ...senderKnown,
      'event.id': 'terminal',
      'agent.openclaw.hook': 'llm_output',
    } as unknown as AgentActivityEntry;

    await flusher.sendBatch([early, senderKnown, terminal]);

    const convertedRecords = vi.mocked(convertEventLogToTrace).mock.calls[0][0] as AgentActivityEntry[];
    expect(convertedRecords.every(record => record['user.id'] === 'channel-sender')).toBe(true);
    expect(early['user.id']).toBe('collector-user');
  });

  it('does not replace an explicit OpenClaw environment identity with sender metadata', async () => {
    const early = {
      'event.name': 'other',
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.turn.id': 'openclaw-env-turn',
      'user.id': 'environment-user',
      'agent.openclaw.hook': 'before_model_resolve',
      'gen_ai.input.messages_delta': [],
    } as unknown as AgentActivityEntry;
    const terminal = {
      ...early,
      'event.id': 'terminal',
      'agent.openclaw.hook': 'llm_output',
      'agent.openclaw.sender.id': 'channel-sender',
      'agent.openclaw.user.id.source': 'environment',
    } as unknown as AgentActivityEntry;

    await flusher.sendBatch([early, terminal]);

    const convertedRecords = vi.mocked(convertEventLogToTrace).mock.calls[0][0] as AgentActivityEntry[];
    expect(convertedRecords.every(record => record['user.id'] === 'environment-user')).toBe(true);
  });

  it('excludes agent.input only at the EventLog-to-Trace boundary', async () => {
    const inputOther = {
      time_unix_nano: '1700000000000000000',
      'event.id': 'input-other',
      'event.name': 'other',
      'user.id': 'user-1',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.turn.id': 'dual-write-turn',
      'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
    } as AgentActivityEntry;
    const terminal = {
      ...inputOther,
      time_unix_nano: '1700000001000000000',
      'event.id': 'terminal',
      'event.name': 'llm.response',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.input.messages_delta': undefined,
    } as AgentActivityEntry;

    await flusher.sendBatch([...expandAgentInputEvents([inputOther]), terminal]);

    const records = vi.mocked(convertEventLogToTrace).mock.calls[0][0] as AgentActivityEntry[];
    expect(records.map(record => record['event.name'])).toEqual([
      'other',
      'llm.response',
    ]);
  });

  it('passes handler from per-agent convert state', async () => {
    const entry = {
      'event.name': 'other',
      'gen_ai.agent.type': 'codex',
      'gen_ai.turn.id': 't2',
      'agent.codex.turn_status': 'completed',
      'gen_ai.turn.end': true,
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);

    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    expect(callArgs[1]).toHaveProperty('handler');
  });

  it('logs warnings without throwing', async () => {
    vi.mocked(convertEventLogToTrace).mockReturnValueOnce({ traceIds: [], spanCount: 0, warnings: ['orphan llm.request'] });

    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 't3',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    // Should not throw
    await flusher.send(entry);
    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
  });

  it('projects hook resourceAttributes to OTLP resource attributes', () => {
    const records = [
      {
        resourceAttributes: {
          'agentteams.worker.name': ' local-worker ',
          'agentteams.instance.id': 'example-instance',
          'agentteams.token': 'should-not-leak',
        },
      },
      {
        resourceAttributes: {
          'agentteams.worker.name': 'other-worker',
        },
      },
    ] as unknown as AgentActivityEntry[];

    const attrs = (flusher as any).collectResourceAttributes(records);
    expect(attrs).toEqual({
      'agentteams.worker.name': 'local-worker',
      'agentteams.instance.id': 'example-instance',
    });

    const resource = (flusher as any).buildResource('claude-code', 'test-pilot', attrs);
    expect(resource.attributes).toMatchObject({
      'custom.attr': 'hello',
      'agentteams.worker.name': 'local-worker',
      'agentteams.instance.id': 'example-instance',
    });
  });

  it('uses an explicit PI system and framework for a registered custom Agent resource', () => {
    const records = [{
      'gen_ai.agent.system': 'pi',
      'gen_ai.framework': 'pi-coding-agent',
    }] as unknown as AgentActivityEntry[];
    const identity = (flusher as any).resolveAgentResourceIdentity('acme-code', records);
    const resource = (flusher as any).buildResource('acme-code', 'test-pilot', {}, identity);

    expect(resource.attributes).toMatchObject({
      'gen_ai.agent.type': 'acme-code',
      'gen_ai.agent.system': 'pi',
      'gen_ai.framework': 'pi-coding-agent',
    });
  });

  it('evicts old per-resource convert states when resource attribute cardinality grows', () => {
    for (let i = 0; i < 70; i += 1) {
      (flusher as any).getOrCreateConvertState('claude-code', 'test-pilot', {
        'agentteams.worker.name': `worker-${i}`,
      });
    }

    const states = (flusher as any).agentConvertStates as Map<string, unknown>;
    expect(states.size).toBeLessThanOrEqual(64);
    expect(states.has('claude-code|test-pilot|{"agentteams.worker.name":"worker-0"}')).toBe(false);
    expect(states.has('claude-code|test-pilot|{"agentteams.worker.name":"worker-69"}')).toBe(true);
  });

  it('does not export when conversion produces zero spans', async () => {
    // forceFlush + getFinishedSpans returns empty
    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 't4',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);
    // No error thrown, graceful skip
  });

  it('always passes DEFAULT_GIT_PASSTHROUGH_KEYS even without a provider', async () => {
    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 't5',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);

    const opts = vi.mocked(convertEventLogToTrace).mock.calls[0][1] as { passthroughKeys?: string[] };
    expect(opts.passthroughKeys).toEqual(
      expect.arrayContaining([
        'git.repo',
        'git.branch',
        'git.domain',
        'workspace.current_root',
      ]),
    );
  });

  it('always preserves Agent hierarchy keys on converted spans', async () => {
    const entry = {
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': 'parent-session:t1',
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.depth': 1,
      'gen_ai.agent.parent.id': 'parent-session',
      'gen_ai.subagent.parent_tool_call.id': 'agent-call-1',
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);

    const opts = vi.mocked(convertEventLogToTrace).mock.calls[0][1] as { passthroughKeys?: string[] };
    expect(opts.passthroughKeys).toEqual(expect.arrayContaining([
      'gen_ai.turn.id',
      'gen_ai.agent.scope',
      'gen_ai.agent.depth',
      'gen_ai.agent.parent.id',
      'gen_ai.subagent.parent_tool_call.id',
    ]));
  });

  it('adds skill attributes only to the matching tool span', () => {
    const records = [
      {
        'event.name': 'tool.call',
        'gen_ai.tool.call.id': 'skill-call-1',
        'gen_ai.skill.name': 'dogfood',
        'gen_ai.skill.id': 'dogfood',
      },
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'skill-call-1',
        'gen_ai.skill.description': 'Exploratory QA for web apps.',
        'gen_ai.skill.version': '1.0.0',
      },
    ] as unknown as AgentActivityEntry[];
    const toolSpan = {
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'gen_ai.tool.call.id': 'skill-call-1',
      },
    };
    const llmSpan = {
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'gen_ai.tool.call.id': 'skill-call-1',
      },
    };

    (flusher as any).enrichToolSkillAttributes(records, [toolSpan, llmSpan]);

    expect(toolSpan.attributes).toMatchObject({
      'gen_ai.skill.name': 'dogfood',
      'gen_ai.skill.id': 'dogfood',
      'gen_ai.skill.description': 'Exploratory QA for web apps.',
      'gen_ai.skill.version': '1.0.0',
    });
    expect(llmSpan.attributes).not.toHaveProperty('gen_ai.skill.name');
  });

  it('enriches OpenClaw LLM and AGENT spans with per-call reasoning tokens and error status', () => {
    const records = [
      {
        'event.name': 'llm.response',
        'gen_ai.response.id': 'provider-response-1',
        'gen_ai.usage.reasoning_tokens': 59,
        'error.type': 'model_call_error',
      },
      {
        'event.name': 'llm.response',
        'gen_ai.response.id': 'provider-response-2',
        'gen_ai.usage.reasoning_tokens': 22,
      },
    ] as unknown as AgentActivityEntry[];
    const failedLlm = {
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'gen_ai.response.id': 'provider-response-1',
      },
      status: { code: 0 },
    };
    const successfulLlm = {
      attributes: {
        'gen_ai.span.kind': 'LLM',
        'gen_ai.response.id': 'provider-response-2',
      },
      status: { code: 0 },
    };
    const agent = {
      attributes: { 'gen_ai.span.kind': 'AGENT' },
      status: { code: 0 },
    };

    (flusher as any).enrichOpenClawLlmAttributes(
      records,
      [failedLlm, successfulLlm, agent],
    );

    expect(failedLlm.attributes).toMatchObject({
      'gen_ai.usage.reasoning_tokens': 59,
      'error.type': 'model_call_error',
    });
    expect(failedLlm.status.code).toBe(2);
    expect(successfulLlm.attributes).toMatchObject({
      'gen_ai.usage.reasoning_tokens': 22,
    });
    expect(agent.attributes).toMatchObject({
      'gen_ai.usage.reasoning_tokens': 81,
    });
  });

  it('preserves OpenClaw tool failure attributes and OTLP error status', () => {
    const records = [
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'failed-tool-1',
        'tool.result.status': 'failure',
        'error.type': 'tool_use_failure',
        'error.message': 'command exited with code 7',
      },
      {
        'event.name': 'tool.result',
        'gen_ai.tool.call.id': 'successful-tool-1',
        'tool.result.status': 'success',
      },
    ] as unknown as AgentActivityEntry[];
    const failedTool = {
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'gen_ai.tool.call.id': 'failed-tool-1',
      },
      status: { code: 0 },
    };
    const successfulTool = {
      attributes: {
        'gen_ai.span.kind': 'TOOL',
        'gen_ai.tool.call.id': 'successful-tool-1',
      },
      status: { code: 0 },
    };

    (flusher as any).enrichOpenClawToolAttributes(
      records,
      [failedTool, successfulTool],
    );

    expect(failedTool.attributes).toMatchObject({
      'tool.result.status': 'failure',
      'error.type': 'tool_use_failure',
      'error.message': 'command exited with code 7',
    });
    expect(failedTool.status).toMatchObject({
      code: 2,
      message: 'command exited with code 7',
    });
    expect(successfulTool.attributes).toMatchObject({
      'tool.result.status': 'success',
    });
    expect(successfulTool.status.code).toBe(0);
  });

  describe('with GlobalAttributesProvider', () => {
    let p: OtlpTraceFlusher;

    afterEach(async () => {
      await p.shutdown();
    });

    it('injects custom attrs onto record copies + passthroughKeys, without mutating originals', async () => {
      const provider = new GlobalAttributesProvider({ team: 'infra' }, '/nonexistent-span-attrs.json');
      p = new OtlpTraceFlusher(makeConfig(), provider);

      const entry = {
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.turn.id': 'tc1',
        'gen_ai.response.finish_reasons': ['stop'],
      } as unknown as AgentActivityEntry;

      await p.send(entry);

      const [records, opts] = vi.mocked(convertEventLogToTrace).mock.calls.at(-1) as [
        Array<Record<string, unknown>>,
        { passthroughKeys?: string[] },
      ];
      // custom key is in passthroughKeys (alongside git defaults)
      expect(opts.passthroughKeys).toEqual(expect.arrayContaining(['team', 'git.repo']));
      // custom value stamped onto the record copy fed to the converter
      expect(records[0]['team']).toBe('infra');
      // original entry NOT mutated -> custom attrs never reach the event log
      expect((entry as Record<string, unknown>)['team']).toBeUndefined();
    });

    it('is fill-only: does not override a value already present on the record', async () => {
      const provider = new GlobalAttributesProvider({ team: 'infra' }, '/nonexistent-span-attrs.json');
      p = new OtlpTraceFlusher(makeConfig(), provider);

      const entry = {
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.turn.id': 'tc2',
        'gen_ai.response.finish_reasons': ['stop'],
        team: 'local',
      } as unknown as AgentActivityEntry;

      await p.send(entry);

      const [records] = vi.mocked(convertEventLogToTrace).mock.calls.at(-1) as [
        Array<Record<string, unknown>>,
        unknown,
      ];
      expect(records[0]['team']).toBe('local');
    });
  });

  describe('spanAttributePassthroughPrefixes', () => {
    let p: OtlpTraceFlusher;

    afterEach(async () => {
      await p.shutdown();
    });

    it('passes through top-level record keys matching a configured prefix', async () => {
      p = new OtlpTraceFlusher({ ...makeConfig(), spanAttributePassthroughPrefixes: ['multica.'] });

      const entry = {
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.turn.id': 'tp1',
        'gen_ai.response.finish_reasons': ['stop'],
        'multica.issue.id': 'AGE-992',
        'multica.user.id': 'staff',
        'other.key': 'ignored',
      } as unknown as AgentActivityEntry;

      await p.send(entry);

      const opts = vi.mocked(convertEventLogToTrace).mock.calls.at(-1)![1] as { passthroughKeys?: string[] };
      expect(opts.passthroughKeys).toEqual(
        expect.arrayContaining(['multica.issue.id', 'multica.user.id', 'git.repo']),
      );
      expect(opts.passthroughKeys).not.toContain('other.key');
    });

    it('does not pass through any prefix key when none is configured', async () => {
      p = new OtlpTraceFlusher(makeConfig());

      const entry = {
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.turn.id': 'tp2',
        'gen_ai.response.finish_reasons': ['stop'],
        'multica.issue.id': 'AGE-992',
      } as unknown as AgentActivityEntry;

      await p.send(entry);

      const opts = vi.mocked(convertEventLogToTrace).mock.calls.at(-1)![1] as { passthroughKeys?: string[] };
      expect(opts.passthroughKeys).not.toContain('multica.issue.id');
    });

    it('never passes through reserved keys even if a misconfigured prefix matches', async () => {
      p = new OtlpTraceFlusher({ ...makeConfig(), spanAttributePassthroughPrefixes: ['gen_ai.'] });

      const entry = {
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'claude-code',
        'gen_ai.turn.id': 'tp3',
        'gen_ai.unapproved.attribute': 'ignored',
        'gen_ai.response.finish_reasons': ['stop'],
      } as unknown as AgentActivityEntry;

      await p.send(entry);

      const opts = vi.mocked(convertEventLogToTrace).mock.calls.at(-1)![1] as { passthroughKeys?: string[] };
      expect(opts.passthroughKeys).toEqual(expect.arrayContaining([
        'gen_ai.turn.id',
        'gen_ai.agent.scope',
        'gen_ai.agent.depth',
        'gen_ai.agent.parent.id',
        'gen_ai.subagent.parent_tool_call.id',
      ]));
      expect(opts.passthroughKeys).not.toContain('gen_ai.unapproved.attribute');
    });
  });

  it('drops orphan llm.request / tool.call before conversion (no matching response/result)', async () => {
    // Reproduces the mimo-code build-agent interrupted-turn scenario: turn
    // has llm.request + 2 tool.call but no llm.response / tool.result. The
    // flusher should drop the orphan request/call events so the converter
    // doesn't emit empty LLM/TOOL spans with duration=0.
    const entries = [
      { 'event.name': 'other', 'gen_ai.agent.type': 'mimo-code', 'gen_ai.turn.id': 't5', 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }] },
      { 'event.name': 'llm.request', 'gen_ai.agent.type': 'mimo-code', 'gen_ai.turn.id': 't5', 'gen_ai.step.id': 't5:s1' },
      { 'event.name': 'tool.call', 'gen_ai.agent.type': 'mimo-code', 'gen_ai.turn.id': 't5', 'gen_ai.step.id': 't5:s1', 'gen_ai.tool.call.id': 'call_orphan_1' },
      { 'event.name': 'tool.call', 'gen_ai.agent.type': 'mimo-code', 'gen_ai.turn.id': 't5', 'gen_ai.step.id': 't5:s1', 'gen_ai.tool.call.id': 'call_orphan_2' },
      // No Signal A (no llm.response with finish_reason=stop) — flush via shutdown.
    ] as unknown as AgentActivityEntry[];

    for (const e of entries) await flusher.send(e);
    await flusher.flush();

    expect(convertEventLogToTrace).toHaveBeenCalled();
    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    const sanitized = callArgs[0] as AgentActivityEntry[];
    // Orphan llm.request + 2 tool.call dropped; "other" event kept.
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]['event.name']).toBe('other');
  });

  it('keeps llm.request / tool.call when matching response / result exists', async () => {
    const entries = [
      { 'event.name': 'llm.request', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't6', 'gen_ai.step.id': 't6:s1' },
      { 'event.name': 'tool.call', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't6', 'gen_ai.step.id': 't6:s1', 'gen_ai.tool.call.id': 'call_ok' },
      { 'event.name': 'tool.result', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't6', 'gen_ai.step.id': 't6:s1', 'gen_ai.tool.call.id': 'call_ok' },
      { 'event.name': 'llm.response', 'gen_ai.agent.type': 'claude-code', 'gen_ai.turn.id': 't6', 'gen_ai.step.id': 't6:s1', 'gen_ai.response.finish_reasons': ['stop'] },
    ] as unknown as AgentActivityEntry[];

    for (const e of entries) await flusher.send(e);

    expect(convertEventLogToTrace).toHaveBeenCalled();
    const callArgs = vi.mocked(convertEventLogToTrace).mock.calls[0];
    const sanitized = callArgs[0] as AgentActivityEntry[];
    // All 4 records kept — pairs are complete.
    expect(sanitized).toHaveLength(4);
  });
});
