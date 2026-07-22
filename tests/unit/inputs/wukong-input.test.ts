import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as nodePath from 'node:path';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { WukongInput } from '../../../src/inputs/wukong/wukong-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

const LEETCODE_FIXTURE = JSON.parse(
  readFileSync(
    nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '../../fixtures/wukong/leetcode-session.json'),
    'utf-8',
  ),
);

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = (childProcess as any).execFile as Mock;

function makeExecFileImpl(responses: Record<string, string>) {
  return (...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as Function;
    const args = allArgs[1] as string[];
    const subcommand = args.join(' ');

    for (const [key, stdout] of Object.entries(responses)) {
      if (subcommand.includes(key)) {
        cb(null, { stdout, stderr: '' });
        return;
      }
    }
    cb(new Error(`unexpected command: ${subcommand}`), { stdout: '', stderr: '' });
  };
}

/** Route get_spark_agui_messages calls by conversationId in the JSON arg. */
function makeExecFileImplByConversation(
  listTasksResp: string,
  messagesByConversation: Record<string, string>,
) {
  return (...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as Function;
    const args = allArgs[1] as string[];
    const subcommand = args.join(' ');

    if (subcommand.includes('list_tasks')) {
      cb(null, { stdout: listTasksResp, stderr: '' });
      return;
    }
    if (subcommand.includes('get_spark_agui_messages')) {
      const jsonArg = args[args.length - 1]!;
      const parsed = JSON.parse(jsonArg);
      const resp = messagesByConversation[parsed.conversationId];
      if (resp) {
        cb(null, { stdout: resp, stderr: '' });
        return;
      }
    }
    cb(new Error(`unexpected command: ${subcommand}`), { stdout: '', stderr: '' });
  };
}

const SAMPLE_TASK = {
  id: 'task-1',
  session_id: 'sess-1',
  name: 'Test task',
  status: 'completed',
  agent_type: 'spark',
  created_at: 1779240536440,
  completed_at: 1779240561311,
  started_at: 1779240536442,
  last_active_at: 1779240536440,
  metadata: {
    modelName: 'dingtalk_deap/dingtalk-standard',
    modelProvider: 'dingtalk_deap',
    sandbox_level: 'relaxed',
  },
};

const SAMPLE_MESSAGES = [
  {
    id: 'msg-1',
    conversationId: 'sess-1',
    role: 'user',
    content: 'Hello wukong',
    events: null,
    createdAt: 1779240548629,
    timestamp: 1779240548629,
    turnIndex: 0,
  },
  {
    id: 'msg-2',
    conversationId: 'sess-1',
    role: 'assistant',
    content: null,
    events: [
      { type: 'RUN_STARTED', runId: 'run-1', threadId: 'sess-1', timestamp: 1779240557803 },
      { type: 'FIRST_TOKEN', ttft_ms: 1794, e2e_ttft_ms: 9164, timestamp: 1779240557803 },
      { type: 'TEXT_MESSAGE_START', messageId: 'text-1', role: 'assistant', timestamp: 1779240557844 },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello! ', messageId: 'text-1', timestamp: 1779240557844 },
      { type: 'TEXT_MESSAGE_CONTENT', delta: 'How can I help?', messageId: 'text-1', timestamp: 1779240558000 },
      { type: 'TEXT_MESSAGE_END', messageId: 'text-1', timestamp: 1779240559964 },
      { type: 'USAGE', prompt_tokens: 100, completion_tokens: 20, cached_tokens: 0, total_tokens: 120, timestamp: 1779240561303 },
      { type: 'RUN_FINISHED', runId: 'run-1', threadId: 'sess-1', timestamp: 1779240561303 },
    ],
    createdAt: 1779240557803,
    timestamp: 1779240557803,
    turnIndex: 1,
  },
];

