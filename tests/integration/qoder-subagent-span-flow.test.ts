import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { ClientType } from '../../src/types/index.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { buildCanonicalHookEntry } from '../../src/inputs/base/canonical-hook-record.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../assets/hooks/qoder-hook-processor.mjs');
const FIXTURES = path.resolve(__dirname, '../fixtures/qoder');
const SUBAGENT_ID = 'ageneral-purpose-0f1e2d3c4b5a6978';
const CHILD_AGENT_B = 'ageneral-purpose-9z8y7x6w5v4u3t2s';
const AGENT_CALL_A = 'fc_agent0000000000000000000000000000000000000000000000000001';
const AGENT_CALL_B = 'fc_agent0000000000000000000000000000000000000000000000000002';

/**
 * The unit suite pins the *records* the hook emits. This file pins what the
 * feature is actually for: that those records become real spans hanging under
 * the parent Agent TOOL span. Records alone cannot see the two ways they get
 * lost on the way: the hook appends children after the parent's terminal
 * llm.response, so a per-record flush would seal and export the parent turn
 * first and drop the children as late arrivals; and the shared converter
 * resolves gen_ai.subagent.parent_tool_call.id only within one turn buffer, so
 * a child split across buffers disappears without a warning.
 *
 * Path is the production one: real hook process → history JSONL → the same
 * canonical adapter QoderTraceInput uses → the real OtlpTraceFlusher.
 */
let dataDir: string;
let transcriptPath: string;
let sessionDir: string;
let captured: ReadableSpan[];
let flusher: OtlpTraceFlusher;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-subagent-span-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
  sessionDir = transcriptPath.replace(/\.jsonl$/, '');
  captured = [];
  const exporter: TraceExporterLike = {
    export(spans, callback) { captured.push(...spans); callback({ code: ExportResultCode.SUCCESS }); },
    shutdown: async () => {},
  };
  flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf',
    serviceName: 'qoder-subagent-span-test',
  }, undefined, () => exporter);
});

