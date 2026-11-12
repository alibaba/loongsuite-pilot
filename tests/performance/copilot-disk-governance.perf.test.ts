import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { CopilotLogInput } from '../../src/inputs/copilot-log/copilot-log-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { LogRetentionService, OUTPUT_RETENTION_MAX_TOTAL_BYTES } from '../../src/core/log-retention-service.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import { ClientType } from '../../src/types/index.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import { conversation } from '../unit/hooks/copilot/hybrid-fixture.mjs';
import { parseInteractions } from '../../assets/hooks/copilot/interaction-parser.mjs';

const enabled = process.env.PILOT_DISK_STRESS === '1';
const report: Record<string, unknown> = {
  synthetic: true, networkRequests: 0, realAgentProcesses: 0,
  node: process.version, platform: `${process.platform}/${process.arch}`,
  pipeline: 'CopilotLogInput -> SQLite -> InputManager -> JsonlFlusher',
  scenarios: [],
};
const scenarios = report.scenarios as Record<string, unknown>[];
const temporary: string[] = [];
afterAll(async () => {
  try {
    if (enabled && process.env.PILOT_DISK_STRESS_REPORT) {
      await fs.mkdir(path.dirname(process.env.PILOT_DISK_STRESS_REPORT), { recursive: true });
      await fs.writeFile(process.env.PILOT_DISK_STRESS_REPORT, JSON.stringify(report, null, 2) + '\n');
    }
  } finally {
    await Promise.all(temporary.map(dir => fs.rm(dir, { recursive: true, force: true })));
  }
});

async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-disk-stress-'));
  temporary.push(dir);
  return dir;
}
async function fixture(dir: string, turns: number, payloadBytes: number, epoch?: number, append = false, firstId = 0) {
  const sessionDir = path.join(dir, 'sessions');
  const session = path.join(sessionDir, 'session-test');
  const otelDir = path.join(dir, 'otel');
  await fs.mkdir(session, { recursive: true }); await fs.mkdir(otelDir, { recursive: true });
  const eventFile = path.join(session, 'events.jsonl');
  const nativeFile = path.join(otelDir, 'native.jsonl');
  const events = await fs.open(eventFile, append ? 'a' : 'w'); const native = await fs.open(nativeFile, append ? 'a' : 'w');
  try {
    for (let i = 0; i < turns; i++) {
      const f = conversation({ interaction: `interaction-${firstId + i}`, base: i * 10 });
      f.events[1].data.content = 'x'.repeat(payloadBytes);
      const trace = createHash('sha256').update(String(firstId + i)).digest('hex').slice(0, 32);
      if (epoch !== undefined) {
        const base = Date.parse(f.events[0].timestamp);
        for (const event of f.events) event.timestamp = new Date(epoch + i * 5000 + Date.parse(event.timestamp) - base).toISOString();
        for (const span of f.spans) {
          const start = epoch + i * 5000 + span.startTime[0] * 1000 - base;
          const end = epoch + i * 5000 + span.endTime[0] * 1000 - base;
          span.startTime = [Math.floor(start / 1000), (start % 1000) * 1_000_000];
          span.endTime = [Math.floor(end / 1000), (end % 1000) * 1_000_000];
        }
      }
      for (const span of f.spans) span.traceId = trace;
      await events.write((i || append ? f.events.slice(1) : f.events).map(event => JSON.stringify(event)).join('\n') + '\n');
      await native.write(f.spans.map(span => JSON.stringify(span)).join('\n') + '\n');
    }
  } finally { await events.close(); await native.close(); }
  return { sessionDir, otelDir, eventFile, nativeFile };
}
async function stats(dir: string) {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map(async name => (await fs.stat(path.join(dir, name))).size));
  return { files: names.length, bytes: sizes.reduce((a, b) => a + b, 0), maxBytes: Math.max(0, ...sizes) };
}
async function cycle(input: CopilotLogInput, manager: InputManager) {
  await (input as any).runCycle();
  await (manager as any).entryQueues.get(input.id);
}
function collector(dir: string, sources: { sessionDir: string; otelDir: string }, state: StateStore, replay = false) {
  const input = new CopilotLogInput({ stateStore: state, dataDir: dir, ...sources, ...(replay ? { historyStartTimeMs: 0 } : {}) });
  const flusher = new JsonlFlusher({ enabled: true, outputDir: path.join(dir, 'logs/output'), rotateDaily: true, maxFileSizeMb: 1 });
  const manager = new InputManager(); manager.setFlusher(flusher); manager.registerInput(input);
  return { input, manager, flusher };
}

