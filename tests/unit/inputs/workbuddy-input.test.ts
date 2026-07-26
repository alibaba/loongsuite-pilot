import { mkdtemp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

describe('WorkBuddy audit-event builder', () => {
  it('merges a multi-tool response wave into stable, uniquely identified audit events', async () => {
    const built = await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' });
    const entries = built.map(item => item.entry);
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
    expect(responses[0]['gen_ai.provider.name']).toBe('zhipu');
    expect(responses[0]['gen_ai.usage.cache_read.input_tokens']).toBe(4);
    expect(responses[0]['agent.workbuddy.usage.credit']).toBe(0.5);
    expect((responses[0]['gen_ai.output.messages'] as any)[0].parts.map((part: any) => part.type))
      .toEqual(['reasoning', 'text', 'tool_call', 'tool_call']);
    expect(requests[1]['gen_ai.input.messages_delta']).toHaveLength(2);

    const toolCalls = entries.filter(entry => entry['event.name'] === 'tool.call');
    const toolResults = entries.filter(entry => entry['event.name'] === 'tool.result');
    expect(toolCalls.map(entry => entry['gen_ai.tool.call.id']))
      .toEqual(['call-synthetic-a', 'call-synthetic-b']);
    expect(toolCalls[0]['gen_ai.tool.call.arguments'])
      .toEqual({ path: '/workspace/example/alpha.txt' });
    expect(toolResults[0]['gen_ai.tool.call.result'])
      .toEqual({ ok: true, value: 'SYNTHETIC_RESULT_A' });
    expect(toolResults.map(entry => entry['gen_ai.tool.call.duration'])).toEqual([100, undefined]);

    const eventIds = entries.map(entry => entry['event.id']);
    expect(new Set(eventIds).size).toBe(entries.length);
    expect(entries.every(entry => entry['workspace.path'] === '/workspace/example')).toBe(true);
    expect((await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' }))
      .map(item => item.entry['event.id'])).toEqual(eventIds);
  });

  it('lets the shared content policy remove all WorkBuddy message and tool content', async () => {
    const entries = (await buildWorkBuddyEvents(fixtureRecords(), { sessionId: 'session-1' }))
      .map(item => applyAgentContentPolicy(item.entry, { workbuddy: { captureMessageContent: false } }));
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
    const entries = (await buildWorkBuddyEvents(records, { sessionId: 'session-1' }))
      .map(item => item.entry);
    const traceIds = [...new Set(entries.map(entry => entry.trace_id))];

    expect(traceIds).toHaveLength(1);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIds[0]).not.toBe('00000000000000000000000000000000');
  });

  it('omits unavailable source facts instead of inventing placeholder values', async () => {
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
    const entries = (await buildWorkBuddyEvents(records, { sessionId: 'session-1' }))
      .map(item => item.entry);

    expect(entries.every(entry => !Object.values(entry).includes('unknown'))).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'llm.request')
      .every(entry => entry['gen_ai.request.model'] === undefined)).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')
      .every(entry => entry['gen_ai.response.model'] === undefined)).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result')
      .every(entry => entry['gen_ai.tool.name'] === undefined)).toBe(true);
    expect(entries.filter(entry => entry['event.name'] === 'tool.result')
      .every(entry => entry['tool.result.status'] === undefined)).toBe(true);
  });
});

class TestWorkBuddyInput extends WorkBuddyInput {
  public collectNow() { return this.collect(); }
}

describe('WorkBuddyInput checkpoints', () => {
  it('baselines existing transcripts and emits only newly appended turns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbuddy-input-'));
    const projects = path.join(root, 'projects', 'safe-project');
    const hookLogDir = path.join(root, 'pilot-logs');
    await mkdir(projects, { recursive: true });
    await mkdir(hookLogDir, { recursive: true });
    const transcript = path.join(projects, 'session-1.jsonl');
    const records = fixtureRecords();
    const initialUser = records.find(record => record.type === 'message' && record.role === 'user')!;
    const initialAssistant = records.find(
      record => record.type === 'message' && record.role === 'assistant'
        && record.id === 'response-synthetic-2',
    )!;
    await writeFile(
      transcript,
      `${JSON.stringify(initialUser)}\n${JSON.stringify(initialAssistant)}\n`,
    );
    const stateStore = new StateStore(path.join(root, 'state.json'));
    await stateStore.load();
    stateStore.update('workbuddy', { extra: { workbuddySqliteCursor: [1, 'legacy-session'] } });
    const input = new TestWorkBuddyInput({ stateStore, workBuddyRoot: root, hookLogDir });

    expect(WorkBuddyInput.getWatchPaths(root)).toEqual([root, path.join(root, 'projects')]);
    expect(await input.collectNow()).toEqual([]);
    await stateStore.save();
    const secondTurn: WorkBuddyRecord[] = [
      { ...initialUser, id: 'turn-synthetic-2', timestamp: 2_000 },
      {
        ...initialAssistant,
        id: 'response-synthetic-3',
        parentId: 'turn-synthetic-2',
        timestamp: 2_500,
        providerData: {
          ...initialAssistant.providerData,
          conversationRequestId: 'request-synthetic-2',
          messageId: 'response-synthetic-3',
        },
      },
    ];
    await appendFile(transcript, secondTurn.map(record => JSON.stringify(record)).join('\n') + '\n');

    const entries = await input.collectNow();
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => entry['gen_ai.turn.id'] === 'turn-synthetic-2')).toBe(true);
    await stateStore.save();
    expect(await input.collectNow()).toEqual([]);
    const persistedState = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')).workbuddy;
    expect(persistedState).toBeDefined();
    expect(persistedState.extra.workbuddySqliteCursor).toBeUndefined();
  });
});
