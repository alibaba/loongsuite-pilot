import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexAbortedTurnInput } from '../../../../src/inputs/codex-aborted-turn/codex-aborted-turn-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { CodexLogInput } from '../../../../src/inputs/codex-log/codex-log-input.js';
import { getTodayDateString } from '../../../../src/utils/fs-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'aborted-turn.jsonl');
const INTERLEAVED_WEB_SEARCH_FIXTURE = path.join(__dirname, 'fixtures', 'interleaved-web-search.jsonl');
const MULTI_WAVE_FIXTURE = path.join(__dirname, 'fixtures', 'multi-wave-aborted-turn.jsonl');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for entries');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function createInput(root: string, stateStore: StateStore): Promise<{
  input: CodexAbortedTurnInput;
  entries: AgentActivityEntry[];
  sessionDir: string;
}> {
  const sessionDir = path.join(root, 'sessions');
  const input = new CodexAbortedTurnInput({
    stateStore,
    sessionDir,
    hookStateDir: path.join(root, 'hook-state'),
    diagnosticDir: path.join(root, 'diagnostics'),
    pollIntervalMs: 10,
  });
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  await input.start();
  return { input, entries, sessionDir };
}

async function writeTranscript(sessionDir: string, content: string, name = 'rollout-session-aborted.jsonl'): Promise<string> {
  const transcript = path.join(sessionDir, '2026', '06', '22', name);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, content, 'utf8');
  return transcript;
}

