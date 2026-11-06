import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

describe('Span enrichers through real EventLog conversion', () => {
  it('enriches final tool attributes after built-ins and fans out to export, debug and failure logs', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pilot-enricher-export-'));
    const file = path.join(dir, 'skill.mjs');
    await writeFile(file, `export default { enrich(span, context) {
      const a = span.attributes;
      if (a['gen_ai.span.kind'] !== 'TOOL') return;
      if (!a['gen_ai.tool.call.arguments'] || !a['gen_ai.tool.call.result']) throw new Error('Missing tool content');
      return {
        'gen_ai.skill.name': a['gen_ai.skill.name'] + ':' + a['gen_ai.tool.name'],
        'test.service': context.serviceName,
        'test.agent': context.agentType,
      };
    } };`);
    const captured: Record<string, ReadableSpan[]> = {};
    const flusher = new OtlpTraceFlusher({
      enabled: true, serviceName: 'test', protocol: 'http/protobuf', dataDir: dir,
      captureMessageContent: true, debug: true, spanEnricherPaths: [file],
      endpoints: [
        { name: 'primary', endpoint: 'http://unused:4318' },
        { name: 'secondary', endpoint: 'http://unused:4319', serviceName: 'managed' },
        { name: 'failed', endpoint: 'http://unused:4320' },
      ],
    }, undefined, options => ({
      export(spans, cb) {
        (captured[options.url] ??= []).push(...spans);
        cb(options.url.includes('4320') ? { code: 1, error: new Error('test failure') } : { code: 0 });
      },
      shutdown: async () => {},
    }));
    try {
      const text = await readFile(new URL('./fixtures/cp5-events.jsonl', import.meta.url), 'utf8');
      const entries = text.trim().split('\n').map(line => JSON.parse(line)) as AgentActivityEntry[];
      for (const entry of entries) {
        if (entry['event.name'] === 'tool.call') entry['gen_ai.skill.name'] = 'builtin';
      }
      await flusher.sendBatch(entries);
      await flusher.flush();
      expect(Object.keys(captured)).toHaveLength(3);
      for (const [url, spans] of Object.entries(captured)) {
        expect(spans).toHaveLength(10);
        const tools = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
        expect(tools).toHaveLength(2);
        for (const tool of tools) {
          expect(tool.attributes['gen_ai.skill.name']).toBe('builtin:' + tool.attributes['gen_ai.tool.name']);
          expect(tool.attributes['test.service']).toBe(url.includes('4319') ? 'managed-openclaw' : 'test-openclaw');
          expect(tool.attributes['test.agent']).toBe('openclaw');
          expect(tool.ended).toBe(true);
          expect(tool.duration).toHaveLength(2);
        }
        expect(spans.filter(s => s.attributes['gen_ai.span.kind'] !== 'TOOL').every(s => !s.attributes['gen_ai.skill.name'])).toBe(true);
      }
      for (const folder of ['otlp-debug', 'otlp-failed']) {
        await vi.waitFor(async () => {
          const logDir = path.join(dir, 'logs', folder);
          const files = await readdir(logDir);
          const lines = (await Promise.all(files.map(f => readFile(path.join(logDir, f), 'utf8'))))
            .join('\n').split('\n').filter(Boolean).map(line => JSON.parse(line));
          expect(lines).toHaveLength(folder === 'otlp-debug' ? 20 : 10);
          const tools = lines.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
          expect(tools.length).toBeGreaterThan(0);
          expect(tools.every(s => s.attributes['gen_ai.skill.name'].startsWith('builtin:'))).toBe(true);
        });
      }
    } finally {
      await flusher.shutdown();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

const TRACE = '1234567890abcdef1234567890abcdef';
const START = BigInt(Date.now() - 60_000) * 1_000_000n;

function uri(id: string) {
  return { uri: `oss://bucket/${id}.png`, mime_type: 'image/png', modality: 'image' };
}

function user(parts: unknown[]) {
  return [{ role: 'user', parts }];
}

function records(steps: Array<{
  id: string;
  ms: number;
  responseId?: string;
  delta: unknown[];
  full?: unknown[];
  metadata: unknown[];
  deltaMetadata: unknown[];
  output?: unknown[];
}>): AgentActivityEntry[] {
  const base = {
    trace_id: TRACE,
    'gen_ai.agent.type': 'qwen-work-cn',
    'gen_ai.provider.name': 'qwen',
    'gen_ai.session.id': 'session-1',
    'gen_ai.turn.id': 'turn-1',
    'user.id': 'user-1',
    'gen_ai.request.model': 'test-model',
  };
  const events: AgentActivityEntry[] = [];
  for (const step of steps) {
    const time = String(START + BigInt(step.ms) * 1_000_000n);
    events.push({
      ...base,
      'event.id': `req-${step.id}`,
      'event.name': 'llm.request',
      'gen_ai.step.id': step.id,
      time_unix_nano: time,
      ...(step.responseId ? { 'gen_ai.response.id': step.responseId } : {}),
      'gen_ai.input.messages_delta': user(step.delta),
      ...(step.full ? { 'gen_ai.input.messages': user(step.full) } : {}),
      ...(step.metadata.length > 0 ? { 'gen_ai.input.multimodal_metadata': step.metadata } : {}),
      ...(step.deltaMetadata.length > 0 ? { 'gen_ai.input.multimodal_metadata_delta': step.deltaMetadata } : {}),
    } as unknown as AgentActivityEntry);
    events.push({
      ...base,
      'event.id': `resp-${step.id}`,
      'event.name': 'llm.response',
      'gen_ai.step.id': step.id,
      time_unix_nano: String(START + BigInt(step.ms + 1) * 1_000_000n),
      ...(step.responseId ? { 'gen_ai.response.id': step.responseId } : {}),
      'gen_ai.output.messages': step.output ?? [{ role: 'assistant', parts: [{ type: 'text', content: step.id }] }],
      'gen_ai.response.finish_reasons': ['stop'],
    } as unknown as AgentActivityEntry);
  }
  return events;
}

async function flushLlmSpans(input: AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    serviceName: 'multimodal-span-metadata',
    endpoints: [{ endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf',
  }, undefined, () => ({
    export(batch, callback) {
      spans.push(...batch);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  }));
  try {
    await flusher.sendBatch(input);
    await flusher.flush();
    return spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
  } finally {
    await flusher.shutdown();
  }
}

function metadata(span: ReadableSpan, key: string) {
  const value = span.attributes[key];
  return typeof value === 'string' ? JSON.parse(value) as unknown : undefined;
}

describe('multimodal summaries follow converted LLM spans', () => {
  it('keeps earlier images in the cumulative summary and only the current image in the delta', async () => {
    const imageA = uri('a');
    const imageB = uri('b');
    const spans = await flushLlmSpans(records([
      {
        id: 's1', ms: 10, responseId: 'r1',
        delta: [{ type: 'uri', ...imageA }],
        metadata: [imageA], deltaMetadata: [imageA],
      },
      {
        id: 's2', ms: 20, responseId: 'r2',
        delta: [{ type: 'text', content: 'bash output' }],
        metadata: [], deltaMetadata: [],
      },
      {
        id: 's3', ms: 30, responseId: 'r3',
        delta: [{ type: 'uri', ...imageB }],
        metadata: [imageB], deltaMetadata: [imageB],
      },
    ]));

    expect(spans).toHaveLength(3);
    const byResponse = new Map(spans.map(span => [span.attributes['gen_ai.response.id'], span]));
    expect(metadata(byResponse.get('r2')!, 'gen_ai.input.multimodal_metadata')).toEqual([imageA]);
    expect(byResponse.get('r2')!.attributes['gen_ai.input.multimodal_metadata_delta']).toBeUndefined();
    expect(metadata(byResponse.get('r3')!, 'gen_ai.input.multimodal_metadata')).toEqual([imageA, imageB]);
    expect(metadata(byResponse.get('r3')!, 'gen_ai.input.multimodal_metadata_delta')).toEqual([imageB]);
  });

  it('uses a full input snapshot instead of the union with earlier deltas', async () => {
    const imageA = uri('a');
    const imageB = uri('b');
    const spans = await flushLlmSpans(records([
      {
        id: 's1', ms: 10, responseId: 'r1',
        delta: [{ type: 'uri', ...imageA }],
        metadata: [imageA], deltaMetadata: [imageA],
      },
      {
        id: 's2', ms: 20, responseId: 'r2',
        delta: [{ type: 'uri', ...imageA }],
        full: [{ type: 'uri', ...imageB }],
        metadata: [imageA, imageB], deltaMetadata: [imageA],
      },
    ]));

    const snapshot = spans.find(span => span.attributes['gen_ai.response.id'] === 'r2');
    expect(metadata(snapshot!, 'gen_ai.input.multimodal_metadata')).toEqual([imageB]);
    expect(metadata(snapshot!, 'gen_ai.input.multimodal_metadata_delta')).toEqual([imageA]);
  });

  it('attaches summaries for a response without an id and does not swap adjacent ones', async () => {
    const imageA = uri('a');
    const imageB = uri('b');
    const spans = await flushLlmSpans(records([
      {
        id: 's1', ms: 10,
        delta: [{ type: 'uri', ...imageA }],
        metadata: [imageA], deltaMetadata: [imageA],
        output: [{ role: 'assistant', parts: [{ type: 'uri', ...imageA }] }],
      },
      {
        id: 's2', ms: 20,
        delta: [{ type: 'uri', ...imageB }],
        metadata: [imageB], deltaMetadata: [imageB],
        output: [{ role: 'assistant', parts: [{ type: 'uri', ...imageB }] }],
      },
    ]));

    expect(spans).toHaveLength(2);
    const ordered = [...spans].sort((left, right) => left.startTime[0] - right.startTime[0] || left.startTime[1] - right.startTime[1]);
    expect(metadata(ordered[0], 'gen_ai.input.multimodal_metadata')).toEqual([imageA]);
    expect(metadata(ordered[0], 'gen_ai.input.multimodal_metadata_delta')).toEqual([imageA]);
    expect(metadata(ordered[0], 'gen_ai.output.multimodal_metadata')).toEqual([imageA]);
    expect(metadata(ordered[1], 'gen_ai.input.multimodal_metadata')).toEqual([imageA, imageB]);
    expect(metadata(ordered[1], 'gen_ai.input.multimodal_metadata_delta')).toEqual([imageB]);
    expect(metadata(ordered[1], 'gen_ai.output.multimodal_metadata')).toEqual([imageB]);
    expect(ordered.every(span => span.attributes['gen_ai.response.id'] == null)).toBe(true);
  });
});