describe('WukongInput', () => {
  let stateStore: MockStateStore;
  let input: WukongInput;

  beforeEach(() => {
    stateStore = new MockStateStore();
    mockExecFile.mockReset();
  });

  function createInput() {
    input = new WukongInput({
      stateStore: stateStore as any,
      cliPath: '/usr/bin/wukong-cli',
      pollIntervalMs: 60_000,
    });
    return input;
  }

  function seedSeenCounts(counts: Record<string, number> = {}) {
    stateStore.update('wukong', { extra: { seenCounts: counts } });
  }

  it('user content is merged into step 1 llm.request messages_delta', async () => {
    const listResp = JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] });
    const msgsResp = JSON.stringify({ messages: SAMPLE_MESSAGES });

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: listResp,
      get_spark_agui_messages: msgsResp,
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // User-hook llm.request is no longer emitted; user content is in step 1 llm.request
    const reqEntry = entries.find(e => e['event.name'] === 'llm.request');
    expect(reqEntry).toBeDefined();
    expect(reqEntry!['gen_ai.agent.type']).toBe(ClientType.Wukong);
    expect(reqEntry!['gen_ai.session.id']).toBe('sess-1');
    expect(reqEntry!['gen_ai.step.id']).toBeDefined();
    expect(reqEntry!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hello wukong' }] },
    ]);
    expect(reqEntry!['host.name']).toBe(os.hostname());
    expect(reqEntry!['service.name']).toBe('wukong');
    expect(reqEntry!['gen_ai.agent.id']).toBe('task-1');
    expect(reqEntry!['gen_ai.agent.name']).toBe('wukong');
    expect(reqEntry!['gen_ai.provider.name']).toBe('dingtalk_deap');
    expect(reqEntry!['gen_ai.turn.id']).toBe('sess-1:t1');
  });

  it('maps assistant events to llm.response with token usage', async () => {
    const listResp = JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] });
    const msgsResp = JSON.stringify({ messages: SAMPLE_MESSAGES });

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: listResp,
      get_spark_agui_messages: msgsResp,
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry).toBeDefined();
    expect(respEntry!['gen_ai.agent.type']).toBe(ClientType.Wukong);
    expect(respEntry!['gen_ai.session.id']).toBe('sess-1');
    expect(respEntry!['gen_ai.response.id']).toBe('text-1');
    expect(respEntry!['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello! How can I help?' }] },
    ]);
    expect(respEntry!['gen_ai.usage.input_tokens']).toBe(100);
    expect(respEntry!['gen_ai.usage.output_tokens']).toBe(20);
    expect(respEntry!['gen_ai.usage.total_tokens']).toBe(120);
    expect(respEntry!['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect(respEntry!['host.name']).toBe(os.hostname());
    expect(respEntry!['service.name']).toBe('wukong');
    expect(respEntry!['gen_ai.agent.id']).toBe('task-1');
    expect(respEntry!['gen_ai.agent.name']).toBe('wukong');
    expect(respEntry!['gen_ai.provider.name']).toBe('dingtalk_deap');
    expect(respEntry!['gen_ai.turn.id']).toBe('sess-1:t1');
  });

  it('only collects new messages appended to an existing session', async () => {
    const msg3User = {
      id: 'msg-3', conversationId: 'sess-1', role: 'user' as const,
      content: 'Follow up question', events: null,
      createdAt: 1779240600000, timestamp: 1779240600000, turnIndex: 2,
    };
    const msg4Asst = {
      id: 'msg-4', conversationId: 'sess-1', role: 'assistant' as const,
      content: null, events: [
        { type: 'RUN_STARTED', runId: 'run-2', threadId: 'sess-1', timestamp: 1779240600100 },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'Here is the answer.', messageId: 'text-2', timestamp: 1779240600200 },
        { type: 'USAGE', prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, timestamp: 1779240600300 },
        { type: 'RUN_FINISHED', runId: 'run-2', threadId: 'sess-1', timestamp: 1779240600300 },
      ],
      createdAt: 1779240600100, timestamp: 1779240600100, turnIndex: 3,
    };

    const allMessages = [...SAMPLE_MESSAGES, msg3User, msg4Asst];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: allMessages }),
    }));

    createInput();
    seedSeenCounts({ 'sess-1': 2 });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(3);
    const other = entries.find(e => e['event.name'] === 'other');
    expect(other).toBeDefined();
    expect(other!['gen_ai.step.id']).toBeUndefined();
    expect(other!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Follow up question' }] },
    ]);
    const llmReq = entries.find(e => e['event.name'] === 'llm.request');
    expect(llmReq).toBeDefined();
    expect(llmReq!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Follow up question' }] },
    ]);
    const llmResp = entries.find(e => e['event.name'] === 'llm.response');
    expect(llmResp).toBeDefined();
    expect(llmResp!['gen_ai.usage.input_tokens']).toBe(200);

    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-1']).toBe(4);
  });

  it('picks up new tasks and existing sessions with new messages', async () => {
    const task2 = { ...SAMPLE_TASK, id: 'task-2', session_id: 'sess-2' };
    const msg_t2 = {
      id: 'msg-t2-1', conversationId: 'sess-2', role: 'user' as const,
      content: 'New session', events: null,
      createdAt: 1779240700000, timestamp: 1779240700000, turnIndex: 0,
    };

    mockExecFile.mockImplementation(makeExecFileImplByConversation(
      JSON.stringify({ hasMore: false, items: [SAMPLE_TASK, task2] }),
      {
        'sess-1': JSON.stringify({ messages: SAMPLE_MESSAGES }),
        'sess-2': JSON.stringify({ messages: [msg_t2] }),
      },
    ));

    createInput();
    seedSeenCounts({ 'sess-1': 2 });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-2'] ?? 0).toBe(0);
  });

  it('handles daemon-not-running gracefully', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('connect ENOENT /daemon.sock'), { stdout: '', stderr: '' });
      },
    );

    createInput();
    seedSeenCounts();

    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
  });

  it('maps TOOL_CALL_START and TOOL_CALL_END to tool events', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-tool',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-2', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-1', toolName: 'web_search', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-1', toolName: 'web_search', result: { url: 'https://example.com' }, timestamp: 1779240560500 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Found result.', messageId: 'text-2', timestamp: 1779240560600 },
          { type: 'USAGE', prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, timestamp: 1779240560700 },
          { type: 'RUN_FINISHED', runId: 'run-2', threadId: 'sess-1', timestamp: 1779240560700 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolCall = entries.find(e => e['event.name'] === 'tool.call');
    expect(toolCall).toBeDefined();
    expect(toolCall!['gen_ai.tool.name']).toBe('web_search');
    expect(toolCall!['gen_ai.tool.call.id']).toBe('tc-1');

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['gen_ai.tool.name']).toBe('web_search');
    expect(toolResult!['gen_ai.tool.call.result']).toEqual({ url: 'https://example.com' });
  });

  it('skips user messages with empty content', async () => {
    const emptyMessages = [
      { ...SAMPLE_MESSAGES[0]!, content: '' },
      { ...SAMPLE_MESSAGES[0]!, id: 'msg-null', content: null },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: emptyMessages }),
    }));

    createInput();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
  });

  it('baselines on first start to avoid replaying history', async () => {
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: SAMPLE_MESSAGES }),
    }));

    createInput();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-1']).toBe(2);
  });

  it('paginates through all tasks when hasMore is true', async () => {
    const task2 = { ...SAMPLE_TASK, id: 'task-2', session_id: 'sess-2' };
    const msg_t2 = {
      id: 'msg-t2-1', conversationId: 'sess-2', role: 'user' as const,
      content: 'Page 2 task', events: null,
      createdAt: 1779240700000, timestamp: 1779240700000, turnIndex: 0,
    };

    let listCallCount = 0;
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as Function;
      const args = allArgs[1] as string[];
      const subcommand = args.join(' ');

      if (subcommand.includes('list_tasks')) {
        listCallCount++;
        if (listCallCount === 1) {
          cb(null, {
            stdout: JSON.stringify({ hasMore: true, items: [SAMPLE_TASK], nextCursor: 'cursor-1' }),
            stderr: '',
          });
        } else {
          cb(null, {
            stdout: JSON.stringify({ hasMore: false, items: [task2] }),
            stderr: '',
          });
        }
        return;
      }
      if (subcommand.includes('get_spark_agui_messages')) {
        const jsonArg = args[args.length - 1]!;
        const parsed = JSON.parse(jsonArg);
        if (parsed.conversationId === 'sess-1') {
          cb(null, { stdout: JSON.stringify({ messages: SAMPLE_MESSAGES }), stderr: '' });
        } else {
          cb(null, { stdout: JSON.stringify({ messages: [msg_t2] }), stderr: '' });
        }
        return;
      }
      cb(new Error(`unexpected: ${subcommand}`), { stdout: '', stderr: '' });
    });

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(listCallCount).toBe(2);
    const sessionIds = new Set(entries.map(e => e['gen_ai.session.id']));
    expect(sessionIds.has('sess-1')).toBe(true);
  });

  it('does not prune seenCounts on first miss (grace window)', async () => {
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: SAMPLE_MESSAGES }),
    }));

    createInput();
    seedSeenCounts({ 'sess-1': 2, 'stale-sess': 10 });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const state = stateStore.get('wukong');
    const seenCounts = (state.extra as any).seenCounts;
    const staleCounters = (state.extra as any).staleCounters ?? {};
    // Active session unchanged
    expect(seenCounts['sess-1']).toBe(2);
    // Missing session is NOT pruned on first miss; staleCounter increments to 1
    expect(seenCounts['stale-sess']).toBe(10);
    expect(staleCounters['stale-sess']).toBe(1);
  });

  it('marks tool.result.status as failure when event has error', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-tool-err',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-3', threadId: 'sess-1', timestamp: 1779240570000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-err', toolName: 'file_read', timestamp: 1779240570100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-err', toolName: 'file_read', isError: true, error: 'ENOENT: file not found', timestamp: 1779240570500 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240570600 },
          { type: 'RUN_FINISHED', runId: 'run-3', threadId: 'sess-1', timestamp: 1779240570600 },
        ],
        createdAt: 1779240570000,
        timestamp: 1779240570000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['error.type']).toBe('ENOENT: file not found');
  });

  it('uses message id as turn id fallback when turnIndex is negative', async () => {
    const negTurnMessages = [
      { ...SAMPLE_MESSAGES[0]!, turnIndex: -1 },
      { ...SAMPLE_MESSAGES[1]!, turnIndex: -1 },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: negTurnMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const reqEntry = entries.find(e => e['event.name'] === 'llm.request');
    expect(reqEntry!['gen_ai.turn.id']).toBe('sess-1:msg-2');

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.turn.id']).toBe('sess-1:msg-2');
  });

  it('computes gen_ai.tool.call.duration from TOOL_CALL timestamps', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-tool-dur',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-5', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-d1', toolName: 'bash', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-d1', toolName: 'bash', result: 'ok', timestamp: 1779240560500 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240560600 },
          { type: 'RUN_FINISHED', runId: 'run-5', threadId: 'sess-1', timestamp: 1779240560600 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['gen_ai.tool.call.duration']).toBe(400);
  });

  it('computes duration without toolCallId (fallback key matching)', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-tool-noId',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-6', threadId: 'sess-1', timestamp: 1779240590000 },
          { type: 'TOOL_CALL_START', toolName: 'bash', timestamp: 1779240590100 },
          { type: 'TOOL_CALL_END', toolName: 'bash', result: 'ok', timestamp: 1779240590350 },
          { type: 'USAGE', prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, timestamp: 1779240590400 },
          { type: 'RUN_FINISHED', runId: 'run-6', threadId: 'sess-1', timestamp: 1779240590400 },
        ],
        createdAt: 1779240590000,
        timestamp: 1779240590000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['gen_ai.tool.call.duration']).toBe(250);
  });

  it('generates unique event.id for multiple tool calls without toolCallId', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-multi-tool',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-4', threadId: 'sess-1', timestamp: 1779240580000 },
          { type: 'TOOL_CALL_START', toolName: 'bash', timestamp: 1779240580100 },
          { type: 'TOOL_CALL_END', toolName: 'bash', result: 'ok', timestamp: 1779240580200 },
          { type: 'TOOL_CALL_START', toolName: 'bash', timestamp: 1779240580300 },
          { type: 'TOOL_CALL_END', toolName: 'bash', result: 'done', timestamp: 1779240580400 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240580500 },
          { type: 'RUN_FINISHED', runId: 'run-4', threadId: 'sess-1', timestamp: 1779240580500 },
        ],
        createdAt: 1779240580000,
        timestamp: 1779240580000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolCalls = entries.filter(e => e['event.name'] === 'tool.call');
    const toolResults = entries.filter(e => e['event.name'] === 'tool.result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);

    const allIds = [...toolCalls, ...toolResults].map(e => e['event.id']);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(4);
  });

  it('computes duration for multiple tool calls without toolCallId', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-multi-dur',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-7', threadId: 'sess-1', timestamp: 1779240600000 },
          { type: 'TOOL_CALL_START', toolName: 'bash', timestamp: 1779240600100 },
          { type: 'TOOL_CALL_END', toolName: 'bash', result: 'ok', timestamp: 1779240600300 },
          { type: 'TOOL_CALL_START', toolName: 'read', timestamp: 1779240600400 },
          { type: 'TOOL_CALL_END', toolName: 'read', result: 'data', timestamp: 1779240600900 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240601000 },
          { type: 'RUN_FINISHED', runId: 'run-7', threadId: 'sess-1', timestamp: 1779240601000 },
        ],
        createdAt: 1779240600000,
        timestamp: 1779240600000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolResults = entries.filter(e => e['event.name'] === 'tool.result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]!['gen_ai.tool.call.duration']).toBe(200);
    expect(toolResults[1]!['gen_ai.tool.call.duration']).toBe(500);
  });

  it('sets gen_ai.step.id on all events (fallback single step)', async () => {
    const listResp = JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] });
    const msgsResp = JSON.stringify({ messages: SAMPLE_MESSAGES });

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: listResp,
      get_spark_agui_messages: msgsResp,
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.step.id']).toBe('sess-1:t1:s1');
  });

  it('generates step.id from STEP_STARTED events', async () => {
    const stepMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-steps',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-s1', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'STEP_STARTED', messageId: 'step-uuid-1', stepName: 'Read file', timestamp: 1779240560010 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-s1', toolName: 'file_read', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-s1', toolName: 'file_read', result: 'content', timestamp: 1779240560300 },
          { type: 'STEP_FINISHED', messageId: 'step-uuid-1', timestamp: 1779240560400 },
          { type: 'STEP_STARTED', messageId: 'step-uuid-2', stepName: 'Respond', timestamp: 1779240560500 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Done!', messageId: 'text-1', timestamp: 1779240560600 },
          { type: 'USAGE', prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, timestamp: 1779240560700 },
          { type: 'STEP_FINISHED', messageId: 'step-uuid-2', timestamp: 1779240560700 },
          { type: 'RUN_FINISHED', runId: 'run-s1', threadId: 'sess-1', timestamp: 1779240560800 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: stepMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolCall = entries.find(e => e['event.name'] === 'tool.call');
    expect(toolCall!['gen_ai.step.id']).toBe('sess-1:t1:s1');

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult!['gen_ai.step.id']).toBe('sess-1:t1:s1');

    // Per-step LLM emission: each STEP_FINISHED emits its own llm.response
    const llmResponses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(llmResponses).toHaveLength(2);
    const respS1 = llmResponses.find(e => e['gen_ai.step.id'] === 'sess-1:t1:s1');
    const respS2 = llmResponses.find(e => e['gen_ai.step.id'] === 'sess-1:t1:s2');
    expect(respS1).toBeDefined();
    expect(respS2).toBeDefined();
    // s1 had a tool call → finish_reasons = tool_calls
    expect(respS1!['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    // s2 was text-only and is the final step → finish_reasons = end_turn
    expect(respS2!['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    // Real USAGE captured for s2 (no longer zeroed by orphan-synthesis fallback)
    expect(respS2!['gen_ai.usage.input_tokens']).toBe(200);
    expect(respS2!['gen_ai.usage.output_tokens']).toBe(30);
  });

  it('sets finish_reasons to ["tool_calls"] when step has tool calls', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-fr-tools',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-fr', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-fr', toolName: 'bash', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-fr', toolName: 'bash', result: 'ok', timestamp: 1779240560300 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Ran command.', messageId: 'text-1', timestamp: 1779240560400 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, timestamp: 1779240560500 },
          { type: 'RUN_FINISHED', runId: 'run-fr', threadId: 'sess-1', timestamp: 1779240560500 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
  });

  it('sets finish_reasons to ["end_turn"] for text-only responses', async () => {
    const listResp = JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] });
    const msgsResp = JSON.stringify({ messages: SAMPLE_MESSAGES });

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: listResp,
      get_spark_agui_messages: msgsResp,
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  it('sets finish_reasons to ["stop"] on RUN_ERROR and populates error fields', async () => {
    const errorMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-err',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-err', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Working...', messageId: 'text-1', timestamp: 1779240560100 },
          { type: 'RUN_ERROR', code: 'CANCELLED', message: '任务已终止', runId: 'run-err', timestamp: 1779240560200 },
          { type: 'RUN_FINISHED', runId: 'run-err', threadId: 'sess-1', timestamp: 1779240560200 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: errorMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(respEntry!['error.type']).toBe('CANCELLED');
    expect(respEntry!['error.message']).toBe('任务已终止');
  });

  it('accumulates TOOL_CALL_ARGS delta into tool.call arguments', async () => {
    const argsMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-args',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-a', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-a', toolName: 'browser_use', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'tc-a', delta: '{"action":', timestamp: 1779240560150 },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'tc-a', delta: '"click","selector":"#btn"}', timestamp: 1779240560200 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-a', toolName: 'browser_use', result: 'clicked', timestamp: 1779240560500 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Clicked.', messageId: 'text-1', timestamp: 1779240560600 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240560700 },
          { type: 'RUN_FINISHED', runId: 'run-a', threadId: 'sess-1', timestamp: 1779240560700 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: argsMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolCall = entries.find(e => e['event.name'] === 'tool.call');
    expect(toolCall!['gen_ai.tool.call.arguments']).toEqual({ action: 'click', selector: '#btn' });
  });

  it('transforms ACTIVITY_SNAPSHOT into tool.call + tool.result pair', async () => {
    const activityMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-activity',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-act', threadId: 'sess-1', timestamp: 1779240560000 },
          {
            type: 'ACTIVITY_SNAPSHOT', activityType: 'TERMINAL', timestamp: 1779240560100,
            content: { command: 'ls -la', output: 'total 0\ndrwxr-xr-x', exit_code: 0, start_time: 1779240560100, finish_time: 1779240560300 },
          },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Listed files.', messageId: 'text-1', timestamp: 1779240560400 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, timestamp: 1779240560500 },
          { type: 'RUN_FINISHED', runId: 'run-act', threadId: 'sess-1', timestamp: 1779240560500 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: activityMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolCall = entries.find(e => e['event.name'] === 'tool.call');
    expect(toolCall).toBeDefined();
    expect(toolCall!['gen_ai.tool.name']).toBe('terminal');
    expect(toolCall!['gen_ai.tool.call.arguments']).toEqual({ command: 'ls -la' });

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult!['gen_ai.tool.name']).toBe('terminal');
    expect(toolResult!['gen_ai.tool.call.result']).toEqual({ output: 'total 0\ndrwxr-xr-x', exit_code: 0 });
    expect(toolResult!['gen_ai.tool.call.duration']).toBe(200);
  });

  it('generates trace_id and span_id on all assistant-derived entries', async () => {
    const listResp = JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] });
    const msgsResp = JSON.stringify({ messages: SAMPLE_MESSAGES });

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: listResp,
      get_spark_agui_messages: msgsResp,
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['trace_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(respEntry!['span_id']).toMatch(/^[0-9a-f]{16}$/);
    expect(respEntry!['parent_span_id']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not process incomplete assistant messages (no RUN_FINISHED)', async () => {
    const incompleteMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-incomplete',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-inc', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Still thinking...', messageId: 'text-1', timestamp: 1779240560100 },
          // No RUN_FINISHED — message is still streaming
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: incompleteMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Both user msg and incomplete assistant should be deferred (no orphan emissions)
    expect(entries).toHaveLength(0);

    // seenCounts should not advance - both messages will be re-evaluated on next poll
    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-1'] ?? 0).toBe(0);
  });

  it('processes incomplete message once it becomes complete on next poll', async () => {
    const incompleteMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-stream',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-s', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Thinking...', messageId: 'text-1', timestamp: 1779240560100 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    const completeMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-stream',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-s', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Thinking...', messageId: 'text-1', timestamp: 1779240560100 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: ' Done!', messageId: 'text-1', timestamp: 1779240560200 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, timestamp: 1779240560300 },
          { type: 'RUN_FINISHED', runId: 'run-s', threadId: 'sess-1', timestamp: 1779240560300 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    // First poll: incomplete
    let callCount = 0;
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as Function;
      const args = allArgs[1] as string[];
      const subcommand = args.join(' ');

      if (subcommand.includes('list_tasks')) {
        cb(null, { stdout: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }), stderr: '' });
        return;
      }
      if (subcommand.includes('get_spark_agui_messages')) {
        callCount++;
        const msgs = callCount === 1 ? incompleteMessages : completeMessages;
        cb(null, { stdout: JSON.stringify({ messages: msgs }), stderr: '' });
        return;
      }
      cb(new Error(`unexpected: ${subcommand}`), { stdout: '', stderr: '' });
    });

    createInput();
    seedSeenCounts();

    // First poll
    const entries1: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries1.push(...e));
    await input.start();
    await input.stop();

    expect(entries1).toHaveLength(0); // both user and incomplete assistant deferred
    const state1 = stateStore.get('wukong');
    expect((state1.extra as any).seenCounts['sess-1'] ?? 0).toBe(0);

    // Second poll: message is now complete
    const entries2: AgentActivityEntry[] = [];
    const input2 = new WukongInput({
      stateStore: stateStore as any,
      cliPath: '/usr/bin/wukong-cli',
      pollIntervalMs: 60_000,
    });
    input2.on('entries', (e: AgentActivityEntry[]) => entries2.push(...e));
    await input2.start();
    await input2.stop();

    const respEntry = entries2.find(e => e['event.name'] === 'llm.response');
    expect(respEntry).toBeDefined();
    expect(respEntry!['gen_ai.usage.input_tokens']).toBe(100);
    expect(respEntry!['gen_ai.usage.output_tokens']).toBe(20);
    expect(respEntry!['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Thinking... Done!' }] },
    ]);
  });

  it('sets gen_ai.tool.name on tool.result from TOOL_CALL_START', async () => {
    const toolMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-tn',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-tn', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-tn', toolName: 'web_search', timestamp: 1779240560100 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-tn', result: 'found', timestamp: 1779240560500 },
          { type: 'USAGE', prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, timestamp: 1779240560600 },
          { type: 'RUN_FINISHED', runId: 'run-tn', threadId: 'sess-1', timestamp: 1779240560600 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: toolMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const toolResult = entries.find(e => e['event.name'] === 'tool.result');
    expect(toolResult!['gen_ai.tool.name']).toBe('web_search');
  });

  it('emits llm.response for RUN_ERROR-only assistant turn (no text/tools)', async () => {
    const errMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-erronly',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-eo', threadId: 'sess-1', timestamp: 1779240560000 },
          { type: 'RUN_ERROR', code: 'CANCELLED', message: '任务被取消', runId: 'run-eo', timestamp: 1779240560100 },
          { type: 'RUN_FINISHED', runId: 'run-eo', threadId: 'sess-1', timestamp: 1779240560100 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: errMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry).toBeDefined();
    expect(respEntry!['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(respEntry!['error.type']).toBe('CANCELLED');
    expect(respEntry!['error.message']).toBe('任务被取消');
  });

  it('handles task with null/missing metadata gracefully', async () => {
    const taskWithBadMeta = { ...SAMPLE_TASK, metadata: null as any };
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [taskWithBadMeta] }),
      get_spark_agui_messages: JSON.stringify({ messages: SAMPLE_MESSAGES }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Should not throw; should still emit llm.response with model='unknown'
    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry).toBeDefined();
    expect(respEntry!['gen_ai.request.model']).toBe('unknown');
  });

  it('sanitizes invalid evt.timestamp to msg.createdAt', async () => {
    const badTsMessages = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-bad-ts',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-bad', threadId: 'sess-1', timestamp: 'not-a-number' as any },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'hi', messageId: 'text-1', timestamp: null as any },
          { type: 'USAGE', prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, timestamp: 1779240560700 },
          { type: 'RUN_FINISHED', runId: 'run-bad', threadId: 'sess-1', timestamp: undefined as any },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: badTsMessages }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Should not crash; entries should have finite time_unix_nano
    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry).toBeDefined();
    const ts = String(respEntry!['time_unix_nano']);
    expect(ts).not.toContain('NaN');
    expect(Number.isFinite(Number(ts))).toBe(true);
  });

  it('STEP_FINISHED captures per-step USAGE so each step has real tokens', async () => {
    const multiStepMsgs = [
      SAMPLE_MESSAGES[0],
      {
        id: 'msg-multistep',
        conversationId: 'sess-1',
        role: 'assistant' as const,
        content: null,
        events: [
          { type: 'RUN_STARTED', runId: 'run-ms', threadId: 'sess-1', timestamp: 1779240560000 },
          // Step 1: tool call with USAGE
          { type: 'STEP_STARTED', messageId: 'step-1', stepName: 'Search', timestamp: 1779240560010 },
          { type: 'TOOL_CALL_START', toolCallId: 'tc-1', toolName: 'search', timestamp: 1779240560020 },
          { type: 'TOOL_CALL_END', toolCallId: 'tc-1', toolName: 'search', result: 'data', timestamp: 1779240560100 },
          { type: 'USAGE', prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, timestamp: 1779240560110 },
          { type: 'STEP_FINISHED', messageId: 'step-1', timestamp: 1779240560120 },
          // Step 2: text only with different USAGE
          { type: 'STEP_STARTED', messageId: 'step-2', stepName: 'Answer', timestamp: 1779240560200 },
          { type: 'TEXT_MESSAGE_CONTENT', delta: 'Final answer', messageId: 'text-1', timestamp: 1779240560300 },
          { type: 'USAGE', prompt_tokens: 250, completion_tokens: 50, total_tokens: 300, timestamp: 1779240560400 },
          { type: 'STEP_FINISHED', messageId: 'step-2', timestamp: 1779240560400 },
          { type: 'RUN_FINISHED', runId: 'run-ms', threadId: 'sess-1', timestamp: 1779240560500 },
        ],
        createdAt: 1779240560000,
        timestamp: 1779240560000,
        turnIndex: 1,
      },
    ];

    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: multiStepMsgs }),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const llmResponses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(llmResponses).toHaveLength(2);
    const respS1 = llmResponses.find(e => e['gen_ai.step.id'] === 'sess-1:t1:s1')!;
    const respS2 = llmResponses.find(e => e['gen_ai.step.id'] === 'sess-1:t1:s2')!;
    // Each step captured its own real USAGE (not zeroed by orphan-synthesis fallback)
    expect(respS1['gen_ai.usage.input_tokens']).toBe(100);
    expect(respS1['gen_ai.usage.output_tokens']).toBe(20);
    expect(respS2['gen_ai.usage.input_tokens']).toBe(250);
    expect(respS2['gen_ai.usage.output_tokens']).toBe(50);
    // s1 has tool_calls finish, s2 has end_turn
    expect(respS1['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    expect(respS2['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  it('filters out tasks with null session_id from list_tasks', async () => {
    const taskWithNullSession = { ...SAMPLE_TASK, id: 'task-null', session_id: null as any, status: 'failed' };
    const getMessagesCalls: string[] = [];
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as Function;
      const args = allArgs[1] as string[];
      const subcommand = args.join(' ');

      if (subcommand.includes('list_tasks')) {
        cb(null, {
          stdout: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK, taskWithNullSession] }),
          stderr: '',
        });
        return;
      }
      if (subcommand.includes('get_spark_agui_messages')) {
        const jsonArg = args[args.length - 1]!;
        const parsed = JSON.parse(jsonArg);
        getMessagesCalls.push(parsed.conversationId);
        cb(null, {
          stdout: JSON.stringify({ messages: SAMPLE_MESSAGES }),
          stderr: '',
        });
        return;
      }
      cb(new Error(`unexpected: ${subcommand}`), { stdout: '', stderr: '' });
    });

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Should only process the task with valid session_id
    const sessionIds = new Set(entries.map(e => e['gen_ai.session.id']));
    expect(sessionIds.has('sess-1')).toBe(true);
    // getMessages should only be called for sess-1, never for null
    expect(getMessagesCalls).toEqual(['sess-1']);
  });

  it('handles empty stdout from get_spark_agui_messages gracefully', async () => {
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as Function;
      const args = allArgs[1] as string[];
      const subcommand = args.join(' ');

      if (subcommand.includes('list_tasks')) {
        cb(null, {
          stdout: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
          stderr: '',
        });
        return;
      }
      if (subcommand.includes('get_spark_agui_messages')) {
        // Simulate the daemon gateway returning empty stdout
        cb(null, { stdout: '', stderr: '' });
        return;
      }
      cb(new Error(`unexpected: ${subcommand}`), { stdout: '', stderr: '' });
    });

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Should not crash; should emit no entries (treated as empty messages)
    expect(entries).toHaveLength(0);
  });

  it('handles whitespace-only stdout from get_spark_agui_messages gracefully', async () => {
    mockExecFile.mockImplementation((...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as Function;
      const args = allArgs[1] as string[];
      const subcommand = args.join(' ');

      if (subcommand.includes('list_tasks')) {
        cb(null, {
          stdout: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
          stderr: '',
        });
        return;
      }
      if (subcommand.includes('get_spark_agui_messages')) {
        cb(null, { stdout: '  \n  ', stderr: '' });
        return;
      }
      cb(new Error(`unexpected: ${subcommand}`), { stdout: '', stderr: '' });
    });

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
  });

  it('handles empty stdout from list_tasks gracefully', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        // Simulate daemon gateway returning empty stdout for list_tasks
        cb(null, { stdout: '', stderr: '' });
      },
    );

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    expect(entries).toHaveLength(0);
  });

  it('prunes seenCounts after STALE_PRUNE_THRESHOLD consecutive misses', async () => {
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: SAMPLE_MESSAGES }),
    }));

    createInput();
    // Pre-seed with stale counter at threshold-1 → next miss should prune
    stateStore.update('wukong', {
      extra: { seenCounts: { 'sess-1': 2, 'stale-sess': 10 }, staleCounters: { 'stale-sess': 4 } },
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const state = stateStore.get('wukong');
    const seenCounts = (state.extra as any).seenCounts;
    const staleCounters = (state.extra as any).staleCounters ?? {};
    expect(seenCounts['stale-sess']).toBeUndefined();
    expect(staleCounters['stale-sess']).toBeUndefined();
  });

  it('end-to-end real session: other-first, full answer, real tokens, ordered decision-aligned steps', async () => {
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify(LEETCODE_FIXTURE.listTasks),
      get_spark_agui_messages: JSON.stringify(LEETCODE_FIXTURE.messages),
    }));

    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Problem 2a: the turn begins with exactly one `other` carrying the user prompt (no step id).
    const others = entries.filter(e => e['event.name'] === 'other');
    expect(others).toHaveLength(1);
    expect(others[0]['gen_ai.step.id']).toBeUndefined();
    expect(JSON.stringify(others[0]['gen_ai.input.messages_delta'])).toContain('单调队列');

    // Problem 2b/3: records are sorted ascending by time_unix_nano; `other` is first
    // and no tool.call precedes the first llm.request.
    const times = entries.map(e => BigInt(String(e['time_unix_nano'])));
    for (let i = 1; i < times.length; i++) expect(times[i] >= times[i - 1]).toBe(true);
    const names = entries.map(e => e['event.name']);
    expect(names[0]).toBe('other');
    const firstReq = names.indexOf('llm.request');
    const firstTool = names.indexOf('tool.call');
    expect(firstReq).toBeGreaterThanOrEqual(0);
    expect(firstTool).toBeGreaterThan(firstReq);

    // Problem 3: STEP count == LLM decision count == 2 (text→file_read, then final answer).
    const stepIds = new Set(entries.filter(e => e['gen_ai.step.id']).map(e => e['gen_ai.step.id']));
    const llmReqs = entries.filter(e => e['event.name'] === 'llm.request');
    const llmResps = entries.filter(e => e['event.name'] === 'llm.response');
    expect(stepIds.size).toBe(2);
    expect(llmReqs).toHaveLength(2);
    expect(llmResps).toHaveLength(2);

    // Problem 1: final answer is NOT truncated — the full Java explanation is present.
    const finalResp = llmResps.reduce((a, b) =>
      Number(b['time_unix_nano']) > Number(a['time_unix_nano']) ? b : a);
    const outStr = JSON.stringify(finalResp['gen_ai.output.messages']);
    expect(outStr).toContain('ArrayDeque');
    expect(outStr).toContain('复杂度');
    expect(finalResp['gen_ai.response.finish_reasons']).toEqual(['end_turn']);

    // Problem 4: real tokens land on the final step, and the AGENT aggregate equals them.
    expect(finalResp['gen_ai.usage.input_tokens']).toBe(36779);
    expect(finalResp['gen_ai.usage.output_tokens']).toBe(906);
    expect(finalResp['gen_ai.usage.total_tokens']).toBe(37685);
    expect(finalResp['gen_ai.usage.cache_read.input_tokens']).toBe(34048);
    const sumIn = llmResps.reduce((s, e) => s + Number(e['gen_ai.usage.input_tokens'] ?? 0), 0);
    const sumOut = llmResps.reduce((s, e) => s + Number(e['gen_ai.usage.output_tokens'] ?? 0), 0);
    expect(sumIn).toBe(36779);
    expect(sumOut).toBe(906);

    // The first decision paired a file_read tool.call/result.
    const toolCalls = entries.filter(e => e['event.name'] === 'tool.call');
    const toolResults = entries.filter(e => e['event.name'] === 'tool.result');
    expect(toolCalls).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
    expect(toolCalls[0]['gen_ai.tool.name']).toBe('file_read');
    // FILE_READ activity payload must be extracted (regression guard for the
    // over-trimmed extraction switch): arguments carry the path, result the content.
    expect(JSON.stringify(toolCalls[0]['gen_ai.tool.call.arguments'])).toContain('leetcode.cn');
    expect(JSON.stringify(toolResults[0]['gen_ai.tool.call.result'])).toContain('滑动窗口');

    // No 0-duration LLM span: the tool-step request precedes its response.
    const toolStep = toolCalls[0]['gen_ai.step.id'];
    const s1Req = llmReqs.find(e => e['gen_ai.step.id'] === toolStep)!;
    const s1Resp = llmResps.find(e => e['gen_ai.step.id'] === toolStep)!;
    expect(Number(s1Resp['time_unix_nano'])).toBeGreaterThan(Number(s1Req['time_unix_nano']));
  });

  it('extracts activity args/result for FILE_READ, SEARCH, SKILL, ARTIFACT', async () => {
    const asstEvents = [
      { type: 'RUN_STARTED', runId: 'r', threadId: 'sess-1', timestamp: 100 },
      { type: 'ACTIVITY_SNAPSHOT', activityType: 'FILE_READ', timestamp: 110, content: { path: '/tmp/a.txt', content: 'file body text', snippet: 'snip', status: 'completed', start_time: 110, finish_time: 120 } },
      { type: 'ACTIVITY_SNAPSHOT', activityType: 'SEARCH', timestamp: 130, content: { queries: ['needle-q'], search_type: 'web', results: ['hit-r'], status: 'ok', start_time: 130, finish_time: 140 } },
      { type: 'ACTIVITY_SNAPSHOT', activityType: 'SKILL', timestamp: 150, content: { skill_name: 'pptx-skill', purpose: 'make slides', output: 'skill-done', status: 'completed', start_time: 150, finish_time: 160 } },
      { type: 'ACTIVITY_SNAPSHOT', activityType: 'ARTIFACT', timestamp: 170, content: { artifactsMetadata: { name: 'deck' }, generatedAt: 171, start_time: 170, finish_time: 180 } },
      { type: 'USAGE', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, timestamp: 190 },
      { type: 'RUN_FINISHED', runId: 'r', threadId: 'sess-1', timestamp: 191 },
    ];
    const msgs = [
      { id: 'u', conversationId: 'sess-1', role: 'user' as const, content: 'go', events: null, createdAt: 1, timestamp: 1, turnIndex: 0, isComplete: 1 },
      { id: 'a', conversationId: 'sess-1', role: 'assistant' as const, content: null, events: asstEvents, createdAt: 100, timestamp: 100, turnIndex: 1, isComplete: 1 },
    ];
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: msgs }),
    }));
    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const call = (name: string) => entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.tool.name'] === name)!;
    const res = (name: string) => entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.tool.name'] === name)!;
    expect(JSON.stringify(call('file_read')['gen_ai.tool.call.arguments'])).toContain('/tmp/a.txt');
    expect(JSON.stringify(res('file_read')['gen_ai.tool.call.result'])).toContain('file body text');
    expect(JSON.stringify(call('search')['gen_ai.tool.call.arguments'])).toContain('needle-q');
    expect(JSON.stringify(res('search')['gen_ai.tool.call.result'])).toContain('hit-r');
    expect(JSON.stringify(call('skill')['gen_ai.tool.call.arguments'])).toContain('pptx-skill');
    expect(JSON.stringify(res('skill')['gen_ai.tool.call.result'])).toContain('skill-done');
    expect(JSON.stringify(res('artifact')['gen_ai.tool.call.result'])).toContain('artifactsMetadata');
  });

  it('derives activity result status from status/error_message, not only exit_code', async () => {
    const msgs = [
      { id: 'u', conversationId: 'sess-1', role: 'user' as const, content: 'go', events: null, createdAt: 1, timestamp: 1, turnIndex: 0, isComplete: 1 },
      { id: 'a', conversationId: 'sess-1', role: 'assistant' as const, content: null, isComplete: 1, createdAt: 100, timestamp: 100, turnIndex: 1, events: [
        { type: 'RUN_STARTED', runId: 'r', timestamp: 100 },
        // No exit_code, but status=error + error_message => failure with error.message.
        { type: 'ACTIVITY_SNAPSHOT', activityType: 'FILE_READ', timestamp: 110, content: { path: '/x', status: 'error', error_message: 'permission denied', start_time: 110, finish_time: 120 } },
        { type: 'USAGE', prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, timestamp: 130 },
        { type: 'RUN_FINISHED', runId: 'r', timestamp: 131 },
      ] },
    ];
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: msgs }),
    }));
    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const result = entries.find(e => e['event.name'] === 'tool.result')!;
    expect(result['tool.result.status']).toBe('failure');
    expect(result['error.message']).toBe('permission denied');
  });

  it('merges REASONING and TEXT into one llm.response (parts: reasoning, text)', async () => {
    const msgs = [
      { id: 'u', conversationId: 'sess-1', role: 'user' as const, content: 'hi', events: null, createdAt: 1, timestamp: 1, turnIndex: 0, isComplete: 1 },
      { id: 'a', conversationId: 'sess-1', role: 'assistant' as const, content: null, isComplete: 1, createdAt: 100, timestamp: 100, turnIndex: 1, events: [
        { type: 'RUN_STARTED', runId: 'r', timestamp: 100 },
        { type: 'REASONING_START', messageId: 'm1', timestamp: 110 },
        { type: 'REASONING_MESSAGE_CHUNK', messageId: 'm1', delta: 'let me think', timestamp: 111 },
        { type: 'REASONING_END', messageId: 'm1', timestamp: 112 },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', timestamp: 120 },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'the answer', timestamp: 121 },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1', timestamp: 122 },
        { type: 'USAGE', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, timestamp: 130 },
        { type: 'RUN_FINISHED', runId: 'r', timestamp: 131 },
      ] },
    ];
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: msgs }),
    }));
    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    const parts = (responses[0]['gen_ai.output.messages'] as any)[0].parts;
    expect(parts).toEqual([
      { type: 'reasoning', content: 'let me think' },
      { type: 'text', content: 'the answer' },
    ]);
  });

  it('skips PERMISSION and metadata-only auxiliary messages (no fragmentation)', async () => {
    const msgs = [
      { id: 'u', conversationId: 'sess-1', role: 'user' as const, content: 'load?', events: null, createdAt: 1, timestamp: 1, turnIndex: 0, isComplete: 1 },
      { id: 'a', conversationId: 'sess-1', role: 'assistant' as const, content: null, isComplete: 1, createdAt: 100, timestamp: 100, turnIndex: 1, events: [
        { type: 'RUN_STARTED', runId: 'r', timestamp: 100 },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', timestamp: 105 },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'running', timestamp: 106 },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1', timestamp: 107 },
        { type: 'ACTIVITY_SNAPSHOT', activityType: 'TERMINAL', timestamp: 110, content: { command: 'uptime', output: 'ok', exit_code: 0, start_time: 110, finish_time: 120 } },
        { type: 'USAGE', prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, timestamp: 130 },
        { type: 'RUN_FINISHED', runId: 'r', timestamp: 131 },
      ] },
      // Auxiliary HITL permission prompt: complete, but must not become a tool/turn.
      { id: 'p', conversationId: 'sess-1', role: 'assistant' as const, content: null, isComplete: 1, createdAt: 140, timestamp: 140, turnIndex: 2, events: [
        { type: 'ACTIVITY_SNAPSHOT', activityType: 'PERMISSION', timestamp: 140, content: { toolCallId: 'x', outcome: 'approved', start_time: 140, finish_time: 141 } },
      ] },
      // Invisible metadata-only message: must emit nothing.
      { id: 's', conversationId: 'sess-1', role: 'assistant' as const, content: null, isComplete: 1, invisible: 1, createdAt: 150, timestamp: 150, turnIndex: 3, events: [
        { type: 'CUSTOM', name: 'session_context_stats', timestamp: 150 },
      ] },
    ];
    mockExecFile.mockImplementation(makeExecFileImpl({
      list_tasks: JSON.stringify({ hasMore: false, items: [SAMPLE_TASK] }),
      get_spark_agui_messages: JSON.stringify({ messages: msgs }),
    }));
    createInput();
    seedSeenCounts();
    const entries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => entries.push(...e));
    await input.start();
    await input.stop();

    // Single trace (no fragmentation from the auxiliary messages).
    expect(new Set(entries.map(e => e['trace_id'])).size).toBe(1);
    // No PERMISSION tool emitted.
    expect(entries.some(e => e['gen_ai.tool.name'] === 'permission')).toBe(false);
    // Only the real terminal tool.
    const tools = entries.filter(e => e['event.name'] === 'tool.call');
    expect(tools.map(t => t['gen_ai.tool.name'])).toEqual(['terminal']);
    // STEP == LLM (no spurious empty llm pairs from aux messages).
    const stepIds = new Set(entries.filter(e => e['gen_ai.step.id']).map(e => e['gen_ai.step.id']));
    const llmReqs = entries.filter(e => e['event.name'] === 'llm.request');
    expect(stepIds.size).toBe(llmReqs.length);
    // Records are globally time-ascending.
    const times = entries.map(e => BigInt(String(e['time_unix_nano'])));
    for (let i = 1; i < times.length; i++) expect(times[i] >= times[i - 1]).toBe(true);
  });
});
