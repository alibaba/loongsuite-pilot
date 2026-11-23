import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { WorkspacePolicy } from '../../src/core/workspace-policy.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { AntigravityInput } from '../../src/inputs/antigravity/antigravity-input.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';
import { loadDatabaseSync } from '../../src/utils/node-sqlite.js';
import { readJournal } from '../helpers/codex-journal.js';

const SESSION_ID = 'parallel-restart-session';
const TURN_ID = 'f25dbcd8-2db0-4799-921a-f96cbf3cbd22';
const BASE_SEC = 1_778_100_000;

function varint(value: number): Buffer {
  const bytes = [];
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  return Buffer.from([...bytes, value]);
}

function numberField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytesField(field: number, value: Buffer | string): Buffer {
  const payload = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

function generation(step: number, id: string, completed: number): Buffer {
  const usage = Buffer.concat([numberField(2, 12), numberField(3, 5), bytesField(11, id)]);
  return Buffer.concat([
    bytesField(1, Buffer.concat([
      bytesField(4, usage),
      bytesField(9, bytesField(4, numberField(1, BASE_SEC + completed))),
      bytesField(19, 'Gemini 3.8 Flash (High)'),
    ])),
    numberField(2, step),
  ]);
}

class TestAntigravityInput extends AntigravityInput {
  poll(): void { this.onPoll(); }
}

async function startCollector(root: string, dataRoot: string, spans: ReadableSpan[], excluded: string[] = []) {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const inputManager = new InputManager();
  inputManager.setConfiguredUserId('parallel-restart-user');
  inputManager.setWorkspacePolicy(new WorkspacePolicy(excluded, path.join(root, 'workspace-exclusions')));
  const journal = new CodexTurnJournal(path.join(root, 'pending-turns'), 100,
    ['codex', 'hermes', 'openclaw', 'antigravity', 'antigravity-cli']);
  const trace = new OtlpTraceFlusher({
    enabled: true,
    serviceName: 'antigravity-restart-test',
    endpoints: [{ endpoint: 'http://127.0.0.1:4318/v1/traces' }],
    captureMessageContent: true,
  }, undefined, () => ({
    export(batch, callback) {
      spans.push(...batch);
      callback({ code: ExportResultCode.SUCCESS });
    },
    async shutdown() {},
  }), journal, entries => inputManager.prepareRestoredEntries(entries));
  const jsonl = new JsonlFlusher({
    enabled: true, outputDir: root, rotateDaily: false, maxFileSizeMb: 16,
  });
  await jsonl.start();
  await trace.start();
  const output = new MultiFlusher([jsonl, trace]);
  inputManager.setFlusher(output);

  const input = new TestAntigravityInput({
    stateStore, dataRoot, clientType: ClientType.Antigravity, pollIntervalMs: 60_000,
  });
  inputManager.registerInput(input);
  await inputManager.startInput(input.id);
  let stopped = false;
  return {
    input, journal, stateStore,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Collector shutdown drains InputManager output before the flusher.
      await inputManager.stopAll();
      await output.shutdown();
      await stateStore.save();
    },
  };
}

