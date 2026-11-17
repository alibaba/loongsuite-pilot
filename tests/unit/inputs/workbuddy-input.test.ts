import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  appendFile,
  rename,
  readdir,
  rm,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { applyAgentContentPolicy } from '../../../src/normalization/agent-content-policy.js';
import { buildWorkBuddyEvents } from '../../../src/inputs/workbuddy/workbuddy-event-builder.js';
import { WorkBuddyInput } from '../../../src/inputs/workbuddy/workbuddy-input.js';
import type { WorkBuddyRecord } from '../../../src/inputs/workbuddy/workbuddy-types.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';
const MULTI_TOOL_FIXTURE = fileURLToPath(
  new URL('../../fixtures/workbuddy/multi-tool-wave.jsonl', import.meta.url),
);

function fixtureRecords(): WorkBuddyRecord[] {
  return readFileSync(MULTI_TOOL_FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as WorkBuddyRecord);
}

let hookEventSequence = 0;

async function writeHookEvent(
  hookEventDir: string,
  record: Record<string, unknown>,
): Promise<string> {
  const transcriptPath = String(record.transcript_path ?? '');
  const sessionId = String(
    record.session_id
      ?? path.basename(transcriptPath, path.extname(transcriptPath))
      ?? 'test-session',
  );
  const sessionDir = path.join(hookEventDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const observedAtMs = Number(record.observed_at_ms ?? 0);
  const eventFile = path.join(
    sessionDir,
    `${String(observedAtMs).padStart(16, '0')}-${hookEventSequence++}.json`,
  );
  await writeFile(eventFile, JSON.stringify({ ...record, session_id: sessionId }));
  return eventFile;
}

async function listHookEventFiles(hookEventDir: string): Promise<string[]> {
  let sessionDirs;
  try {
    sessionDirs = await readdir(hookEventDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;
    const fullDir = path.join(hookEventDir, sessionDir.name);
    for (const name of await readdir(fullDir)) {
      if (name.endsWith('.json')) files.push(path.join(fullDir, name));
    }
  }
  return files.sort();
}

function spanDurationNanos(span: {
  startTime: [number, number];
  endTime: [number, number];
}): bigint {
  const start = BigInt(span.startTime[0]) * 1_000_000_000n + BigInt(span.startTime[1]);
  const end = BigInt(span.endTime[0]) * 1_000_000_000n + BigInt(span.endTime[1]);
  return end - start;
}

describe('WorkBuddy audit-event builder', () => {
  it('merges a multi-tool response wave into stable, uniquely identified audit events', async () => {
    const built = await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' });
    const entries = built;
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.call',
      'tool.result',
      'tool.result',
      'llm.request',
      'llm.response',
    ]);

    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(requests.map(entry => entry['gen_ai.step.id'])).toEqual([
      'request-synthetic-1:s1',
      'request-synthetic-1:s2',
    ]);
    expect(responses.map(entry => entry['gen_ai.step.id'])).toEqual([
      'request-synthetic-1:s1',
      'request-synthetic-1:s2',
    ]);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(responses[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(responses[0]['gen_ai.turn.end']).toBeUndefined();
    expect(responses[1]['gen_ai.turn.end']).toBe(true);
    expect(responses[0]['gen_ai.provider.name']).toBe('workbuddy');
    expect(responses[0]['gen_ai.usage.cache_read.input_tokens']).toBe(4);
    expect(responses[0]['agent.workbuddy.usage.credit']).toBe(0.5);
    expect((responses[0]['gen_ai.output.messages'] as any)[0].parts.map((part: any) => part.type))
      .toEqual(['reasoning', 'text', 'tool_call', 'tool_call']);
    expect(requests[1]['gen_ai.input.messages_delta']).toHaveLength(3);
    expect((requests[1]['gen_ai.input.messages_delta'] as any[]).map(message => message.role))
      .toEqual(['assistant', 'tool', 'tool']);
    const assistantCallParts = (requests[1]['gen_ai.input.messages_delta'] as any[])
      .find(message => message.role === 'assistant').parts;
    expect(assistantCallParts.map((part: any) => part.id))
      .toEqual(['call-synthetic-a', 'call-synthetic-b']);
    const toolResponseParts = (requests[1]['gen_ai.input.messages_delta'] as any[])
      .filter(message => message.role === 'tool')
      .map(message => message.parts[0]);
    expect(toolResponseParts.map(part => part.response)).toEqual([
      { ok: true, value: 'SYNTHETIC_RESULT_A' },
      { ok: true, value: 'SYNTHETIC_RESULT_B' },
    ]);
    expect(toolResponseParts.every(part => !('result' in part))).toBe(true);

    const toolCalls = entries.filter(entry => entry['event.name'] === 'tool.call');
    const toolResults = entries.filter(entry => entry['event.name'] === 'tool.result');
    expect(toolCalls.map(entry => entry['gen_ai.tool.call.id']))
      .toEqual(['call-synthetic-a', 'call-synthetic-b']);
    expect(toolCalls[0]['gen_ai.tool.call.arguments'])
      .toEqual({ path: '/workspace/example/alpha.txt' });
    expect(toolResults[0]['gen_ai.tool.call.result'])
      .toEqual({ ok: true, value: 'SYNTHETIC_RESULT_A' });
    expect(toolResults.map(entry => entry['gen_ai.tool.call.duration'])).toEqual([100, undefined]);
    expect(requests.map(entry => entry.time_unix_nano))
      .toEqual(['1000000000', '1300000000']);
    expect(responses.map(entry => entry.time_unix_nano))
      .toEqual(['1100000000', '1400000000']);

    const eventIds = entries.map(entry => entry['event.id']);
    expect(new Set(eventIds).size).toBe(entries.length);
    expect(entries.every(entry => entry['workspace.path'] === '/workspace/example')).toBe(true);
    expect((await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' }))
      .map(entry => entry['event.id'])).toEqual(eventIds);
  });

  it('serializes safe millisecond timestamps as exact decimal nanoseconds', async () => {
    const user = fixtureRecords()[0];
    const assistant = fixtureRecords().find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    const userTimestamp = 8_639_999_999_999_998;
    const assistantTimestamp = userTimestamp + 1;
    const entries = await buildWorkBuddyEvents([
      { ...user, timestamp: userTimestamp },
      { ...assistant, timestamp: assistantTimestamp },
    ], { sessionId: 'session-1' });

    expect(entries.map(entry => entry.time_unix_nano)).toEqual([
      (BigInt(userTimestamp) * 1_000_000n).toString(),
      (BigInt(assistantTimestamp) * 1_000_000n).toString(),
    ]);
    expect(entries.every(entry => /^\d+$/.test(entry.observed_time_unix_nano))).toBe(true);
  });

  it('lets the shared content policy remove all WorkBuddy message and tool content', async () => {
    const entries = (await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' }))
      .map(entry => applyAgentContentPolicy(entry, { workbuddy: { captureMessageContent: false } }));
    for (const entry of entries) {
      expect(entry['gen_ai.input.messages_delta']).toBeUndefined();
      expect(entry['gen_ai.output.messages']).toBeUndefined();
      expect(entry['gen_ai.tool.call.arguments']).toBeUndefined();
      expect(entry['gen_ai.tool.call.result']).toBeUndefined();
    }
  });

  it('replaces WorkBuddy all-zero trace IDs with a stable valid trace ID', async () => {
    const records = fixtureRecords().map(record => ({
      ...record,
      providerData: record.providerData
        ? { ...record.providerData, traceId: '00000000000000000000000000000000' }
        : undefined,
    }));
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });
    const traceIds = [...new Set(entries.map(entry => entry.trace_id))];

    expect(traceIds).toHaveLength(1);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIds[0]).not.toBe('00000000000000000000000000000000');
  });

  it.each([
    'deepseek-v4-flash',
    'kimi-k2.6',
    'minimax-m3',
    'glm-5v-turbo',
  ])('uses WorkBuddy as provider when %s has no explicit upstream provider', async model => {
    const records = fixtureRecords().map(record => ({
      ...record,
      providerData: record.providerData
        ? {
            ...record.providerData,
            model,
            requestModelId: model,
          }
        : undefined,
    }));
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });

    expect(new Set(entries.map(entry => entry['gen_ai.provider.name'])))
      .toEqual(new Set(['workbuddy']));
  });

  it('omits unavailable source facts and drops tool events without a reliable name', async () => {
    const records = fixtureRecords().map(record => {
      const providerData = record.providerData
        ? Object.fromEntries(Object.entries(record.providerData)
            .filter(([key]) => !['model', 'requestModelId', 'requestModelName'].includes(key)))
        : undefined;
      return {
        ...record,
        name: record.type === 'function_call' || record.type === 'function_call_result'
          ? undefined
          : record.name,
        status: record.type === 'function_call_result' ? undefined : record.status,
        providerData,
      };
    });
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });

    expect(entries.every(entry => !Object.values(entry).includes('unknown'))).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'llm.request')
      .every(entry => entry['gen_ai.request.model'] === undefined)).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')
      .every(entry => entry['gen_ai.response.model'] === undefined)).toBe(true);
    expect(entries.some(entry =>
      entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result')).toBe(false);
    const toolParts = entries
      .filter(entry => entry['event.name'] === 'llm.response')
      .flatMap(entry => ((entry['gen_ai.output.messages'] as any)?.[0]?.parts ?? []))
      .filter((part: any) => part.type === 'tool_call');
    expect(toolParts).toEqual([]);
  });

  it('drops tools without a reliable ID and omits malformed structured payloads', async () => {
    const records = fixtureRecords().map(record => {
      if (record.type === 'function_call' && record.callId === 'call-synthetic-a') {
        return { ...record, callId: undefined, arguments: '  {"broken":' };
      }
      if (record.type === 'function_call' && record.callId === 'call-synthetic-b') {
        return { ...record, arguments: 'plain synthetic argument' };
      }
      if (record.type === 'function_call_result' && record.callId === 'call-synthetic-a') {
        return { ...record, output: '  [broken' };
      }
      return record;
    });
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });
    const firstResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.response.finish_reasons']?.includes('tool_call'));
    const toolParts = ((firstResponse?.['gen_ai.output.messages'] as any)?.[0]?.parts ?? [])
      .filter((part: any) => part.type === 'tool_call');
    const toolCalls = entries.filter(entry => entry['event.name'] === 'tool.call');
    const toolResults = entries.filter(entry => entry['event.name'] === 'tool.result');

    expect(toolParts.map((part: any) => part.id))
      .toEqual(toolCalls.map(entry => entry['gen_ai.tool.call.id']));
    expect(new Set(toolParts.map((part: any) => part.id)).size).toBe(1);
    expect(toolParts[0].id).toBe('call-synthetic-b');
    expect(toolParts[0].arguments).toBe('plain synthetic argument');
    expect(toolCalls[0]['gen_ai.tool.call.arguments']).toBe('plain synthetic argument');
    expect(toolResults.map(entry => entry['gen_ai.tool.call.id']))
      .toEqual(['call-synthetic-b']);

    const nextRequest = entries.find(entry =>
      entry['event.name'] === 'llm.request'
      && entry['gen_ai.step.id'] === 'request-synthetic-1:s2');
    const nextDelta = nextRequest?.['gen_ai.input.messages_delta'] as any[];
    expect(nextDelta.map(message => message.role)).toEqual(['assistant', 'tool']);
    expect(nextDelta[0].parts.map((part: any) => part.id)).toEqual(['call-synthetic-b']);
  });

  it('emits a standard null tool response when WorkBuddy has no usable output', async () => {
    const records = fixtureRecords().map(record =>
      record.type === 'function_call_result' && record.callId === 'call-synthetic-a'
        ? { ...record, output: undefined }
        : record);
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });
    const nextRequest = entries.find(entry =>
      entry['event.name'] === 'llm.request'
      && entry['gen_ai.step.id'] === 'request-synthetic-1:s2');
    const responsePart = (nextRequest?.['gen_ai.input.messages_delta'] as any[])
      .find(message => message.role === 'tool' && message.parts[0].id === 'call-synthetic-a')
      ?.parts[0];

    expect(responsePart).toEqual({
      type: 'tool_call_response',
      id: 'call-synthetic-a',
      response: null,
    });
    expect(responsePart).not.toHaveProperty('result');
  });

  it('uses structural Hook data to repair missing transcript tool identity and timestamps', async () => {
    const records = fixtureRecords().map(record => {
      if (record.type === 'function_call' && record.callId === 'call-synthetic-a') {
        return { ...record, callId: undefined, timestamp: undefined };
      }
      if (record.type === 'function_call_result' && record.callId === 'call-synthetic-a') {
        return { ...record, callId: undefined, name: undefined, timestamp: undefined };
      }
      return record;
    });
    const entries = await buildWorkBuddyEvents(records, {
      sessionId: 'session-1',
      hookEvents: [
        {
          eventName: 'PreToolUse',
          observedAtMs: 1_210,
          toolName: 'SyntheticRead',
          toolCallId: 'hook-call-a',
        },
        {
          eventName: 'PostToolUse',
          observedAtMs: 1_330,
          toolName: 'SyntheticRead',
          toolCallId: 'hook-call-a',
        },
      ],
    });
    const hookCall = entries.find(entry =>
      entry['event.name'] === 'tool.call'
      && entry['gen_ai.tool.call.id'] === 'hook-call-a');
    const hookResult = entries.find(entry =>
      entry['event.name'] === 'tool.result'
      && entry['gen_ai.tool.call.id'] === 'hook-call-a');

    expect(hookCall?.['gen_ai.tool.name']).toBe('SyntheticRead');
    expect(hookCall?.time_unix_nano).toBe('1210000000');
    expect(hookResult?.['gen_ai.tool.name']).toBe('SyntheticRead');
    expect(hookResult?.time_unix_nano).toBe('1330000000');
    expect(hookResult?.['gen_ai.tool.call.duration']).toBe(120);
  });

  it('does not guess between ambiguous parallel Hook tool identities', async () => {
    const records = fixtureRecords().map(record =>
      record.type === 'function_call' || record.type === 'function_call_result'
        ? { ...record, callId: undefined }
        : record);
    const hookEvents = [
      {
        eventName: 'PreToolUse',
        observedAtMs: 1_210,
        toolName: 'SyntheticRead',
        toolCallId: 'hook-call-a',
      },
      {
        eventName: 'PreToolUse',
        observedAtMs: 1_220,
        toolName: 'SyntheticRead',
        toolCallId: 'hook-call-b',
      },
      {
        eventName: 'PostToolUse',
        observedAtMs: 1_310,
        toolName: 'SyntheticRead',
        toolCallId: 'hook-call-a',
      },
      {
        eventName: 'PostToolUse',
        observedAtMs: 1_320,
        toolName: 'SyntheticRead',
        toolCallId: 'hook-call-b',
      },
    ];
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1', hookEvents });

    expect(entries.some(entry =>
      entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result')).toBe(false);
  });

  it('uses prompt and Stop Hook times only when LLM transcript timestamps are missing', async () => {
    const user = fixtureRecords()[0];
    const assistant = fixtureRecords().find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    const entries = await buildWorkBuddyEvents([
      { ...user, timestamp: undefined },
      { ...assistant, timestamp: undefined },
    ], {
      sessionId: 'session-1',
      hookEvents: [
        { eventName: 'UserPromptSubmit', observedAtMs: 2_000 },
        { eventName: 'Stop', observedAtMs: 2_500 },
      ],
    });

    expect(entries.map(entry => entry.time_unix_nano))
      .toEqual(['2000000000', '2500000000']);
  });

  it('prefers transcript response time over an earlier Stop Hook observation', async () => {
    const user = fixtureRecords()[0];
    const assistant = fixtureRecords().find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    const entries = await buildWorkBuddyEvents([user, assistant], {
      sessionId: 'session-1',
      hookEvents: [
        { eventName: 'UserPromptSubmit', observedAtMs: 900 },
        { eventName: 'Stop', observedAtMs: 1_300 },
      ],
    });

    expect(entries.map(entry => entry.time_unix_nano))
      .toEqual(['1000000000', '1500000000']);
  });

  it('preserves Hook fallback boundaries for later records that lack transcript timestamps', async () => {
    const user = fixtureRecords()[0];
    const assistant = fixtureRecords().find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    const entries = await buildWorkBuddyEvents([
      user,
      assistant,
      {
        ...user,
        id: 'turn-hook-fallback',
        timestamp: undefined,
      },
      {
        ...assistant,
        id: 'response-hook-fallback',
        timestamp: undefined,
        providerData: {
          ...assistant.providerData,
          conversationRequestId: 'request-hook-fallback',
          messageId: 'response-hook-fallback',
        },
      },
    ], {
      sessionId: 'session-1',
      hookEvents: [
        { eventName: 'UserPromptSubmit', observedAtMs: 2_000 },
        { eventName: 'Stop', observedAtMs: 2_500 },
      ],
    });

    expect(entries.map(entry => entry.time_unix_nano))
      .toEqual(['1000000000', '1500000000', '2000000000', '2500000000']);
  });

  it('drops tool events when neither transcript nor Hook provides a call timestamp', async () => {
    const records = fixtureRecords().map(record =>
      record.type === 'function_call'
        ? { ...record, timestamp: undefined }
        : record);
    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-1' });

    expect(entries.some(entry => entry['event.name'] === 'tool.call')).toBe(false);
    expect(entries.some(entry => entry['event.name'] === 'tool.result')).toBe(false);
  });

  it('produces positive LLM and TOOL spans with transcript-derived boundaries', async () => {
    const modernEpochMs = 1_800_000_000_000;
    const records = fixtureRecords().map(record => ({
      ...record,
      timestamp: record.timestamp === undefined
        ? undefined
        : modernEpochMs + record.timestamp,
    }));
    const entries = await buildWorkBuddyEvents(records, {
      sessionId: 'workbuddy-duration-test',
    });
    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(entries);
      expect(conversion.warnings).toEqual([]);

      const llmSpans = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      const llmDurations = llmSpans.map(span => spanDurationNanos(span));
      const toolDurations = conversion.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')
        .map(span => spanDurationNanos(span));
      expect(llmDurations).toEqual([100_000_000n, 100_000_000n]);
      expect(toolDurations).toEqual([100_000_000n, 0n]);

      const secondInput = JSON.parse(String(llmSpans[1].attributes['gen_ai.input.messages']));
      expect(secondInput.map((message: any) => message.role)).toEqual([
        'user', 'assistant', 'tool', 'tool',
      ]);
      const assistantCallIds = secondInput
        .find((message: any) => message.role === 'assistant').parts
        .map((part: any) => part.id);
      const responseParts = secondInput
        .filter((message: any) => message.role === 'tool')
        .flatMap((message: any) => message.parts);
      expect(responseParts.map((part: any) => part.id)).toEqual(assistantCallIds);
      expect(responseParts.map((part: any) => part.response)).toEqual([
        { ok: true, value: 'SYNTHETIC_RESULT_A' },
        { ok: true, value: 'SYNTHETIC_RESULT_B' },
      ]);
      expect(responseParts.every((part: any) => !('result' in part))).toBe(true);
    } finally {
      if (previousStability === undefined) {
        delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      } else {
        process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      }
      if (previousCapture === undefined) {
        delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      } else {
        process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
      }
    }
  });

  it('does not infer model finish semantics from assistant status', async () => {
    const records = fixtureRecords().map(record =>
      record.type === 'message' && record.role === 'assistant'
        ? { ...record, status: 'failed' }
        : record);
    const responses = (await buildWorkBuddyEvents(records, { sessionId: 'session-1' }))
      .filter(entry => entry['event.name'] === 'llm.response');

    expect(responses.map(entry => entry['gen_ai.response.finish_reasons']))
      .toEqual([['tool_call'], ['stop']]);
    expect(responses[1]['gen_ai.turn.end']).toBe(true);
    expect(responses[1]['error.type']).toBeUndefined();
  });

  it('closes an interrupted turn and cancels its pending tool before the next user turn', async () => {
    const sharedProvider = {
      traceId: '0123456789abcdef0123456789abcdef',
      conversationRequestId: 'request-interrupted',
      messageId: 'response-interrupted',
      model: 'model-synthetic',
    };
    const records: WorkBuddyRecord[] = [
      {
        type: 'message',
        role: 'user',
        id: 'turn-interrupted',
        timestamp: 1_000,
        content: [{ type: 'input_text', text: 'start work' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        id: 'response-interrupted',
        timestamp: 1_100,
        content: [{ type: 'output_text', text: 'running a command' }],
        providerData: sharedProvider,
      },
      {
        type: 'function_call',
        id: 'response-interrupted',
        callId: 'call-pending',
        name: 'PowerShell',
        arguments: '{"command":"Start-Sleep -Seconds 30"}',
        timestamp: 1_100,
        providerData: sharedProvider,
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'incomplete',
        id: 'response-incomplete',
        parentId: 'response-interrupted',
        content: [{ type: 'output_text', text: 'interrupted' }],
      },
      {
        type: 'message',
        role: 'user',
        id: 'turn-next',
        timestamp: 1_300,
        content: [{ type: 'input_text', text: 'continue with something else' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        id: 'response-next',
        timestamp: 1_400,
        content: [{ type: 'output_text', text: 'done' }],
        providerData: {
          ...sharedProvider,
          conversationRequestId: 'request-next',
          messageId: 'response-next',
        },
      },
    ];

    const entries = await buildWorkBuddyEvents(records, { sessionId: 'session-interrupted' });
    const interruptedResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.turn.id'] === 'turn-interrupted');
    const cancelledTool = entries.find(entry =>
      entry['event.name'] === 'tool.result'
      && entry['gen_ai.tool.call.id'] === 'call-pending');
    const nextResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.turn.id'] === 'turn-next');

    expect(interruptedResponse).toMatchObject({
      'gen_ai.response.finish_reasons': ['cancelled'],
      'gen_ai.turn.end': true,
    });
    expect(cancelledTool).toMatchObject({
      'gen_ai.tool.name': 'PowerShell',
      'tool.result.status': 'cancelled',
      'gen_ai.tool.call.duration': 200,
    });
    expect(nextResponse).toMatchObject({
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.turn.end': true,
    });
  });

});

class TestWorkBuddyInput extends WorkBuddyInput {
  public collectNow() {
    return this.collect();
  }
}

describe('WorkBuddyInput checkpoints', () => {
  it('baselines existing transcripts and emits only newly appended turns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-1.jsonl');
    const outsideTranscript = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside.jsonl`,
    );
    const records = fixtureRecords();
    const initialUser = records.find(record => record.type === 'message' && record.role === 'user')!;
    const initialAssistant = records.find(
      record => record.type === 'message' && record.role === 'assistant'
        && record.id === 'response-synthetic-2',
    )!;
    await writeFile(
      transcript,
      `${JSON.stringify(initialUser)}\r\n${JSON.stringify(initialAssistant)}\r\n`,
    );
    await writeFile(
      outsideTranscript,
      `${JSON.stringify(initialUser)}\n${JSON.stringify(initialAssistant)}\n`,
    );
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 900,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: outsideTranscript,
    });
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_000,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: transcript,
    });
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });

    expect(WorkBuddyInput.getWatchPaths(root)).toEqual([root, path.join(root, 'projects')]);
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();
    const secondTurn: WorkBuddyRecord[] = [
      { ...initialUser, id: 'turn-synthetic-2', timestamp: 2_000 },
      {
        ...initialAssistant,
        id: 'response-synthetic-3',
        parentId: 'turn-synthetic-2',
        timestamp: 2_000,
        providerData: {
          ...initialAssistant.providerData,
          conversationRequestId: 'request-synthetic-2',
          messageId: 'response-synthetic-3',
        },
      },
    ];
    await appendFile(transcript, secondTurn.map(record => JSON.stringify(record)).join('\r\n') + '\r\n');
    await appendFile(outsideTranscript, secondTurn.map(record => JSON.stringify(record)).join('\n') + '\n');

    expect(await input.collectNow()).toEqual([]);
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 2_000,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    });
    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries.every(entry => entry['gen_ai.turn.id'] === 'turn-synthetic-2')).toBe(true);
    await stateStore.save();
    expect(await input.collectNow()).toEqual([]);
    expect((await listHookEventFiles(hookEventDir))
      .every(file => !file.includes(`${path.sep}session-1${path.sep}`))).toBe(true);
    const persistedState = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).workbuddy;
    expect(persistedState).toBeDefined();
    expect(Object.values(persistedState.extra.workbuddyTranscriptBytes))
      .toEqual([Buffer.byteLength(await readFile(transcript, 'utf8'))]);
  });

  it('waits for Stop before processing a turn written in several chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-race-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-race.jsonl');
    const records = fixtureRecords();
    await writeFile(transcript, `${JSON.stringify(records[0])}\n`);
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_000,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: transcript,
    });

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);

    await appendFile(
      transcript,
      `${JSON.stringify(records[1])}\n${JSON.stringify(records[2])}\n`,
    );
    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);

    await appendFile(
      transcript,
      `${records.slice(3).map(record => JSON.stringify(record)).join('\n')}\n`,
    );
    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);

    await writeHookEvent(hookEventDir, {
      observed_at_ms: 2_000,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    });
    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.call',
      'tool.result',
      'tool.result',
      'llm.request',
      'llm.response',
    ]);
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => entry['gen_ai.response.finish_reasons']))
      .toEqual([['tool_call'], ['stop']]);
    expect(entries.filter(entry => entry['gen_ai.turn.end'] === true)).toHaveLength(1);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(entries.length);
    expect(await input.collectNow()).toEqual([]);
  });

  it('does not checkpoint past a failed newline-delimited record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-malformed-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-malformed.jsonl');
    await writeFile(transcript, '');

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);

    const records = fixtureRecords();
    const user = records[0];
    const assistant = records.find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    await writeFile(transcript, `{ "type": "message"\n${JSON.stringify(assistant)}\n`);
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 3_000,
      hook_event_name: 'Stop',
      session_id: 'session-malformed',
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);

    await writeFile(
      transcript,
      `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`,
    );
    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'llm.request',
      'llm.response',
    ]);
    expect(entries.every(entry => entry['gen_ai.turn.id'] === user.id)).toBe(true);
  });

  it('passes uniquely matched structural Hook identity through to the builder', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-hook-repair-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-hook-repair.jsonl');
    await writeFile(transcript, '');

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);

    const source = fixtureRecords();
    const records = [source[0], source[1], source[2], source[3], source[5], source[7], source[8]]
      .map(record => {
        if (record.type === 'function_call') {
          return { ...record, callId: undefined, name: undefined, timestamp: undefined };
        }
        if (record.type === 'function_call_result') {
          return { ...record, callId: undefined, name: undefined, timestamp: undefined };
        }
        return record;
      });
    await appendFile(transcript, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    for (const hookEvent of [
      {
        observed_at_ms: 900,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'session-hook-repair',
        transcript_path: transcript,
      },
      {
        observed_at_ms: 1_210,
        hook_event_name: 'PreToolUse',
        session_id: 'session-hook-repair',
        transcript_path: transcript,
        tool_name: 'SyntheticRead',
        tool_call_id: 'hook-call-a',
      },
      {
        observed_at_ms: 1_330,
        hook_event_name: 'PostToolUse',
        session_id: 'session-hook-repair',
        transcript_path: transcript,
        tool_name: 'SyntheticRead',
        tool_call_id: 'hook-call-a',
      },
      {
        observed_at_ms: 1_600,
        hook_event_name: 'Stop',
        session_id: 'session-hook-repair',
        transcript_path: transcript,
      },
    ]) {
      await writeHookEvent(hookEventDir, hookEvent);
    }

    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    const toolEntries = entries.filter(entry =>
      entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result');

    expect(toolEntries.map(entry => entry['gen_ai.tool.call.id']))
      .toEqual(['hook-call-a', 'hook-call-a']);
    expect(toolEntries.map(entry => entry['gen_ai.tool.name']))
      .toEqual(['SyntheticRead', 'SyntheticRead']);
    expect(toolEntries.map(entry => entry.time_unix_nano))
      .toEqual(['1210000000', '1330000000']);
    expect(toolEntries[1]['gen_ai.tool.call.duration']).toBe(120);
  });

  it('preserves checkpoints while the projects directory is temporarily unavailable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-unavailable-'));
    const projectsRoot = path.join(root, 'projects');
    const projects = path.join(projectsRoot, 'safe-project');
    const hiddenProjects = path.join(root, 'projects-temporarily-hidden');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-unavailable.jsonl');
    const records = fixtureRecords();
    await writeFile(transcript, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    const pendingHookEvent = await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_000,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-unavailable',
      transcript_path: transcript,
    });

    const statePath = path.join(root, 'state.json');
    const stateStore = new StateStore(statePath);
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();
    const before = JSON.parse(await readFile(statePath, 'utf8')).workbuddy
      .extra.workbuddyTranscriptBytes;

    await rename(projectsRoot, hiddenProjects);
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();
    const unavailable = JSON.parse(await readFile(statePath, 'utf8')).workbuddy
      .extra.workbuddyTranscriptBytes;
    expect(unavailable).toEqual(before);
    expect(await readFile(pendingHookEvent, 'utf8')).toContain('session-unavailable');

    await rename(hiddenProjects, projectsRoot);
    const restoredTranscript = path.join(projectsRoot, 'safe-project', 'session-unavailable.jsonl');
    const finalAssistant = records.find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    const appended = [
      { ...records[0], id: 'turn-after-recovery', timestamp: 2_000 },
      {
        ...finalAssistant,
        id: 'response-after-recovery',
        timestamp: 2_500,
        providerData: {
          ...finalAssistant.providerData,
          conversationRequestId: 'request-after-recovery',
          messageId: 'response-after-recovery',
        },
      },
    ];
    await appendFile(
      restoredTranscript,
      `${appended.map(record => JSON.stringify(record)).join('\n')}\n`,
    );
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 3_000,
      hook_event_name: 'Stop',
      session_id: 'session-unavailable',
      transcript_path: restoredTranscript,
    });

    expect(await input.collectNow()).toEqual([]);
    const recovered = await input.collectNow();
    expect(recovered.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(recovered.every(entry => entry['gen_ai.turn.id'] === 'turn-after-recovery')).toBe(true);
  });

  it('removes per-session Hook events and checkpoints after transcript deletion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-deleted-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    await writeFile(path.join(root, 'projects', '.DS_Store'), 'not a project directory');
    const transcript = path.join(projects, 'session-deleted.jsonl');
    await writeFile(
      transcript,
      `${fixtureRecords().map(record => JSON.stringify(record)).join('\n')}\n`,
    );
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_000,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-deleted',
      transcript_path: transcript,
    });

    const statePath = path.join(root, 'state.json');
    const stateStore = new StateStore(statePath);
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();
    expect(await listHookEventFiles(hookEventDir)).toHaveLength(1);

    await rm(transcript);
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();

    expect(await listHookEventFiles(hookEventDir)).toEqual([]);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')).workbuddy.extra;
    expect(persisted.workbuddyTranscriptBytes).toEqual({});
    expect(persisted.workbuddyTranscriptFiles).toEqual({});
  });

  it('does not treat a newly announced transcript as deleted before it is created', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-creating-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-creating.jsonl');
    const eventFile = await writeHookEvent(hookEventDir, {
      observed_at_ms: Date.now(),
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-creating',
      transcript_path: transcript,
    });

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await readFile(eventFile, 'utf8')).toContain('session-creating');
    await writeFile(transcript, `${JSON.stringify(fixtureRecords()[0])}\n`);
    expect(await input.collectNow()).toEqual([]);
    expect(await readFile(eventFile, 'utf8')).toContain('session-creating');
  });

  it('removes an orphan Hook session when its observation time is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-orphan-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-orphan.jsonl');
    await writeHookEvent(hookEventDir, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-orphan',
      transcript_path: transcript,
    });

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await listHookEventFiles(hookEventDir)).toEqual([]);
  });

  it('requires a stable Stop boundary for a hook-backed transcript', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-stop-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookEventDir = path.join(root, 'pilot-events');
    await mkdir(projects, { recursive: true });
    await mkdir(hookEventDir, { recursive: true });
    const transcript = path.join(projects, 'session-stop.jsonl');
    const records = fixtureRecords();
    const user = records[0];
    const assistant = records.find(record =>
      record.type === 'message'
      && record.role === 'assistant'
      && record.id === 'response-synthetic-2')!;
    await writeFile(transcript, `${JSON.stringify(user)}\n`);
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_000,
      hook_event_name: 'UserPromptSubmit',
      transcript_path: transcript,
    });

    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    const input = new TestWorkBuddyInput({
      stateStore,
      workBuddyRoot: root,
      hookEventDir,
    });
    expect(await input.collectNow()).toEqual([]);

    await appendFile(transcript, `${JSON.stringify(assistant)}\n`);
    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();

    const restartedStore = new StateStore(path.join(root, 'state.json'));
    await restartedStore.load();
    const restartedInput = new TestWorkBuddyInput({
      stateStore: restartedStore,
      workBuddyRoot: root,
      hookEventDir,
    });

    await writeHookEvent(hookEventDir, {
      observed_at_ms: 2_000,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    });
    expect(await restartedInput.collectNow()).toEqual([]);
    const sealed = await restartedInput.collectNow();
    expect(sealed.map(entry => entry['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(sealed[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(sealed[1]['gen_ai.turn.end']).toBe(true);
  });

});
