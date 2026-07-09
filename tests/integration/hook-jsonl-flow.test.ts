import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ClientType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { QoderCliInput } from '../../src/inputs/qoder-cli/qoder-cli-input.js';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function runCursorHook(input: string, env: Record<string, string>) {
  return spawnSync('bash', [path.resolve(process.cwd(), 'assets/hooks/cursor-loongsuite-pilot-hook.sh')], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

function runQoderHook(scriptPath: string, input: string, env: Record<string, string>) {
  return spawnSync('bash', [scriptPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  });
}

describe('Hook JSONL integration flow', () => {
  let tmpDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-integ-'));
    stateStore = new StateStore(path.join(tmpDir, 'state.json'));
    await stateStore.load();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should perform complete read → normalize → offset persist flow', async () => {
    const logDir = path.join(tmpDir, 'logs');
    await fs.mkdir(logDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-${today}.jsonl`);

    const records = [
      {
        event_type: 'PostToolUse',
        tool_name: 'create_file',
        tool_input: { file_path: '/proj/new.ts', content: 'export const x = 1;' },
        loongsuite_pilot_pre_file_exists: false,
        session_id: 'integ-sess-1',
        user_id: 'integ-user',
        timestamp: Date.now(),
      },
      {
        event_type: 'PostToolUse',
        tool_name: 'write_to_file',
        tool_input: { file_path: '/proj/existing.ts', content: 'updated' },
        loongsuite_pilot_pre_file_exists: true,
        session_id: 'integ-sess-1',
        user_id: 'integ-user',
        timestamp: Date.now(),
      },
    ];
    await fs.writeFile(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // Verify entries are normalized correctly
    expect(allEntries).toHaveLength(2);
    expect(allEntries[0]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.session.id': 'integ-sess-1',
      'gen_ai.tool.name': 'create_file',
    });
    expect(allEntries[0]?.['agent.loongsuite_pilot_pre_file_exists']).toBe(false);
    expect(allEntries[0]?.['agent.file_path']).toBe('/proj/new.ts');
    expect(allEntries[1]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.session.id': 'integ-sess-1',
      'gen_ai.tool.name': 'write_to_file',
    });
    expect(allEntries[1]?.['agent.loongsuite_pilot_pre_file_exists']).toBe(true);
    expect(allEntries[1]?.['agent.file_path']).toBe('/proj/existing.ts');

    // Verify all entries pass schema validation
    for (const entry of allEntries) {
      const result = AgentActivityEntrySchema.safeParse(entry);
      expect(result.success, `Entry should pass schema: ${JSON.stringify(entry)}`).toBe(true);
    }

    // Verify offset was persisted
    await stateStore.save();
    const offset = stateStore.getOffset('qoder-cli-hook');
    expect(offset).toBeGreaterThan(0);

    // Verify re-reading with same state yields no new entries
    const input2 = new QoderCliInput({
      stateStore: stateStore as any,
      logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });

    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();
    expect(newEntries).toHaveLength(0);
  });

  it('should handle incremental appends correctly', async () => {
    const logDir = path.join(tmpDir, 'logs2');
    await fs.mkdir(logDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-${today}.jsonl`);

    // First batch
    await fs.writeFile(logFile, JSON.stringify({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: '/batch1.ts', content: 'a' },
      session_id: 's1',
      timestamp: Date.now(),
    }) + '\n');

    const input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir: logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    expect(allEntries).toHaveLength(1);

    // Append second batch
    await fs.appendFile(logFile, JSON.stringify({
      event_type: 'PostToolUse',
      tool_name: 'write_to_file',
      tool_input: { file_path: '/batch2.ts', content: 'b' },
      session_id: 's2',
      timestamp: Date.now(),
    }) + '\n');

    // Manually trigger second collect by calling start on a new instance with same state
    await input.stop();
    await stateStore.save();

    const input2 = new QoderCliInput({
      stateStore: stateStore as any,
      logDir: logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });

    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));

    await input2.start();
    await input2.stop();

    expect(newEntries).toHaveLength(1);
    expect(newEntries[0]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.tool.name': 'write_to_file',
    });
    expect(newEntries[0]?.['agent.file_path']).toBe('/batch2.ts');
  });

  it('should consume transcript rows forwarded by qoder-loongsuite-pilot-hook without agent argument', async () => {
    const hookDir = path.join(tmpDir, 'hooks');
    const dataDir = path.join(tmpDir, 'data');
    await fs.mkdir(hookDir, { recursive: true });
    const hookScript = path.join(hookDir, 'qoder-loongsuite-pilot-hook.sh');
    await fs.copyFile(path.resolve(process.cwd(), 'assets/hooks/qoder-loongsuite-pilot-hook.sh'), hookScript);
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/qoder-hook-processor.mjs'),
      path.join(hookDir, 'qoder-hook-processor.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/agent-event-normalizer.mjs'),
      path.join(hookDir, 'agent-event-normalizer.mjs'),
    );
    const sharedDir = path.join(hookDir, 'shared');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/hook-processor-base.mjs'),
      path.join(sharedDir, 'hook-processor-base.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/qoder-db-utils.mjs'),
      path.join(sharedDir, 'qoder-db-utils.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/resource-context.mjs'),
      path.join(sharedDir, 'resource-context.mjs'),
    );
    await fs.chmod(hookScript, 0o755);

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'session_meta',
        uuid: 'meta-ignored',
        sessionId: 'sess-hook',
        cwd: '/tmp/project',
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'user-1',
        timestamp: '2026-05-01T18:15:22.122Z',
        message: { role: 'user', content: 'hello from qoder hook' },
        promptId: 'turn-1',
        sessionId: 'sess-hook',
        entrypoint: 'cli',
        cwd: '/tmp/project',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'asst-1',
        timestamp: '2026-05-01T18:15:27.000Z',
        sessionId: 'sess-hook',
        cwd: '/tmp/project',
        message: { role: 'assistant', id: 'msg-1', content: [{ type: 'text', text: 'hello back' }] },
      }),
      JSON.stringify({
        type: 'last-prompt',
        sessionId: 'sess-hook',
        lastPrompt: 'hello from qoder hook',
      }),
    ].join('\n') + '\n');

    const result = runQoderHook(hookScript, JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      session_id: 'sess-hook',
    }), {
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      AGENTTEAMS_WORKER_NAME: 'qoder-worker',
      AGENTTEAMS_INSTANCE_ID: 'lw-qoder',
      AGENTTEAMS_TOKEN: 'should-not-leak',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const logDir = path.join(dataDir, 'logs', 'qoder', 'history');
    const historyFile = path.join(logDir, `qoder-${getTodayDateString()}.jsonl`);
    const historyLines = (await fs.readFile(historyFile, 'utf-8')).trim().split('\n');
    expect(historyLines.length).toBeGreaterThanOrEqual(1);
    const historyRecord = JSON.parse(historyLines[0]!);
    expect(historyRecord.type).toBeUndefined();
    expect(historyRecord.uuid).toBeUndefined();
    expect(historyRecord.sessionId).toBeUndefined();
    expect(historyRecord['event.name']).toBe('other');
    expect(historyRecord['gen_ai.agent.name']).toBe('qoder-worker');
    expect(historyRecord.resourceAttributes).toEqual({
      'agentteams.worker.name': 'qoder-worker',
      'agentteams.instance.id': 'lw-qoder',
    });
    expect(historyRecord['agentteams.worker.name']).toBeUndefined();
    expect(historyRecord['agentteams.instance.id']).toBeUndefined();
    expect(historyRecord['agentteams.token']).toBeUndefined();

    const input = new QoderCliInput({
      stateStore: stateStore as any,
      logDir,
      logPrefix: 'qoder',
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));
    await input.start();
    await input.stop();

    // New processor produces: user-hook (other) + step llm.request + llm.response
    expect(allEntries.length).toBeGreaterThanOrEqual(1);
    const userHook = allEntries.find(e => e['event.name'] === 'other' && !e['gen_ai.step.id']);
    expect(userHook).toBeDefined();
    expect(userHook).toMatchObject({
      'event.name': 'other',
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.session.id': 'sess-hook',
      'gen_ai.agent.name': 'qoder-worker',
      resourceAttributes: {
        'agentteams.worker.name': 'qoder-worker',
        'agentteams.instance.id': 'lw-qoder',
      },
    });
  });

  it('keeps delayed IDE assistant text and tool_use in the same LLM step', async () => {
    const hookDir = path.join(tmpDir, 'hooks-delayed-ide');
    const dataDir = path.join(tmpDir, 'data-delayed-ide');
    await fs.mkdir(hookDir, { recursive: true });
    const hookScript = path.join(hookDir, 'qoder-loongsuite-pilot-hook.sh');
    await fs.copyFile(path.resolve(process.cwd(), 'assets/hooks/qoder-loongsuite-pilot-hook.sh'), hookScript);
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/qoder-hook-processor.mjs'),
      path.join(hookDir, 'qoder-hook-processor.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/agent-event-normalizer.mjs'),
      path.join(hookDir, 'agent-event-normalizer.mjs'),
    );
    const sharedDir = path.join(hookDir, 'shared');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/hook-processor-base.mjs'),
      path.join(sharedDir, 'hook-processor-base.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/qoder-db-utils.mjs'),
      path.join(sharedDir, 'qoder-db-utils.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/resource-context.mjs'),
      path.join(sharedDir, 'resource-context.mjs'),
    );
    await fs.chmod(hookScript, 0o755);

    const transcriptPath = path.join(tmpDir, 'delayed-ide-transcript.jsonl');
    await fs.writeFile(transcriptPath, [
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:53:21.156Z',
        data: { hookEvent: 'UserPromptSubmit', hookName: 'submit' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-18T09:53:21.156Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'user', content: [{ type: 'text', text: 'create and test a solution' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T09:54:08.143Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I will create the file.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T09:54:08.144Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_write', name: 'Write', input: { file_path: '/tmp/a.py' } }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:54:08.495Z',
        data: { hookEvent: 'PreToolUse', hookName: 'Write' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-18T09:54:10.906Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_write', content: 'created' }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:54:11.356Z',
        data: { hookEvent: 'PostToolUse', hookName: 'Write' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T09:54:20.952Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Let me run the tests.' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T09:54:29.523Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_bash', name: 'Bash', input: { command: 'python /tmp/a.py' } }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:54:29.937Z',
        data: { hookEvent: 'PreToolUse', hookName: 'Bash' },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-18T09:54:30.078Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bash', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:54:30.594Z',
        data: { hookEvent: 'PostToolUse', hookName: 'Bash' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T09:54:40.148Z',
        sessionId: 'sess-delayed-ide',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T09:54:40.696Z',
        data: { hookEvent: 'Stop', hookName: 'Stop' },
      }),
      JSON.stringify({
        type: 'last-prompt',
        sessionId: 'sess-delayed-ide',
        lastPrompt: 'create and test a solution',
      }),
    ].join('\n') + '\n');

    const result = runQoderHook(hookScript, JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      session_id: 'sess-delayed-ide',
    }), {
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
    });
    expect(result.status).toBe(0);

    const historyFile = path.join(dataDir, 'logs', 'qoder', 'history', `qoder-${getTodayDateString()}.jsonl`);
    const records = (await fs.readFile(historyFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
    const llmRequests = records.filter(r => r['event.name'] === 'llm.request');
    const llmResponses = records.filter(r => r['event.name'] === 'llm.response');
    const toolCalls = records.filter(r => r['event.name'] === 'tool.call');

    expect(llmRequests).toHaveLength(3);
    expect(llmResponses).toHaveLength(3);
    expect(new Set(llmRequests.map(r => r['gen_ai.step.id']))).toEqual(new Set(llmResponses.map(r => r['gen_ai.step.id'])));
    expect(toolCalls.map(r => [r['gen_ai.step.id'], r['gen_ai.tool.name']])).toEqual([
      [llmRequests[0]['gen_ai.step.id'], 'Write'],
      [llmRequests[1]['gen_ai.step.id'], 'Bash'],
    ]);
  });

  it('QoderTraceInput cold start: only reports last turn when state is empty', async () => {
    const logDir = path.join(tmpDir, 'logs-cold');
    await fs.mkdir(logDir, { recursive: true });

    const today = getTodayDateString();
    const logFile = path.join(logDir, `qoder-${today}.jsonl`);

    // Write 3 turns (historical data present before pilot was deployed)
    const lines = [
      // Turn 1 (old)
      JSON.stringify({
        'event.name': 'other',
        'event.id': 'e-1',
        'gen_ai.turn.id': 'turn-old-1',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'old prompt 1' }] }],
        time_unix_nano: '1780000000000000000',
        observed_time_unix_nano: '1780000000000000000',
      }),
      JSON.stringify({
        'event.name': 'llm.response',
        'event.id': 'e-2',
        'gen_ai.turn.id': 'turn-old-1',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.step.id': 'turn-old-1:s1',
        time_unix_nano: '1780000001000000000',
        observed_time_unix_nano: '1780000001000000000',
      }),
      // Turn 2 (old)
      JSON.stringify({
        'event.name': 'other',
        'event.id': 'e-3',
        'gen_ai.turn.id': 'turn-old-2',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'old prompt 2' }] }],
        time_unix_nano: '1780000010000000000',
        observed_time_unix_nano: '1780000010000000000',
      }),
      JSON.stringify({
        'event.name': 'llm.response',
        'event.id': 'e-4',
        'gen_ai.turn.id': 'turn-old-2',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.step.id': 'turn-old-2:s1',
        time_unix_nano: '1780000011000000000',
        observed_time_unix_nano: '1780000011000000000',
      }),
      // Turn 3 (latest — should be reported)
      JSON.stringify({
        'event.name': 'other',
        'event.id': 'e-5',
        'gen_ai.turn.id': 'turn-latest',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'latest prompt' }] }],
        time_unix_nano: '1780000020000000000',
        observed_time_unix_nano: '1780000020000000000',
      }),
      JSON.stringify({
        'event.name': 'llm.response',
        'event.id': 'e-6',
        'gen_ai.turn.id': 'turn-latest',
        'gen_ai.session.id': 'sess-1',
        'gen_ai.agent.type': 'qoder-cli',
        'gen_ai.step.id': 'turn-latest:s1',
        time_unix_nano: '1780000021000000000',
        observed_time_unix_nano: '1780000021000000000',
      }),
    ];
    await fs.writeFile(logFile, lines.join('\n') + '\n');

    // Fresh state store (simulates redeployment — no prior offset)
    const freshStore = new StateStore(path.join(tmpDir, 'cold-state.json'));
    await freshStore.load();

    const input = new QoderTraceInput({
      stateStore: freshStore as any,
      logDir,
      pollIntervalMs: 60_000,
    });

    const allEntries: AgentActivityEntry[] = [];
    input.on('entries', (e: AgentActivityEntry[]) => allEntries.push(...e));

    await input.start();
    await input.stop();

    // Only the last turn should be reported
    expect(allEntries.length).toBe(2);
    expect(allEntries.every(e => e['gen_ai.turn.id'] === 'turn-latest')).toBe(true);

    // Offset should be at end of file
    await freshStore.save();
    const state = freshStore.get('qoder-trace');
    expect(state.lastOffset).toBe((await fs.stat(logFile)).size);
    expect(state.lastFile).toBe(`qoder-${today}.jsonl`);

    // Subsequent run should not re-emit anything
    const input2 = new QoderTraceInput({
      stateStore: freshStore as any,
      logDir,
      pollIntervalMs: 60_000,
    });
    const newEntries: AgentActivityEntry[] = [];
    input2.on('entries', (e: AgentActivityEntry[]) => newEntries.push(...e));
    await input2.start();
    await input2.stop();
    expect(newEntries).toHaveLength(0);
  });

  it('should split multi-turn transcript into separate turns with correct user inputs', async () => {
    const hookDir = path.join(tmpDir, 'hooks-multi-turn');
    const dataDir = path.join(tmpDir, 'data-multi-turn');
    await fs.mkdir(hookDir, { recursive: true });
    const hookScript = path.join(hookDir, 'qoder-loongsuite-pilot-hook.sh');
    await fs.copyFile(path.resolve(process.cwd(), 'assets/hooks/qoder-loongsuite-pilot-hook.sh'), hookScript);
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/qoder-hook-processor.mjs'),
      path.join(hookDir, 'qoder-hook-processor.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/agent-event-normalizer.mjs'),
      path.join(hookDir, 'agent-event-normalizer.mjs'),
    );
    const sharedDir = path.join(hookDir, 'shared');
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/hook-processor-base.mjs'),
      path.join(sharedDir, 'hook-processor-base.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/qoder-db-utils.mjs'),
      path.join(sharedDir, 'qoder-db-utils.mjs'),
    );
    await fs.copyFile(
      path.resolve(process.cwd(), 'assets/hooks/shared/resource-context.mjs'),
      path.join(sharedDir, 'resource-context.mjs'),
    );
    await fs.chmod(hookScript, 0o755);

    const transcriptPath = path.join(tmpDir, 'multi-turn-transcript.jsonl');
    await fs.writeFile(transcriptPath, [
      // Turn 1: hello
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-18T08:00:00.000Z',
        sessionId: 'sess-multi',
        message: { role: 'user', content: 'hello' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T08:00:01.000Z',
        sessionId: 'sess-multi',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there.' }] },
      }),
      // Turn 2: leetcode
      JSON.stringify({
        type: 'user',
        timestamp: '2026-06-18T08:01:00.000Z',
        sessionId: 'sess-multi',
        message: { role: 'user', content: '完成力扣第143题' },
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-18T08:01:05.000Z',
        sessionId: 'sess-multi',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I\'ll solve leetcode 143.' }] },
      }),
      JSON.stringify({
        type: 'progress',
        timestamp: '2026-06-18T08:01:10.000Z',
        data: { hookEvent: 'Stop', hookName: 'Stop' },
      }),
      JSON.stringify({
        type: 'last-prompt',
        sessionId: 'sess-multi',
        lastPrompt: '完成力扣第143题',
      }),
    ].join('\n') + '\n');

    const result = runQoderHook(hookScript, JSON.stringify({
      hook_event_name: 'Stop',
      transcript_path: transcriptPath,
      session_id: 'sess-multi',
    }), {
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
    });
    expect(result.status).toBe(0);

    const historyFile = path.join(dataDir, 'logs', 'qoder', 'history', `qoder-${getTodayDateString()}.jsonl`);
    const records = (await fs.readFile(historyFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
    const userHookEvents = records.filter(r => r['event.name'] === 'other');

    // Should have two distinct turns
    expect(userHookEvents).toHaveLength(2);
    const turnIds = new Set(userHookEvents.map(r => r['gen_ai.turn.id']));
    expect(turnIds.size).toBe(2);

    // Find the last turn's user input
    const sortedByTs = userHookEvents.sort((a, b) => Number(a.time_unix_nano) - Number(b.time_unix_nano));
    expect(sortedByTs[0]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
    expect(sortedByTs[1]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '完成力扣第143题' }] },
    ]);
  });
});

