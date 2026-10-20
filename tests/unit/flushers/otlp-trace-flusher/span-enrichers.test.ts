import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
