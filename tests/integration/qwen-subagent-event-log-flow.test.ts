import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { ClientType } from '../../src/types/index.js';
import { fixture } from '../unit/hooks/qwen-code-cli/subagent-fixture.mjs';

let directory: string;
let f: ReturnType<typeof fixture>;
let captured: ReadableSpan[];
let flusher: OtlpTraceFlusher;
const kind = (value: string) => captured.filter(s => s.attributes['gen_ai.span.kind'] === value);
const milliseconds = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-subagent-flow-'));
  f = fixture(directory);
  captured = [];
  const exporter: TraceExporterLike = {
    export(spans, callback) { captured.push(...spans); callback({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  };
  flusher = new OtlpTraceFlusher({
    enabled: true, endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf', serviceName: 'qwen-subagent-test',
  }, undefined, () => exporter);
});
afterEach(async () => { await flusher.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
async function send(records: Record<string, unknown>[]) {
  for (const r of records) {
    const e = await transformHookRecord(r, ClientType.QwenCodeCli, 'qwen-code-cli');
    if (e) await flusher.send(e);
  }
}
function assertTree() {
  const byId = new Map(captured.map(s => [s.spanContext().spanId, s]));
  expect(byId.size).toBe(captured.length);
  expect(new Set(captured.map(s => s.spanContext().traceId)).size).toBe(1);
  for (const s of captured) {
    if (s.attributes['gen_ai.span.kind'] === 'ENTRY') continue;
    const parent = byId.get(s.parentSpanId!);
    expect(parent, `${s.name} parent exists`).toBeDefined();
    expect(milliseconds(s.startTime)).toBeGreaterThanOrEqual(milliseconds(parent!.startTime));
    expect(milliseconds(s.endTime)).toBeLessThanOrEqual(milliseconds(parent!.endTime));
    if (s.attributes['gen_ai.agent.scope'] === 'subagent' && s.attributes['gen_ai.span.kind'] === 'AGENT') {
      expect(parent!.attributes['gen_ai.span.kind']).toBe('TOOL');
      expect(s.attributes['gen_ai.subagent.parent_tool_call.id']).toBe(parent!.attributes['gen_ai.tool.call.id']);
    }
  }
}

describe('Qwen Hook → normalization → real OTLP span conversion', () => {
  it('waits for the explicit seal and exports one recursively nested trace', async () => {
    const records = f.run();
    await send(records.slice(0, -1));
    expect(captured).toHaveLength(0);
    await send(records.slice(-1));
    await flusher.flush();
    expect(kind('ENTRY')).toHaveLength(1);
    expect(kind('AGENT')).toHaveLength(3);
    expect(kind('LLM')).toHaveLength(5);
    expect(kind('STEP')).toHaveLength(5);
    expect(kind('TOOL')).toHaveLength(2);
    assertTree();
    const usage = Object.fromEntries(kind('AGENT').map(s => [s.attributes['gen_ai.agent.id'], s.attributes['gen_ai.usage.input_tokens']]));
    expect(usage).toEqual({ [f.sessionId]: 50, child: 22, grandchild: 5 });
    expect(kind('LLM').reduce((n,s) => n + Number(s.attributes['gen_ai.usage.input_tokens']), 0)).toBe(77);
  });

  it('keeps parallel nested agents with identical native tool IDs separate', async () => {
    f.main[1].message.parts.push({ functionCall: { id: 'root-call-2', name: 'agent', args: {} } });
    f.main.splice(3, 0, f.result(10, 'root-call-2'));
    f.write(f.transcript, f.main);
    f.writeChild('child2', null, 'root-call-2', f.child);
    f.writeChild('grandchild2', 'child2', 'nested-call', f.grandchild);
    await send(f.run());
    await flusher.flush();
    expect(kind('ENTRY')).toHaveLength(1);
    expect(kind('AGENT')).toHaveLength(5);
    expect(kind('LLM')).toHaveLength(8);
    expect(new Set(kind('TOOL').map(s => s.attributes['gen_ai.tool.call.id'])).size).toBe(4);
    assertTree();
  });

  it('keeps child lifecycle and collection diagnostics in final spans', async () => {
    f.writeChild('grandchild', 'child', 'nested-call', f.grandchild, { status: 'failed' });
    await send(f.run());
    await flusher.flush();
    const failed = kind('AGENT').find(s => s.attributes['gen_ai.agent.id'] === 'grandchild')!;
    expect(failed.attributes['agent.qwen-code-cli.subagent.status']).toBe('failed');
    expect(failed.status.code).toBe(2);
    expect(kind('TOOL').every(s => s.attributes['agent.qwen-code-cli.subagent.collection'] === 'collected')).toBe(true);
  });

  it('does not expose child content in exported spans when capture is off', async () => {
    fs.writeFileSync(path.join(f.data, 'config.json'), JSON.stringify({ agents: { 'qwen-code-cli': { captureMessageContent: false } } }));
    await send(f.run());
    await flusher.flush();
    expect(kind('AGENT')).toHaveLength(3);
    expect(JSON.stringify(captured.map(s => s.attributes))).not.toContain('SENSITIVE');
    assertTree();
  });
});