describe('Cursor hook script integration flow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-hook-integ-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should keep fail-open behavior for invalid json payload', async () => {
    const result = runCursorHook('not-json', { LOONGSUITE_PILOT_DATA_DIR: tmpDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const logFile = path.join(tmpDir, 'logs', 'cursor', 'history', `cursor-${getTodayDateString()}.jsonl`);
    await expect(fs.access(logFile)).rejects.toBeTruthy();

    const errorFile = path.join(tmpDir, 'logs', 'cursor', 'errors', `cursor-error-${getTodayDateString()}.jsonl`);
    const errorLines = (await fs.readFile(errorFile, 'utf-8')).trim().split('\n');
    expect(errorLines).toHaveLength(1);
    const errorRecord = JSON.parse(errorLines[0]!);
    expect(errorRecord.stage).toBe('parse');
    expect(errorRecord['error.type']).toBe('invalid_json');
    expect(errorRecord.input_bytes).toBeGreaterThan(0);
    expect(errorRecord.input_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should keep fail-open behavior when log path is not writable', async () => {
    const badDataDir = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(badDataDir, 'x');

    const result = runCursorHook(JSON.stringify({ hook_event_name: 'postToolUse', text: 'hello' }), {
      LOONGSUITE_PILOT_DATA_DIR: badDataDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });
});