it.each([
  { name: 'retains a parallel Antigravity tool turn across collector shutdown and restart', excludeSecondary: false },
  { name: 'does not replay a retained Antigravity turn when a secondary workspace is newly excluded', excludeSecondary: true },
])('$name', async ({ excludeSecondary }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-restart-'));
  const dataRoot = path.join(root, 'source');
  const dbPath = path.join(dataRoot, 'conversations', `${SESSION_ID}.db`);
  const transcriptPath = path.join(dataRoot, 'brain', SESSION_ID, '.system_generated', 'logs', 'transcript.jsonl');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync()!;
  const db = new DatabaseSync(dbPath);
  const collectors: Array<Awaited<ReturnType<typeof startCollector>>> = [];
  let releaseJournal: (() => void) | undefined;
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, metadata BLOB);
      CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL);
      CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY, data BLOB);
    `);
    const workspaces = [path.join(root, 'allowed-workspace'), path.join(root, 'secondary-workspace')];
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(
      Buffer.concat(workspaces.map(directory => bytesField(7, pathToFileURL(directory).href))),
    );
    const saveStep = db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)');
    const saveGeneration = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    const step = (idx: number, completed: number, callId?: string) => {
      saveStep.run(idx, Buffer.concat([
        bytesField(8, numberField(1, BASE_SEC + completed)),
        bytesField(12, TURN_ID),
        ...(callId ? [bytesField(4, Buffer.concat([bytesField(1, callId), bytesField(2, 'read_file')]))] : []),
      ]));
    };
    const addGeneration = (idx: number, planner: number, id: string, completed: number) => {
      const data = generation(planner, id, completed);
      saveGeneration.run(idx, data, data.length);
    };
    const line = (step_index: number, type: string, elapsed: number, fields: Record<string, unknown>) =>
      JSON.stringify({
        step_index, type, status: 'DONE',
        created_at: new Date((BASE_SEC + elapsed) * 1000).toISOString(),
        ...fields,
      }) + '\n';
    const entries = async (): Promise<AgentActivityEntry[]> =>
      (await fs.readFile(path.join(root, 'antigravity-all.jsonl'), 'utf8')).trim().split('\n')
        .map((item) => JSON.parse(item) as AgentActivityEntry);
    const spans: ReadableSpan[] = [];
    const first = await startCollector(root, dataRoot, spans);
    collectors.push(first);
    const journalBarrier = new Promise<void>(resolve => { releaseJournal = resolve; });
    const appendDurably = first.journal.append.bind(first.journal);
    const append = vi.spyOn(first.journal, 'append').mockImplementationOnce(async (batch) => {
      await journalBarrier;
      return appendDurably(batch);
    });

    step(0, 0);
    step(1, 2);
    addGeneration(0, 1, 'parallel-response', 2);
    await fs.writeFile(transcriptPath,
      line(0, 'USER_INPUT', 0, { content: 'Read both files' }) +
      line(1, 'PLANNER_RESPONSE', 1, {
        tool_calls: [
          { id: 'parallel-A', name: 'read_file', args: { path: 'alpha.txt' } },
          { id: 'parallel-B', name: 'read_file', args: { path: 'beta.txt' } },
        ],
      }),
    );
    first.input.poll();
    await vi.waitFor(async () => {
      expect(append).toHaveBeenCalled();
      expect((await entries()).filter(entry => entry['event.name'] === 'tool.call')).toHaveLength(2);
    });
    // JSONL has accepted the prefix, but it is not yet durable for OTLP replay.
    expect(first.stateStore.waitingForOutput).toBe(true);
    expect(first.stateStore.isPersisted(first.input.id)).toBe(false);
    releaseJournal?.();
    await vi.waitFor(() => expect(first.stateStore.isPersisted(first.input.id)).toBe(true));

    step(3, 7, 'parallel-B');
    await fs.appendFile(transcriptPath, line(3, 'GENERIC', 7, { content: 'beta result' }));
    first.input.poll();
    await vi.waitFor(async () => {
      expect((await entries()).filter(entry => entry['event.name'] === 'tool.result').map(
        entry => entry['gen_ai.tool.call.id'],
      )).toEqual(['parallel-B']);
    });
    await first.stop();
    expect(spans).toHaveLength(0);
    const pending = await readJournal(first.journal);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toContainEqual(expect.objectContaining({ workspace_roots: workspaces }));
    expect((await entries()).some(entry => 'workspace_roots' in entry)).toBe(false);

    const restarted = await startCollector(root, dataRoot, spans,
      excludeSecondary ? [workspaces[1]!] : []);
    collectors.push(restarted);
    expect(spans).toHaveLength(0);
    if (excludeSecondary) {
      expect(await readJournal(restarted.journal)).toHaveLength(0);
      await restarted.stop();
      expect(spans).toHaveLength(0);
      return;
    }
    step(2, 10, 'parallel-A');
    step(4, 12);
    addGeneration(1, 4, 'final-response', 12);
    await fs.appendFile(transcriptPath,
      line(2, 'GENERIC', 10, { content: 'alpha result' }) +
      line(4, 'PLANNER_RESPONSE', 12, { content: 'Both files read' }),
    );
    restarted.input.poll();
    await vi.waitFor(() => {
      expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(2);
    });
    await restarted.stop();
    expect(await readJournal(restarted.journal)).toEqual([]);

    const raw = await entries();
    expect(new Set(raw.map(entry => entry['event.id'])).size).toBe(raw.length);
    expect(raw.some(entry => 'workspace_roots' in entry)).toBe(false);
    expect(raw.filter(entry => entry['event.name'] === 'llm.response')
      .map(entry => entry['gen_ai.response.id'])).toEqual(['parallel-response', 'final-response']);
    expect(raw.filter(entry => entry['event.name'] === 'tool.call')
      .map(entry => entry['gen_ai.tool.call.id'])).toEqual(['parallel-A', 'parallel-B']);
    expect(raw.filter(entry => entry['event.name'] === 'tool.result')
      .map(entry => [entry['gen_ai.tool.call.id'], entry['gen_ai.tool.call.result']]))
      .toEqual([['parallel-B', 'beta result'], ['parallel-A', 'alpha result']]);

    const roots = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(roots).toHaveLength(1);
    expect(roots[0]?.parentSpanId).toBeUndefined();
    expect(new Set(spans.map(span => span.spanContext().traceId))).toEqual(new Set([raw[0]?.trace_id]));
    const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(tools).toHaveLength(2);
    for (const [id, filename, result, seconds] of [
      ['parallel-A', 'alpha.txt', 'alpha result', 8],
      ['parallel-B', 'beta.txt', 'beta result', 5],
    ] as const) {
      const tool = tools.find(span => span.attributes['gen_ai.tool.call.id'] === id);
      expect(tool?.attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify({ path: filename }));
      expect(tool?.attributes['gen_ai.tool.call.result']).toBe(result);
      expect(tool?.duration).toEqual([seconds, 0]);
    }
  } finally {
    releaseJournal?.();
    for (const collector of collectors) await collector.stop();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
