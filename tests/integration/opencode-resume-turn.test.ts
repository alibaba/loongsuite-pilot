import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';

const fixture = fileURLToPath(new URL('../fixtures/opencode/resumed-process.mjs', import.meta.url));
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runProcess(mode: string): Promise<AgentActivityEntry[]> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pilot-resume-'));
  tempDirs.push(dir);
  execFileSync(process.execPath, [fixture, mode], {
    env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, LOONGSUITE_PILOT_DATA_DIR: dir },
  });
  const logs = path.join(dir, 'logs', 'opencode');
  const records = readdirSync(logs).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(path.join(logs, name), 'utf8').trim().split('\n'))
    .map(line => JSON.parse(line));
  return (await Promise.all(records.map(record =>
    transformHookRecord(record, ClientType.OpenCode, 'opencode'))))
    .filter((record): record is AgentActivityEntry => record !== null);
}

describe('OpenCode session resumed in a new process', () => {
  it.each([false, true])('exports resumed tools across polls (shared first batch: %s)', async (sharedBatch) => {
    const first = await runProcess('first');
    const second = await runProcess('resume');
    const spans: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true, endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
      protocol: 'http/protobuf', serviceName: 'resume-test', debug: false,
    }, undefined, () => ({
      export(batch, callback) { spans.push(...batch); callback({ code: ExportResultCode.SUCCESS }); },
      shutdown: async () => {},
    }));
    try {
      // Upstream linking may put both invocations under the same trace. Turn
      // uniqueness must survive that rewrite as well as process restarts.
      for (const record of [...first, ...second]) record.trace_id = 'a'.repeat(32);
      const cut = second.findIndex(record => record['gen_ai.step.id']?.endsWith(':s2'));
      expect(cut).toBeGreaterThan(0);
      await flusher.sendBatch(sharedBatch ? [...first, ...second.slice(0, cut)] : first);
      if (!sharedBatch) await flusher.sendBatch(second.slice(0, cut));
      await flusher.sendBatch(second.slice(cut));
      // Do not call flush() between polls: it clears the late-arrival guard.
      const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
      expect(tools.map(span => span.attributes['gen_ai.tool.name']).sort()).toEqual(['edit', 'read', 'write']);
      for (const kind of ['ENTRY', 'AGENT']) {
        expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === kind)).toHaveLength(2);
      }
      expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(4);
      expect(new Set(first.map(record => record['gen_ai.turn.id'])).size).toBe(1);
      expect(new Set(second.map(record => record['gen_ai.turn.id'])).size).toBe(1);
      expect(first[0]['gen_ai.turn.id']).not.toBe(second[0]['gen_ai.turn.id']);
      expect(first[0]['gen_ai.session.id']).toBe(second[0]['gen_ai.session.id']);
      const ids = new Set(spans.map(span => span.spanContext().spanId));
      expect(ids.size).toBe(spans.length);
      for (const tool of tools) {
        expect(ids.has(tool.parentSpanId!)).toBe(true);
        expect(tool.duration[0] * 1e9 + tool.duration[1]).toBeGreaterThan(0);
        expect(tool.attributes['gen_ai.tool.call.result']).toBeTruthy();
      }
      const count = spans.length;
      await flusher.sendBatch(second);
      expect(spans).toHaveLength(count);
    } finally {
      await flusher.shutdown();
    }
  });
});