describe('CodexAbortedTurnInput', () => {
  it('keeps turn_context fields when task_started follows the same turn context', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-context-first-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const lines = fixture.trimEnd().split('\n');
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    await writeTranscript(sessionDir, lines.join('\n') + '\n', 'rollout-context-first.jsonl');
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const response = entries.find(entry => entry['event.name'] === 'llm.response');
    expect(response).toMatchObject({
      'gen_ai.response.model': 'gpt-5.4-mini',
      'agent.codex.cwd': '/tmp/project',
    });
  });

  it('writes a diagnostic instead of silently losing an unrecoverable aborted turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-recovery-failure-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const diagnosticDir = path.join(root, 'diagnostics');
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const malformedAbort = fixture.replace(
      '"timestamp":"2026-06-22T08:57:54.000Z"',
      '"timestamp":"not-a-timestamp"',
    );
    await writeTranscript(sessionDir, malformedAbort, 'rollout-malformed-abort.jsonl');
    await waitFor(async () => {
      try {
        return (await fs.readdir(diagnosticDir)).some(file => file.startsWith('codex-aborted-turn-recovery-failed-'));
      } catch {
        return false;
      }
    });
    await input.stop();

    const files = await fs.readdir(diagnosticDir);
    const file = files.find(name => name.startsWith('codex-aborted-turn-recovery-failed-'))!;
    const diagnostic = JSON.parse(await fs.readFile(path.join(diagnosticDir, file), 'utf8')) as Record<string, unknown>;
    expect(entries).toEqual([]);
    expect(diagnostic).toMatchObject({
      type: 'codex_aborted_turn_recovery_failed',
      transcript_turn_id: 'turn-aborted',
      reason: 'missing_or_invalid_abort_timestamp',
    });
  });

  it('reads a preceding session_meta without allocating the full transcript tail', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-meta-buffer-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const sessionDir = path.join(root, 'sessions');
    const transcript = await writeTranscript(sessionDir, [
      JSON.stringify({ timestamp: '2026-06-23T06:00:00.000Z', type: 'session_meta', payload: { id: 'session-large', model_provider: 'openai' } }),
      JSON.stringify({ timestamp: '2026-06-23T06:00:00.001Z', type: 'event_msg', payload: { type: 'ignored', message: 'x'.repeat(128 * 1024) } }),
    ].join('\n') + '\n', 'rollout-large-history.jsonl');
    const input = new CodexAbortedTurnInput({
      stateStore,
      sessionDir,
      hookStateDir: path.join(root, 'hook-state'),
      diagnosticDir: path.join(root, 'diagnostics'),
      pollIntervalMs: 10,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    await input.start();

    const alloc = vi.spyOn(Buffer, 'alloc');
    await fs.appendFile(transcript, [
      JSON.stringify({ timestamp: '2026-06-23T06:00:01.000Z', type: 'turn_context', payload: { turn_id: 'turn-large', model: 'gpt-5.4-mini' } }),
      JSON.stringify({ timestamp: '2026-06-23T06:00:01.010Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-large' } }),
      JSON.stringify({ timestamp: '2026-06-23T06:00:02.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-large', reason: 'interrupted' } }),
    ].join('\n') + '\n', 'utf8');
    await waitFor(() => entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('cancelled')));
    await input.stop();

    expect(Math.max(...alloc.mock.calls.map(([size]) => Number(size)))).toBeLessThanOrEqual(64 * 1024);
    alloc.mockRestore();
  });

  it('assigns messages after a completed web search to the cancelled follow-up step', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-interleaved-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    await fs.copyFile(INTERLEAVED_WEB_SEARCH_FIXTURE, await writeTranscript(sessionDir, ''));
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const firstResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.step.id']?.endsWith(':s1'),
    );
    expect(firstResponse?.['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [
        { type: 'reasoning', content: 'I will research the problem first.' },
        { type: 'tool_call', id: 'web-search-1', name: 'web_search', arguments: { type: 'search', query: 'problem' } },
      ],
      finish_reason: 'tool_call',
    }]);

    const cancelledResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    );
    expect(cancelledResponse?.['gen_ai.step.id']).toMatch(/:s2$/);
    expect(cancelledResponse?.['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'reasoning', content: 'The search confirms the problem name.' }],
      finish_reason: 'cancelled',
    }]);
  });

  it('creates a distinct step for each completed tool-call wave', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-multi-wave-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    await fs.copyFile(MULTI_WAVE_FIXTURE, await writeTranscript(sessionDir, ''));
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    expect(responses.map(entry => ({
      step: entry['gen_ai.step.id']?.slice(-2),
      finish: entry['gen_ai.response.finish_reasons'],
      messages: entry['gen_ai.output.messages'],
    }))).toEqual([
      {
        step: 's1',
        finish: ['tool_call'],
        messages: [{
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'I will inspect the files first.' },
            { type: 'tool_call', id: 'call-first', name: 'exec_command', arguments: { cmd: 'pwd' } },
          ],
          finish_reason: 'tool_call',
        }],
      },
      {
        step: 's2',
        finish: ['tool_call'],
        messages: [{
          role: 'assistant',
          parts: [
            { type: 'reasoning', content: 'Now I will inspect the project files.' },
            { type: 'tool_call', id: 'call-second', name: 'exec_command', arguments: { cmd: 'ls' } },
          ],
          finish_reason: 'tool_call',
        }],
      },
      {
        step: 's3',
        finish: ['cancelled'],
        messages: [{
          role: 'assistant',
          parts: [{ type: 'reasoning', content: 'I found the project structure.' }],
          finish_reason: 'cancelled',
        }],
      },
    ]);
  });

  it('does not emit recovery entries for a normally completed transcript', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-normal-transcript-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const normalTranscript = [
      JSON.stringify({ timestamp: '2026-06-23T04:00:00.000Z', type: 'session_meta', payload: { id: 'session-normal', model_provider: 'openai' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-normal' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:01.010Z', type: 'turn_context', payload: { turn_id: 'turn-normal', model: 'gpt-5.4-mini' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'The task is complete.' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-normal' } }),
    ].join('\n') + '\n';
    await writeTranscript(sessionDir, normalTranscript, 'rollout-normal.jsonl');
    await new Promise(resolve => setTimeout(resolve, 50));
    await input.stop();

    expect(entries).toEqual([]);
  });

  it('writes one diagnostic when a completed turn has no Hook state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-hook-gap-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const sessionDir = path.join(root, 'sessions');
    const diagnosticDir = path.join(root, 'diagnostics');
    const input = new CodexAbortedTurnInput({
      stateStore,
      sessionDir,
      hookStateDir: path.join(root, 'missing-hook-state'),
      diagnosticDir,
      hookGapGraceMs: 0,
      pollIntervalMs: 10,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));
    await input.start();

    await writeTranscript(sessionDir, [
      JSON.stringify({ timestamp: '2026-06-23T04:00:00.000Z', type: 'session_meta', payload: { id: 'session-hook-gap', model_provider: 'openai' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-hook-gap' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:01.010Z', type: 'turn_context', payload: { turn_id: 'turn-hook-gap', model: 'gpt-5.4-mini' } }),
      JSON.stringify({ timestamp: '2026-06-23T04:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-hook-gap' } }),
    ].join('\n') + '\n', 'rollout-hook-gap.jsonl');

    await waitFor(async () => {
      try {
        return (await fs.readdir(diagnosticDir)).some(file => file.startsWith('codex-hook-gap-'));
      } catch {
        return false;
      }
    });
    await input.stop();

    const files = await fs.readdir(diagnosticDir);
    const diagnostic = JSON.parse(await fs.readFile(path.join(diagnosticDir, files[0]!), 'utf8')) as Record<string, unknown>;
    expect(entries).toEqual([]);
    expect(diagnostic).toMatchObject({
      type: 'codex_hook_missing',
      session_id: 'session-hook-gap',
      transcript_turn_id: 'turn-hook-gap',
    });
  });

  it('does not interfere with normal Codex hook collection when sharing a state store', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-normal-isolation-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const sessionDir = path.join(root, 'sessions');
    const hookLogDir = path.join(root, 'hook-logs');
    const hookStateDir = path.join(root, 'hook-state');
    const diagnosticDir = path.join(root, 'diagnostics');
    await fs.mkdir(hookStateDir, { recursive: true });
    await fs.writeFile(path.join(hookStateDir, 'session-normal-shared.json'), '{}', 'utf8');
    const recoveryInput = new CodexAbortedTurnInput({
      stateStore,
      sessionDir,
      hookStateDir,
      diagnosticDir,
      pollIntervalMs: 10,
    });
    const normalInput = new CodexLogInput({ stateStore, logDir: hookLogDir, pollIntervalMs: 10 });
    const recoveryEntries: AgentActivityEntry[] = [];
    const normalEntries: AgentActivityEntry[] = [];
    recoveryInput.on('entries', batch => recoveryEntries.push(...batch));
    normalInput.on('entries', batch => normalEntries.push(...batch));
    await recoveryInput.start();
    await normalInput.start();

    await writeTranscript(sessionDir, [
      JSON.stringify({ timestamp: '2026-06-23T05:00:00.000Z', type: 'session_meta', payload: { id: 'session-normal-shared', model_provider: 'openai' } }),
      JSON.stringify({ timestamp: '2026-06-23T05:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-normal-shared' } }),
      JSON.stringify({ timestamp: '2026-06-23T05:00:01.010Z', type: 'turn_context', payload: { turn_id: 'turn-normal-shared', model: 'gpt-5.4-mini' } }),
      JSON.stringify({ timestamp: '2026-06-23T05:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-normal-shared' } }),
    ].join('\n') + '\n', 'rollout-normal-shared.jsonl');
    await fs.writeFile(path.join(hookLogDir, `codex-${getTodayDateString()}.jsonl`), JSON.stringify({
      time_unix_nano: '1782190800000000000',
      'event.id': 'normal-hook-event',
      'event.name': 'other',
      'gen_ai.session.id': 'session-normal-shared',
      'gen_ai.turn.id': 'session-normal-shared:t1',
      'gen_ai.agent.type': 'codex',
      'gen_ai.provider.name': 'openai',
    }) + '\n', 'utf8');

    await waitFor(() => normalEntries.length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    await recoveryInput.stop();
    await normalInput.stop();

    expect(normalEntries).toHaveLength(1);
    expect(normalEntries[0]?.['event.id']).toBe('normal-hook-event');
    expect(recoveryEntries).toEqual([]);
    expect(stateStore.get('codex-log').lastOffset).toBeGreaterThan(0);
    await expect(fs.access(diagnosticDir)).rejects.toThrow();
  });

  it('exports a transcript-backed cancelled turn with completed and pending tools', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-turn-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();

    const { input, entries } = await createInput(root, stateStore);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.copyFile(FIXTURE, await writeTranscript(sessionDir, ''));
    await waitFor(() => entries.some(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const finalResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    );
    expect(finalResponse).toMatchObject({
      'gen_ai.agent.type': 'codex',
      'gen_ai.response.finish_reasons': ['cancelled'],
      'agent.codex.turn_status': 'interrupted',
    });
    expect(finalResponse?.['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(finalResponse?.['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(finalResponse?.['error.type']).toBeUndefined();
    expect(finalResponse?.['gen_ai.output.messages']).toBeUndefined();

    const firstToolResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.step.id']?.endsWith(':s1'),
    );
    expect(firstToolResponse?.['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [
        { type: 'reasoning', content: 'I will inspect the project first.' },
        {
          type: 'tool_call',
          id: 'call-bash',
          name: 'exec_command',
          arguments: { command: 'pwd', workdir: '/tmp/project' },
        },
      ],
      finish_reason: 'tool_call',
    }]);

    const secondToolResponse = entries.find(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.step.id']?.endsWith(':s2'),
    );
    expect(secondToolResponse).toMatchObject({
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 12,
      'gen_ai.usage.total_tokens': 132,
    });

    const completedTool = entries.find(entry =>
      entry['event.name'] === 'tool.result'
      && entry['gen_ai.tool.call.id'] === 'call-bash',
    );
    expect(completedTool).toMatchObject({
      'tool.result.status': 'success',
      'gen_ai.tool.call.result': { stdout: '/tmp/project' },
    });
    expect(completedTool?.['gen_ai.tool.call.duration']).toBe(1_000);

    const pendingTool = entries.find(entry =>
      entry['event.name'] === 'tool.result'
      && entry['gen_ai.tool.call.id'] === 'call-pending',
    );
    expect(pendingTool).toMatchObject({ 'tool.result.status': 'cancelled' });
    expect(pendingTool?.['gen_ai.tool.call.result']).toBeUndefined();
    expect(pendingTool?.['gen_ai.tool.call.duration']).toBeUndefined();
  });

  it('keeps a zero duration for a completed tool with matching timestamps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-zero-duration-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    await writeTranscript(sessionDir, fixture.replace(
      '"timestamp":"2026-06-22T08:57:51.000Z"',
      '"timestamp":"2026-06-22T08:57:50.000Z"',
    ), 'rollout-zero-duration.jsonl');
    await waitFor(() => entries.some(entry =>
      entry['event.name'] === 'tool.result' && entry['gen_ai.tool.call.id'] === 'call-bash',
    ));
    await input.stop();

    const toolResult = entries.find(entry =>
      entry['event.name'] === 'tool.result' && entry['gen_ai.tool.call.id'] === 'call-bash',
    );
    expect(toolResult?.['gen_ai.tool.call.duration']).toBe(0);
  });

  it('does not export transcript history that existed before the input starts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-baseline-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.copyFile(FIXTURE, await writeTranscript(sessionDir, ''));
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();

    const { input, entries } = await createInput(root, stateStore);
    await new Promise(resolve => setTimeout(resolve, 50));
    await input.stop();
    expect(entries).toEqual([]);
  });

  it('waits for a trailing newline before consuming turn_aborted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-partial-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const transcript = await writeTranscript(sessionDir, fixture.trimEnd());

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(entries).toEqual([]);
    await fs.appendFile(transcript, '\n', 'utf8');
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();
  });

  it('keeps a transcript-backed agent message when cancellation has no tool calls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-message-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const withoutTools = fixture.trimEnd().split('\n').filter(line => {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string } };
      return record.type !== 'response_item' || record.payload?.type === 'message';
    }).join('\n') + '\n';
    await writeTranscript(sessionDir, withoutTools);
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const finalResponse = entries.find(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    );
    expect(finalResponse?.['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'reasoning', content: 'I will inspect the project first.' }],
      finish_reason: 'cancelled',
    }]);
  });

  it('merges all user transcript messages into the recovered prompt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-prompt-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const environment = JSON.stringify({
      timestamp: '2026-06-22T08:57:48.025Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp/project</environment_context>' }],
      },
    });
    const lines = fixture.trimEnd().split('\n');
    lines.splice(3, 0, environment);
    await writeTranscript(sessionDir, lines.join('\n') + '\n', 'rollout-merged-prompt.jsonl');
    await waitFor(() => entries.some(entry => entry['event.name'] === 'other'));
    await input.stop();

    const promptEntry = entries.find(entry => entry['event.name'] === 'other');
    expect(promptEntry?.['gen_ai.input.messages_delta']).toEqual([{
      role: 'user',
      parts: [{
        type: 'text',
        content: '<environment_context>cwd=/tmp/project</environment_context>\n\nsolve the task',
      }],
    }]);
  });

  it('recovers an active post-baseline turn after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-restart-'));
    tempDirs.push(root);
    const sessionDir = path.join(root, 'sessions');
    const statePath = path.join(root, 'input-state.json');
    const firstStore = new StateStore(statePath);
    await firstStore.load();
    const first = await createInput(root, firstStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const lines = fixture.trimEnd().split('\n');
    const abortLine = lines.pop();
    const transcript = await writeTranscript(sessionDir, lines.join('\n') + '\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    await first.input.stop();

    const secondStore = new StateStore(statePath);
    await secondStore.load();
    const second = await createInput(root, secondStore);
    await fs.appendFile(transcript, abortLine + '\n', 'utf8');
    await waitFor(() => second.entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await second.input.stop();
  });

  it('uses the latest session_meta preceding the turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-meta-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const fixture = await fs.readFile(FIXTURE, 'utf8');
    const updatedMeta = JSON.stringify({
      timestamp: '2026-06-22T08:57:47.000Z',
      type: 'session_meta',
      payload: {
        id: 'session-aborted',
        model_provider: 'openai',
        base_instructions: { text: 'Updated system instructions' },
      },
    });
    const lines = fixture.trimEnd().split('\n');
    lines.splice(1, 0, updatedMeta);
    await writeTranscript(sessionDir, lines.join('\n') + '\n');
    await waitFor(() => entries.some(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ));
    await input.stop();

    const finalResponse = entries.find(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    );
    expect(finalResponse?.['gen_ai.system_instructions']).toContainEqual({
      type: 'text',
      content: 'Updated system instructions',
    });
  });

  it('bounds persisted aborted-turn IDs to the most recent 100 turns', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-aborted-ledger-'));
    tempDirs.push(root);
    const stateStore = new StateStore(path.join(root, 'input-state.json'));
    await stateStore.load();
    const { input, entries, sessionDir } = await createInput(root, stateStore);
    const records = [JSON.stringify({
      timestamp: '2026-06-22T09:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'ledger-session', model_provider: 'openai' },
    })];
    for (let index = 1; index <= 101; index++) {
      const turnId = 'turn-' + index;
      const seconds = String(index % 60).padStart(2, '0');
      records.push(
        JSON.stringify({ timestamp: '2026-06-22T09:00:' + seconds + '.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
        JSON.stringify({ timestamp: '2026-06-22T09:01:' + seconds + '.000Z', type: 'turn_context', payload: { turn_id: turnId, model: 'gpt-5.4-mini' } }),
        JSON.stringify({ timestamp: '2026-06-22T09:02:' + seconds + '.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' } }),
      );
    }
    const transcript = await writeTranscript(sessionDir, records.join('\n') + '\n', 'rollout-ledger.jsonl');
    await waitFor(() => entries.filter(entry =>
      entry['gen_ai.response.finish_reasons']?.includes('cancelled'),
    ).length === 101);
    await input.stop();

    const checkpoint = stateStore.get('codex-aborted-turn:' + transcript).extra?.codexAbortedTurn as {
      emittedAbortedTurnIds: string[];
    };
    expect(checkpoint.emittedAbortedTurnIds).toHaveLength(100);
    expect(checkpoint.emittedAbortedTurnIds).toContain('turn-101');
    expect(checkpoint.emittedAbortedTurnIds).not.toContain('turn-1');
  });
});