afterEach(async () => {
  await flusher.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runProcessor(): void {
  const result = spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: 'subagent-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-subagent-project',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    encoding: 'utf-8',
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

function readHistoryRecords(): Record<string, unknown>[] {
  const file = path.join(dataDir, 'logs', 'qoder', 'history', `qoder-${getTodayDateString()}.jsonl`);
  return fs.readFileSync(file, 'utf-8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

async function exportHistory(): Promise<void> {
  const entries = readHistoryRecords()
    .map(record => buildCanonicalHookEntry(
      record,
      ClientType.QoderCli,
      undefined,
      { preserveSafeCustomTopLevelFields: true },
    ))
    .filter((entry): entry is AgentActivityEntry => entry !== null);
  // input-manager.ts hands a whole batch to sendBatch, which is what keeps the
  // subagent records that the hook appended after the parent's terminal
  // llm.response inside the same turn buffer. Sending one at a time would seal
  // and export the parent turn first, then drop the children.
  await flusher.sendBatch(entries);
  await flusher.flush();
}

/**
 * Parent-turn wall clock. The child fixture transcript runs
 * 10:00:04.023–10:00:07.512, and an Agent tool.result only exists after the
 * subagent finished, so the delegation rows are placed around that window.
 * Synthetic monotonic timestamps instead would put the children outside their
 * own parent STEP and fail time containment for a reason unrelated to the code
 * under test.
 */
function ts(seconds: number, millis = 0): string {
  const whole = Math.floor(seconds);
  return `2026-09-22T10:00:${String(whole).padStart(2, '0')}.${String(millis).padStart(3, '0')}Z`;
}

/** Parent transcript with one Turn carrying every dispatched Agent call id. */
function writeParentTranscript(callIds: string[]): void {
  const rows = [
    {
      type: 'session_meta', sessionId: 'subagent-session', uuid: 'meta-1', timestamp: ts(0),
      data: { meta_type: 'session_info', content: { mode: 'agent', session_type: 'assistant' } },
    },
    {
      type: 'user', sessionId: 'subagent-session', uuid: 'user-1', timestamp: ts(1),
      entrypoint: 'cli', message: { role: 'user', content: 'delegate the echo task' },
    },
    {
      type: 'assistant', sessionId: 'subagent-session', uuid: 'asst-1', timestamp: ts(2),
      message: {
        id: 'resp_parent0000000000000000000000000000000000000000000000000001',
        role: 'assistant', model: 'ultimate', stop_reason: 'tool_use',
        content: callIds.map(id => ({
          type: 'tool_use', id, name: 'Agent',
          input: { prompt: 'run echo hello', subagent_type: 'general-purpose', description: 'echo test' },
        })),
      },
    },
    ...callIds.map(id => ({
      type: 'user', sessionId: 'subagent-session', uuid: `result-${id.slice(-2)}`, timestamp: ts(9),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: "Subagent completed: printed 'hello'" }] },
    })),
    {
      type: 'assistant', sessionId: 'subagent-session', uuid: 'asst-final', timestamp: ts(10),
      message: {
        id: 'resp_parent_final0000000000000000000000000000000000000000000000001',
        role: 'assistant', model: 'ultimate', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The subagent has finished the task.' }],
      },
    },
    {
      type: 'last-prompt', sessionId: 'subagent-session', uuid: 'last-1', timestamp: ts(11),
      lastPrompt: 'delegate the echo task',
    },
  ];
  fs.writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

function installChild(callId: string, taskId: string, agentId: string): void {
  const subagentsDir = path.join(sessionDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', 'task-atask7c21d0e5b4f9a3c1.json'),
    'utf-8',
  )) as Record<string, unknown>;
  fs.writeFileSync(
    path.join(subagentsDir, `task-${taskId}.json`),
    JSON.stringify({
      ...base, taskId, agentId, parentToolUseId: callId,
      transcriptPath: path.join(subagentsDir, `agent-${agentId}.jsonl`),
    }),
  );
  fs.copyFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
    path.join(subagentsDir, `agent-${agentId}.jsonl`),
  );
}

const spansOf = (kind: string) => captured.filter(s => s.attributes['gen_ai.span.kind'] === kind);

function parentOf(span: ReadableSpan): ReadableSpan | undefined {
  return captured.find(s => s.spanContext().spanId === span.parentSpanId);
}

function spanByToolCallId(callId: string) {
  return spansOf('TOOL').find(s => s.attributes['gen_ai.tool.call.id'] === callId);
}

function childAgentSpanFor(callId: string) {
  return spansOf('AGENT').find(s => s.attributes['gen_ai.subagent.parent_tool_call.id'] === callId);
}

/**
 * Every span below `root`. The converter does not copy gen_ai.agent.id onto the
 * child's LLM / TOOL spans, so membership in the child subtree — not an
 * attribute on each leaf — is what proves the nesting happened.
 */
function descendantsOf(root: ReadableSpan): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  const pending = [root.spanContext().spanId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    for (const child of captured.filter(s => s.parentSpanId === id)) {
      out.push(child);
      pending.push(child.spanContext().spanId);
    }
  }
  return out;
}