describe.skipIf(!enabled)('Copilot disk governance stress (opt in; all generated files are removed)', () => {
  it('rejects a large pre-adoption backlog and does not reopen it on restart/index rebuild', async () => {
    const dir = await root(); const sources = await fixture(dir, 1024, 64 * 1024);
    const historicalTranscriptBytes = (await fs.stat(sources.eventFile)).size;
    const state = new StateStore(path.join(dir, 'state.json')); await state.load();
    let c = collector(dir, sources, state); const start = performance.now();
    try {
      for (let i = 0; i < 40; i++) await cycle(c.input, c.manager);
      const output = await stats(path.join(dir, 'logs/output'));
      expect(output.bytes).toBe(0);
      const stored = await (c.input as any).index.all('SELECT count(*) n FROM records');
      expect(stored[0].n).toBeLessThanOrEqual(2);
      await (c.input as any).onStop();
      const index = path.join(dir, 'state/copilot/source-index.sqlite');
      // This is this test's own index, deliberately removed to verify durable adoption policy.
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(index + suffix, { force: true });
      c = collector(dir, sources, state);
      for (let i = 0; i < 40; i++) await cycle(c.input, c.manager);
      expect((await stats(path.join(dir, 'logs/output'))).bytes).toBe(0);
      await fixture(dir, 128, 16 * 1024, Date.now() + 1, true, 1024);
      for (let i = 0; i < 140; i++) await cycle(c.input, c.manager);
      const afterNewMessages = await stats(path.join(dir, 'logs/output'));
      const delivered = await (c.input as any).index.all('SELECT count(*) n FROM delivered');
      expect(delivered[0].n).toBe(128);
      expect(afterNewMessages.bytes).toBeGreaterThan(0);
      expect(afterNewMessages.maxBytes).toBeLessThanOrEqual(1024 * 1024);
      scenarios.push({ name: 'pre-adoption-backlog', turns: 1024, historicalTranscriptBytes,
        finalTranscriptBytes: (await fs.stat(sources.eventFile)).size,
        historicalJsonlBytes: 0, storedHistoricalRecords: stored[0].n, idleAndIndexRebuildAdditionalBytes: 0,
        appendedNewTurnsInSameSession: 128, newTurnsDelivered: delivered[0].n, newTurnsJsonlBytes: afterNewMessages.bytes,
        elapsedMs: performance.now() - start });
    } finally { await (c.input as any).onStop(); await c.flusher.shutdown(); }
  }, 180_000);

  it('keeps controlled post-boundary replay linear, segmented and duplicate-free at 128/256/512 turns', async () => {
    const results: Record<string, number>[] = [];
    for (const turns of [128, 256, 512]) {
      const dir = await root(); const sources = await fixture(dir, turns, 16 * 1024);
      const state = new StateStore(path.join(dir, 'state.json')); await state.load();
      let c = collector(dir, sources, state, true); const seen = new Set<string>(); let duplicates = 0;
      const send = c.flusher.send.bind(c.flusher);
      c.flusher.send = async entry => { const id = entry['event.id']; if (seen.has(id)) duplicates++; seen.add(id); await send(entry); };
      const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
      let maxRss = process.memoryUsage().rss;
      const sampler = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage().rss); }, 10);
      const started = performance.now();
      try {
        for (let i = 0; i < turns + 8; i++) await cycle(c.input, c.manager);
        const delivered = await (c.input as any).index.all('SELECT count(*) n FROM delivered');
        expect(delivered[0].n).toBe(turns); expect(duplicates).toBe(0); expect(seen.size).toBe(turns * 5);
        const before = await stats(path.join(dir, 'logs/output'));
        expect(before.maxBytes).toBeLessThanOrEqual(1024 * 1024);
        await (c.input as any).onStop(); c = collector(dir, sources, state);
        for (let i = 0; i < 5; i++) await cycle(c.input, c.manager);
        expect(await stats(path.join(dir, 'logs/output'))).toEqual(before);
        const result = { turns, transcriptBytes: (await fs.stat(sources.eventFile)).size, jsonlBytes: before.bytes,
          files: before.files, maxFileBytes: before.maxBytes, elapsedMs: performance.now() - started,
          uniqueEventIds: seen.size, duplicates, idleAndRestartAdditionalBytes: 0, maxRssBytes: maxRss,
          eventLoopP99Ms: histogram.percentile(99) / 1e6 };
        results.push(result); scenarios.push({ name: 'linear-output', ...result });
      } finally { clearInterval(sampler); histogram.disable(); await (c.input as any).onStop(); await c.flusher.shutdown(); }
    }
    for (let i = 1; i < results.length; i++) expect(results[i].jsonlBytes / results[i - 1].jsonlBytes).toBeLessThan(2.05);
  }, 180_000);

  it('preserves records under 64 concurrent producers and repeated rotation', async () => {
    const dir = await root(); const output = path.join(dir, 'logs/output');
    const writer = new JsonlFlusher({ enabled: true, outputDir: output, rotateDaily: true, maxFileSizeMb: 1 });
    const started = performance.now(); const count = 8192;
    try {
      for (let base = 0; base < count; base += 64) {
        await Promise.all(Array.from({ length: 64 }, (_, i) => writer.send(buildTestEntry({ uuid: String(base + i), agentType: ClientType.CopilotCli,
          'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: '界'.repeat(2048) }] }] }))));
      }
      await writer.shutdown();
      const ids = new Set<string>(); let records = 0;
      for (const file of await fs.readdir(output)) {
        const text = await fs.readFile(path.join(output, file), 'utf8');
        for (const line of text.trim().split('\n')) { const record = JSON.parse(line); ids.add(record['event.id']); records++; }
      }
      const result = await stats(output);
      expect(records).toBe(count); expect(ids.size).toBe(count); expect(result.maxBytes).toBeLessThanOrEqual(1024 * 1024);
      scenarios.push({ name: 'concurrent-rotation', producers: 64, records, uniqueEventIds: ids.size, ...result, elapsedMs: performance.now() - started });
    } finally { await writer.shutdown(); }
  }, 180_000);

  it('exports a 64-step tool interaction with exact native usage and bounded debug files', async () => {
    const dir = await root(); const f = conversation({ interaction: 'interaction-long' });
    const events = f.events.slice(0, 2); const spans = [];
    const steps = 64; const epoch = Date.parse(f.events[0].timestamp);
    const iso = (second: number) => new Date(epoch + second * 1000).toISOString();
    for (let i = 0; i < steps; i++) {
      const second = 2 + i * 4; const turnId = String(i); const apiCallId = `api-${i}`;
      events.push({ type: 'assistant.turn_start', id: `start-${i}`, timestamp: iso(second), data: { interactionId: 'interaction-long', turnId } });
      events.push({ type: 'assistant.message', id: `message-${i}`, timestamp: iso(second + 1), data: {
        interactionId: 'interaction-long', turnId, apiCallId, model: 'qwen-test', content: 'Continue.',
        toolRequests: i + 1 < steps ? [{ toolCallId: `tool-${i}`, name: 'read', arguments: { path: 'sample' } }] : [],
      } });
      if (i + 1 < steps) {
        events.push({ type: 'tool.execution_start', id: `tool-start-${i}`, timestamp: iso(second + 2), data: {
          interactionId: 'interaction-long', turnId, toolCallId: `tool-${i}`, toolName: 'read', arguments: { path: 'sample' },
        } });
        events.push({ type: 'tool.execution_complete', id: `tool-end-${i}`, timestamp: iso(second + 3), data: {
          interactionId: 'interaction-long', turnId, toolCallId: `tool-${i}`, success: true, result: { content: '界'.repeat(2048) },
        } });
      }
      events.push({ type: 'assistant.turn_end', id: `end-${i}`, timestamp: iso(second + 4), data: { turnId } });
      spans.push({ ...f.spans[0], spanId: `chat-${i}`, startTime: [epoch / 1000 + second, 0], endTime: [epoch / 1000 + second + 1, 0],
        attributes: { ...f.spans[0].attributes, 'github.copilot.turn_id': turnId, 'gen_ai.response.id': apiCallId } });
    }
    spans.push({ ...f.spans[1], endTime: [epoch / 1000 + 2 + steps * 4, 0] });
    let exported = 0, llms = 0, inputTokens = 0; const started = performance.now();
    const writer = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'stress', debug: true, dataDir: dir,
      endpoints: [{ name: 'memory', endpoint: 'http://127.0.0.1:1' }] }, undefined, () => ({
      export: (batch, done) => {
        exported += batch.length;
        for (const span of batch) if (span.attributes['gen_ai.span.kind'] === 'LLM') {
          llms++; inputTokens += Number(span.attributes['gen_ai.usage.input_tokens']);
        }
        done({ code: 0 });
      }, shutdown: async () => {},
    }));
    try {
      const records = parseInteractions(events, spans, { requireOtel: true }).flatMap(batch => batch.records);
      expect(records.length).toBeGreaterThan(steps * 3);
      await writer.sendBatch(records); await writer.shutdown();
      expect(llms).toBe(steps); expect(inputTokens).toBe(steps * 100);
      const debug = await stats(path.join(dir, 'logs/otlp-debug'));
      expect(debug.bytes).toBeGreaterThan(0); expect(debug.maxBytes).toBeLessThanOrEqual(100 * 1024 ** 2);
      scenarios.push({ name: 'long-tool-interaction', steps, normalizedEvents: records.length, nativeLlmInputTokens: inputTokens,
        exportedSpans: exported, debugBytes: debug.bytes, debugFiles: debug.files, maxDebugFileBytes: debug.maxBytes,
        mockExporter: true, elapsedMs: performance.now() - started });
    } finally { await writer.shutdown(); }
  }, 180_000);

  it('reclaims today closed segments and >3GiB legacy files using sparse boundary fixtures', async () => {
    const dir = await root(); const output = path.join(dir, 'logs/output');
    const debug = path.join(dir, 'logs/otlp-debug'); const failed = path.join(dir, 'logs/otlp-failed');
    for (const folder of [output, debug, failed]) await fs.mkdir(folder, { recursive: true });
    const day = getTodayDateString();
    async function sparse(file: string, size: number) { const handle = await fs.open(file, 'w'); try { await handle.truncate(size); } finally { await handle.close(); } }
    const started = performance.now(); const large = 3 * 1024 ** 3 + 1;
    for (const folder of [output, debug, failed]) await sparse(path.join(folder, `copilot-${day}.jsonl`), large);
    for (let i = 0; i < 128; i++) await sparse(path.join(output, `copilot.part-${i.toString(16).padStart(32, '0')}-${day}.jsonl`), 32 * 1024 ** 2);
    const service = new LogRetentionService(dir, { enabled: true, intervalMs: 21_600_000, hookHistoryDays: 7,
      hookErrorDays: 7, hookDebugDays: 7, outputDays: 7, slsFailedDays: 7, otlpFailedDays: 7, metricAlarmDays: 7 });
    const result = await service.runCleanup();
    for (const folder of [output, debug, failed]) expect(await fs.stat(path.join(folder, `copilot-${day}.jsonl`)).then(() => true, () => false)).toBe(false);
    const remaining = await stats(output); expect(remaining.bytes).toBeLessThanOrEqual(OUTPUT_RETENTION_MAX_TOTAL_BYTES);
    scenarios.push({ name: 'sparse-emergency-pressure', sparseNotPhysicalWriteThroughput: true, over3GiBFiles: 3,
      closedSegments: 128, closedLogicalBytesBefore: 4 * 1024 ** 3, remainingOutputBytes: remaining.bytes,
      deleted: result.deleted, errors: result.errors, elapsedMs: performance.now() - started });
  }, 60_000);
});
