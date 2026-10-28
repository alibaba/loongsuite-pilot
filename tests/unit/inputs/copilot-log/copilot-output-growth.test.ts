import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotLogInput } from '../../../../src/inputs/copilot-log/copilot-log-input.js';
import { InputManager } from '../../../../src/core/input-manager.js';
import { JsonlFlusher } from '../../../../src/flushers/jsonl-flusher.js';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';

it('measures real collector-to-JSONL growth and finite history drain using synthetic pre-existing sessions', async () => {
  const report: any = { synthetic: true,
    realCopilotProcessStarted: false, pipeline: 'CopilotLogInput -> InputManager -> JsonlFlusher', scenarios: [] };
  for (const count of [10, 20, 40]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-output-diagnostic-'));
    let input: CopilotLogInput | undefined;
    try {
      const sessions = path.join(dir, 'sessions');
      const session = path.join(sessions, 'session-test');
      const otel = path.join(dir, 'otel');
      const output = path.join(dir, 'output');
      await fs.mkdir(session, { recursive: true });
      await fs.mkdir(otel);
      const events: any[] = [], spans: any[] = [];
      for (let i = 0; i < count; i++) {
        const f = conversation({ interaction: `interaction-${i}`, base: i * 10 });
        f.events[1].data.content = 'x'.repeat(64 * 1024);
        for (const s of f.spans) s.traceId = createHash('sha256').update(String(i)).digest('hex').slice(0, 32);
        events.push(...(i ? f.events.slice(1) : f.events));
        spans.push(...f.spans);
      }
      const transcript = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      const native = spans.map(s => JSON.stringify(s)).join('\n') + '\n';
      // All source data exists before the first collection, with no further appends.
      await fs.writeFile(path.join(session, 'events.jsonl'), transcript);
      await fs.writeFile(path.join(otel, 'native.jsonl'), native);
      const stateFile = path.join(dir, 'state.json');
      const state = new StateStore(stateFile); await state.load();
      input = new CopilotLogInput({ stateStore: state, sessionDir: sessions, dataDir: dir, otelDir: otel });
      const flusher = new JsonlFlusher({ enabled: true, outputDir: output, rotateDaily: true, maxFileSizeMb: 1 });
      await flusher.start();
      let records = 0, inputMessageBytes = 0, maxRecordBytes = 0, duplicateIds = 0, requestDeltas = 0;
      const ids = new Set<string>();
      const send = flusher.send.bind(flusher);
      const spy = vi.spyOn(flusher, 'send').mockImplementation(async entry => {
        const id = entry['event.id']; if (ids.has(id)) duplicateIds++; ids.add(id);
        records++; maxRecordBytes = Math.max(maxRecordBytes, Buffer.byteLength(JSON.stringify(entry)));
        const messages = entry['gen_ai.input.messages'] ?? entry['gen_ai.input.messages_delta'];
        if (messages != null) inputMessageBytes += Buffer.byteLength(JSON.stringify(messages));
        if (entry['event.name'] === 'llm.request') {
          expect(entry['gen_ai.input.messages']).toBeUndefined();
          expect((entry['gen_ai.input.messages_delta'] as any[]).map(m => m.role)).toEqual(['user']);
          requestDeltas++;
        }
        if (entry['event.name'] === 'llm.response') expect(messages).toBeUndefined();
        await send(entry);
      });
      const manager = new InputManager(); manager.setFlusher(flusher); manager.registerInput(input);
      const cycle = async (target: CopilotLogInput, owner: InputManager) => {
        await (target as any).runCycle();
        await (owner as any).entryQueues.get(target.id);
      };
      await cycle(input, manager);
      const deliveredAfterFirstCycle = (await (input as any).index.all('SELECT * FROM delivered')).length;
      expect(deliveredAfterFirstCycle).toBe(1);
      for (let i = 1; i < count; i++) await cycle(input, manager);
      const delivered = (await (input as any).index.all('SELECT * FROM delivered')).length;
      expect(delivered).toBe(count); expect(duplicateIds).toBe(0); expect(requestDeltas).toBe(count);
      const files = await fs.readdir(output);
      const bytes = (await Promise.all(files.map(async f => (await fs.stat(path.join(output, f))).size))).reduce((a,b) => a+b, 0);
      expect(files.length).toBeGreaterThan(1);
      for (const file of files) expect((await fs.stat(path.join(output, file))).size).toBeLessThanOrEqual(1024 * 1024);
      expect(bytes).toBeLessThan(Buffer.byteLength(transcript) * 3.2);
      const beforeIdle = records;
      for (let i = 0; i < 5; i++) await cycle(input, manager);
      expect(records).toBe(beforeIdle);
      await (input as any).onStop(); input = undefined;
      const restored = new StateStore(stateFile); await restored.load();
      input = new CopilotLogInput({ stateStore: restored, sessionDir: sessions, dataDir: dir, otelDir: otel });
      const restarted = new InputManager(); restarted.setFlusher(flusher); restarted.registerInput(input);
      await cycle(input, restarted); expect(records).toBe(beforeIdle);
      const finalBytes = (await Promise.all((await fs.readdir(output)).map(async file => (await fs.stat(path.join(output, file))).size))).reduce((a, b) => a + b, 0);
      expect(finalBytes).toBe(bytes);
      report.scenarios.push({ turns: count, transcriptBytes: Buffer.byteLength(transcript), nativeBytes: Buffer.byteLength(native),
        jsonlBytes: bytes, amplificationVsTranscript: bytes / Buffer.byteLength(transcript), records, duplicateIds, requestDeltas,
        inputMessageBytes, maxRecordBytes, configuredMaxFileSizeMb: 1, outputFiles: files.length, deliveredAfterFirstCycle,
        finalDelivered: delivered, recordsAddedByFiveIdlePollsAndRestart: records-beforeIdle, bytesAddedAfterDrain: finalBytes-bytes });
      spy.mockRestore();
    } finally {
      if (input) await (input as any).onStop();
      vi.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  for (let i = 1; i < report.scenarios.length; i++) {
    expect(report.scenarios[i].jsonlBytes / report.scenarios[i - 1].jsonlBytes).toBeLessThan(2.05);
  }
  if (process.env.PILOT_GROWTH_REPORT_DIR) {
    await fs.mkdir(process.env.PILOT_GROWTH_REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.PILOT_GROWTH_REPORT_DIR, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
  }
}, 60_000);
