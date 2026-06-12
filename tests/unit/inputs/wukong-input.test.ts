import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as childProcess from 'node:child_process';
import * as os from 'node:os';
import { ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { WukongInput } from '../../../src/inputs/wukong/wukong-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

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

  it('maps user message to other event (user-hook approach)', async () => {
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

    const userEntry = entries.find(e => e['event.name'] === 'other');
    expect(userEntry).toBeDefined();
    expect(userEntry!['gen_ai.agent.type']).toBe(ClientType.Wukong);
    expect(userEntry!['gen_ai.session.id']).toBe('sess-1');
    expect(userEntry!['gen_ai.request.model']).toBe('dingtalk_deap/dingtalk-standard');
    expect(userEntry!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Hello wukong' }] },
    ]);
    expect(userEntry!['host.name']).toBe(os.hostname());
    expect(userEntry!['service.name']).toBe('wukong');
    expect(userEntry!['gen_ai.agent.id']).toBe('task-1');
    expect(userEntry!['gen_ai.agent.name']).toBe('Test task');
    expect(userEntry!['gen_ai.provider.name']).toBe('dingtalk_deap');
    expect(userEntry!['gen_ai.turn.id']).toBe('sess-1:t1');
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
    expect(respEntry!['gen_ai.response.id']).toBe('run-1');
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
    expect(respEntry!['gen_ai.agent.name']).toBe('Test task');
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

    expect(entries).toHaveLength(2);
    expect(entries[0]!['event.name']).toBe('other');
    expect(entries[0]!['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Follow up question' }] },
    ]);
    expect(entries[1]!['event.name']).toBe('llm.response');
    expect(entries[1]!['gen_ai.usage.input_tokens']).toBe(200);

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

    expect(entries).toHaveLength(1);
    expect(entries[0]!['gen_ai.session.id']).toBe('sess-2');

    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-2']).toBe(1);
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
    expect(sessionIds.has('sess-2')).toBe(true);
  });

  it('prunes seenCounts for sessions no longer in task list', async () => {
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
    expect(seenCounts['sess-1']).toBe(2);
    expect(seenCounts['stale-sess']).toBeUndefined();
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

    const reqEntry = entries.find(e => e['event.name'] === 'other');
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

    const respEntry = entries.find(e => e['event.name'] === 'llm.response');
    expect(respEntry!['gen_ai.step.id']).toBe('sess-1:t1:s2');
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

    // Only the user message (msg-1) should be processed, incomplete assistant skipped
    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('other');

    // seenCounts should advance only to the user message (index 0 + 1 = 1)
    const state = stateStore.get('wukong');
    expect((state.extra as any).seenCounts['sess-1']).toBe(1);
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

    expect(entries1).toHaveLength(1); // only user msg
    const state1 = stateStore.get('wukong');
    expect((state1.extra as any).seenCounts['sess-1']).toBe(1);

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
});
