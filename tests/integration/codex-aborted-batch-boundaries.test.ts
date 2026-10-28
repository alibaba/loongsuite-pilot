import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { CodexTranscriptInput } from '../../src/inputs/codex-transcript/codex-transcript-input.js';
import { TurnBoundaryProcessor } from '../../src/normalization/turn-boundary-processor.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('aborted Codex child turn batches', () => {
  it.each([
    { limit: '256 entries', tools: 130, outputSize: 10 },
    { limit: '1 MiB', tools: 3, outputSize: 600_000 },
  ])('waits for the native terminal across the $limit limit before exporting and acknowledging', async ({ tools, outputSize }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-abort-batches-'));
    const sessionDir = path.join(root, 'sessions');
    const wakeupDir = path.join(root, 'wakeups');
    await fs.mkdir(sessionDir);
    await fs.mkdir(wakeupDir);
    const state = new StateStore(path.join(root, 'state.json'));
    const input = new CodexTranscriptInput({ stateStore: state, sessionDir, wakeupDir,
      spanContextDir: path.join(root, 'span-contexts'), pollIntervalMs: 60_000 });
    const journal = new CodexTurnJournal(path.join(root, 'journal'));
    const acknowledged = vi.spyOn(journal, 'acknowledge');
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = {
      export(batch, callback) { spans.push(...batch); callback({ code: 0 }); },
      shutdown: async () => {},
    };
    const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'aborted-child-test',
      protocol: 'http/protobuf', endpoints: [{ endpoint: 'http://unused:4318', headers: {} }],
      dataDir: root,
    }, undefined, () => exporter, journal);
    cleanup.push(async () => { await input.stop(); await flusher.shutdown(); await fs.rm(root, { recursive: true }); });
    const boundaries = new TurnBoundaryProcessor();
    const batches: AgentActivityEntry[][] = [];
    let queue = Promise.resolve();
    input.on('entries', (entries: AgentActivityEntry[]) => {
      queue = queue.then(async () => {
        boundaries.enrich(entries);
        batches.push(entries);
        if (!entries.some(entry => entry['gen_ai.turn.end'] === true)) {
          expect(acknowledged).not.toHaveBeenCalled();
          expect(spans).toHaveLength(0);
        }
        await flusher.sendBatch(entries);
      });
      input.holdCheckpointUntil(queue);
    });
    await flusher.start();
    await input.start();
    const session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const turn = 'aborted-child';
    const transcript = path.join(sessionDir, `rollout-${session}.jsonl`);
    const record = (second: number, type: string, payload: Record<string, unknown>) => JSON.stringify({
      timestamp: new Date(Date.parse('2026-08-07T02:00:00Z') + second * 1000).toISOString(), type, payload,
    });
    const records = [
      record(0, 'session_meta', { id: session, timestamp: '2026-08-07T02:00:00Z', model_provider: 'openai',
        thread_source: 'subagent', source: { subagent: { thread_spawn: {
          parent_thread_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', depth: 1,
        } } } }),
      record(1, 'turn_context', { turn_id: turn, model: 'gpt-test' }),
      record(1.01, 'event_msg', { type: 'task_started', turn_id: turn }),
      record(1.02, 'response_item', { type: 'agent_message', author: '/root', recipient: '/root/child',
        internal_chat_message_metadata_passthrough: { turn_id: turn },
        content: [{ type: 'input_text', text: 'perform the delegated work' }] }),
    ];
    for (let index = 0; index < tools; index++) {
      records.push(
        record(2 + index * 0.01, 'response_item', { type: 'function_call', call_id: `tool-${index}`,
          name: 'exec_command', arguments: JSON.stringify({ cmd: `echo marker-${index}` }) }),
        record(4 + index * 0.01, 'response_item', { type: 'function_call_output', call_id: `tool-${index}`,
          output: `marker-${index}:` + 'x'.repeat(outputSize) }),
      );
    }
    records.push(
      record(7, 'event_msg', { type: 'token_count', info: { last_token_usage: {
        input_tokens: 11, output_tokens: 7, total_tokens: 18, cached_input_tokens: 0,
      } } }),
      record(8, 'event_msg', { type: 'turn_aborted', turn_id: turn, reason: 'interrupted' }),
    );
    await fs.writeFile(transcript, records.join('\n') + '\n');
    await fs.writeFile(path.join(wakeupDir, `${session}.json`), JSON.stringify({
      session_id: session, turn_id: turn, initial_turn_id: turn, transcript_path: transcript,
      hook_event: 'subagent-stop', received_at: new Date().toISOString(),
    }));
    // 正文校验和完整恢复共享工作时间片；延期后继续驱动原范围，不能假定一轮读穿。
    for (let cycle = 0; cycle < 32; cycle++) {
      await (input as unknown as { runCycle(): Promise<void> }).runCycle();
      await queue;
      if (batches.flat().some(entry => entry['gen_ai.turn.end'] === true)) break;
    }
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.slice(0, -1).flat().every(entry => entry['gen_ai.turn.end'] !== true)).toBe(true);
    expect(batches.flat().filter(entry => entry['gen_ai.turn.end'] === true)).toHaveLength(1);
    expect(batches.flat().every(entry => entry['gen_ai.session.id'] === session)).toBe(true);
    expect(acknowledged).toHaveBeenCalledTimes(1);
    const exportedTools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(exportedTools).toHaveLength(tools);
    expect(new Set(exportedTools.map(span => span.attributes['gen_ai.tool.call.id']))).toEqual(
      new Set(Array.from({ length: tools }, (_, index) => `tool-${index}`)),
    );
    expect(await journal.isAcknowledged(batches[0][0])).toBe(true);
  });
});