function milliseconds(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function assertTree(): void {
  for (const span of captured) {
    if (span.attributes['gen_ai.span.kind'] === 'ENTRY') continue;
    const parent = parentOf(span);
    expect(parent, `${span.name} must have a parent span in the exported set`).toBeDefined();
    expect(milliseconds(span.startTime), `${span.name} starts before its parent ${parent!.name}`)
      .toBeGreaterThanOrEqual(milliseconds(parent!.startTime));
    expect(milliseconds(span.endTime), `${span.name} ends after its parent ${parent!.name}`)
      .toBeLessThanOrEqual(milliseconds(parent!.endTime));
    if (span.attributes['gen_ai.agent.scope'] === 'subagent' && span.attributes['gen_ai.span.kind'] === 'AGENT') {
      expect(parent!.attributes['gen_ai.span.kind']).toBe('TOOL');
      expect(span.attributes['gen_ai.subagent.parent_tool_call.id'])
        .toBe(parent!.attributes['gen_ai.tool.call.id']);
    }
  }
}

describe('Qoder subagent Hook → normalization → real OTLP span conversion', () => {
  it('nests the subagent LLM and TOOL spans under the parent Agent TOOL span', async () => {
    writeParentTranscript([AGENT_CALL_A]);
    installChild(AGENT_CALL_A, 'ataskflow00000000000001', SUBAGENT_ID);

    runProcessor();
    await exportHistory();

    const parents = spansOf('TOOL').filter(s => s.attributes['gen_ai.tool.name'] === 'Agent');
    expect(parents).toHaveLength(1);
    const child = childAgentSpanFor(AGENT_CALL_A);
    expect(child, 'the child AGENT span must exist — records alone cannot prove the converter nested it').toBeDefined();
    expect(child!.parentSpanId).toBe(parents[0].spanContext().spanId);
    expect(child!.attributes['gen_ai.agent.scope']).toBe('subagent');
    expect(child!.attributes['gen_ai.agent.depth']).toBe(1);
    expect(child!.attributes['gen_ai.agent.id']).toBe(SUBAGENT_ID);

    // One trace for the whole delegation, and the child's own LLM / TOOL spans
    // hang inside the child AGENT span rather than at parent level.
    expect(new Set(captured.map(s => s.spanContext().traceId))).toEqual(new Set([parents[0].spanContext().traceId]));
    const subtree = descendantsOf(child!);
    const kinds = subtree.map(s => s.attributes['gen_ai.span.kind']);
    expect(kinds.filter(k => k === 'LLM').length, 'the child subtree must hold its LLM spans')
      .toBeGreaterThan(0);
    const childBash = subtree.find(s => s.attributes['gen_ai.tool.name'] === 'Bash');
    expect(childBash, 'the child subtree must hold the subagent tool span').toBeDefined();
    expect(parentOf(childBash!), 'the child tool span sits under the child STEP').toBeDefined();
    // The parent Agent span is not itself a child span: only collected children
    // carry scope=subagent.
    expect(parents[0].attributes['gen_ai.agent.scope']).toBeUndefined();
    // And the collector's outcome is readable from that span, so a child trace
    // that is only a prefix is not silently mistaken for the whole run.
    expect(parents[0].attributes['agent.qoder.subagent.collection']).toBe('collected');
    assertTree();
  });

  it('keeps two parallel subagents under their own Agent TOOL spans', async () => {
    writeParentTranscript([AGENT_CALL_A, AGENT_CALL_B]);
    installChild(AGENT_CALL_A, 'ataskflow0a0000000000001', SUBAGENT_ID);
    installChild(AGENT_CALL_B, 'ataskflow0b0000000000001', CHILD_AGENT_B);

    runProcessor();
    await exportHistory();

    const toolA = spanByToolCallId(AGENT_CALL_A);
    const toolB = spanByToolCallId(AGENT_CALL_B);
    expect(toolA).toBeDefined();
    expect(toolB).toBeDefined();
    expect(toolA!.spanContext().spanId).not.toBe(toolB!.spanContext().spanId);

    const childA = childAgentSpanFor(AGENT_CALL_A);
    const childB = childAgentSpanFor(AGENT_CALL_B);
    expect(childA, 'parallel child A must be nested under its own Agent call').toBeDefined();
    expect(childB, 'parallel child B must be nested under its own Agent call').toBeDefined();
    expect(childA!.parentSpanId).toBe(toolA!.spanContext().spanId);
    expect(childB!.parentSpanId).toBe(toolB!.spanContext().spanId);
    expect(childA!.attributes['gen_ai.agent.id']).toBe(SUBAGENT_ID);
    expect(childB!.attributes['gen_ai.agent.id']).toBe(CHILD_AGENT_B);
    expect(new Set([childA, childB].map(s => s!.spanContext().spanId)).size).toBe(2);
    assertTree();
  });
});
