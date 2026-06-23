import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CodexAbortedTurnInput } from '../../../../src/inputs/codex-aborted-turn/codex-aborted-turn-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'aborted-turn.jsonl');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
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
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 12,
    });
    expect(finalResponse?.['error.type']).toBeUndefined();
    expect(finalResponse?.['gen_ai.output.messages']).toBeUndefined();

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
