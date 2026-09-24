import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CollectionMethod, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { CursorCliTranscriptInput } from '../../../src/inputs/cursor-cli-transcript/cursor-cli-transcript-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

const CONV = 'c6f8194d-9952-4750-a5ea-bcff7361c80f';

function userRow(text: string): string {
  return JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } });
}

function assistantRow(blocks: unknown[]): string {
  return JSON.stringify({ role: 'assistant', message: { content: blocks } });
}

function endRow(status: string): string {
  return JSON.stringify({ type: 'turn_ended', status });
}

describe('CursorCliTranscriptInput', () => {
  let tmpRoot: string;
  let projectsDir: string;
  let transcriptFile: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-cli-transcript-test-'));
    projectsDir = path.join(tmpRoot, 'projects');
    const convDir = path.join(projectsDir, 'proj-slug', 'agent-transcripts', CONV);
    await fs.mkdir(convDir, { recursive: true });
    transcriptFile = path.join(convDir, `${CONV}.jsonl`);
    await fs.writeFile(transcriptFile, '', 'utf-8');
    stateStore = new MockStateStore();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function makeInput(): CursorCliTranscriptInput {
    return new CursorCliTranscriptInput({
      stateStore: stateStore as never,
      sessionDir: projectsDir,
      projectsDir,
    });
  }

  async function collectOnce(input: CursorCliTranscriptInput): Promise<AgentActivityEntry[]> {
    const captured: AgentActivityEntry[] = [];
    input.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
    await input.start();
    await input.stop();
    return captured;
  }

  it('has correct identity and collection method', () => {
    const input = makeInput();
    expect(input.id).toBe('cursor-cli-transcript');
    expect(input.agentType).toBe(ClientType.CursorCli);
    expect(input.collectionMethod).toBe(CollectionMethod.SessionFilePolling);
  });

  it('emits a full turn: user input, request, tool call, response, terminal', async () => {
    await fs.writeFile(
      transcriptFile,
      [
        userRow('refactor this'),
        assistantRow([
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', name: 'Shell', input: { command: 'ls' } },
        ]),
        endRow('success'),
        '',
      ].join('\n'),
      'utf-8',
    );

    const entries = await collectOnce(makeInput());
    const names = entries.map((e) => e['event.name']);
    expect(names).toEqual(['other', 'llm.request', 'tool.call', 'llm.response', 'other']);

    const [turnStart, request, call, response, terminal] = entries;
    expect(turnStart['gen_ai.turn.start']).toBe(true);
    expect(turnStart['gen_ai.session.id']).toBe(CONV);
    expect(request['gen_ai.step.id']).toBe(`${CONV}:t1:s1`);
    expect(call['gen_ai.tool.name']).toBe('Shell');
    expect(call['gen_ai.tool.call.id']).toBe(`${CONV}:t1:tool:0`);
    expect(response['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(terminal['gen_ai.turn.end']).toBe(true);
    const parts = (response['gen_ai.output.messages'] as Array<{ parts: Array<{ type: string }> }>)[0].parts;
    expect(parts.map((p) => p.type).sort()).toEqual(['text', 'tool_call']);
  });

  it('marks error turns with an error finish reason', async () => {
    await fs.writeFile(
      transcriptFile,
      [userRow('hi'), assistantRow([{ type: 'text', text: '...' }]), endRow('error'), ''].join('\n'),
      'utf-8',
    );

    const entries = await collectOnce(makeInput());
    const response = entries.find((e) => e['event.name'] === 'llm.response');
    expect(response?.['gen_ai.response.finish_reasons']).toEqual(['error']);
  });

  it('holds back an unterminated turn until it completes', async () => {
    await fs.writeFile(transcriptFile, `${userRow('half-written')}\n`, 'utf-8');
    expect(await collectOnce(makeInput())).toHaveLength(0);

    await fs.appendFile(
      transcriptFile,
      `${assistantRow([{ type: 'text', text: 'done' }])}\n${endRow('success')}\n`,
      'utf-8',
    );
    const entries = await collectOnce(makeInput());
    expect(entries.map((e) => e['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'other',
    ]);
  });

  it('does not re-emit flushed turns on restart', async () => {
    await fs.writeFile(
      transcriptFile,
      [userRow('one'), assistantRow([{ type: 'text', text: 'two' }]), endRow('success'), ''].join('\n'),
      'utf-8',
    );

    expect(await collectOnce(makeInput())).toHaveLength(4);
    expect(await collectOnce(makeInput())).toHaveLength(0);
  });
});
