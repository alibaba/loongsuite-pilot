import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanEnricherRunner } from '../../../src/flushers/span-enricher.js';

let dir: string;
let provider: BasicTracerProvider;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pilot-enricher-test-'));
  provider = new BasicTracerProvider();
});
afterEach(async () => {
  await provider.shutdown();
  await rm(dir, { recursive: true, force: true });
});
async function plugin(name: string, body: string): Promise<string> {
  const file = path.join(dir, name + '.mjs');
  await writeFile(file, body);
  return file;
}
function finishedSpan() {
  const exporter = new InMemorySpanExporter();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const span = provider.getTracer('test').startSpan('execute_tool shell');
  span.setAttributes({ 'gen_ai.tool.name': 'shell', 'gen_ai.tool.arguments': '{"command":"ls"}', tags: ['original'] });
  span.end();
  return exporter.getFinishedSpans()[0];
}
const context = { agentType: 'codex', serviceName: 'test-codex' };

describe('SpanEnricherRunner', () => {
  it('loads ordered modules once, deduplicates symlinks, and preserves SDK getter fields', async () => {
    const first = await plugin('first', `let count = 0; export default { enrich(s, c) {
      count++; return { 'gen_ai.skill.name': s.attributes['gen_ai.tool.name'] + ':' + c.agentType, count };
    } };`);
    const alias = path.join(dir, 'alias.mjs');
    await symlink(first, alias);
    const second = await plugin('second', `export default { enrich(s) {
      return { 'gen_ai.skill.name': s.attributes['gen_ai.skill.name'] + ':next' };
    } };`);
    const runner = new SpanEnricherRunner([first, alias, second]);
    const original = finishedSpan();
    const [[a], [b]] = await Promise.all([runner.enrich([original], context), runner.enrich([original], context)]);
    expect(a.attributes).toMatchObject({ 'gen_ai.skill.name': 'shell:codex:next', count: 1 });
    expect(b.attributes.count).toBe(2);
    expect(original.attributes).not.toHaveProperty('gen_ai.skill.name');
    for (const key of ['duration', 'ended', 'droppedAttributesCount', 'droppedEventsCount', 'droppedLinksCount', 'resource', 'events', 'links'] as const) {
      expect(a[key]).toEqual(original[key]);
    }
    expect(a.spanContext()).toEqual(original.spanContext());
  });

  it('isolates loading, callback, and readonly-view failures and continues to the next plugin', async () => {
    const paths = [path.join(dir, 'missing.mjs')];
    paths.push(await plugin('syntax', 'this is invalid javascript!'));
    paths.push(await plugin('shape', 'export default {};'));
    paths.push(await plugin('throw', 'export default { enrich() { throw new Error("secret"); } };'));
    paths.push(await plugin('mutate', 'export default { enrich(s) { s.attributes.tags.push("bad"); } };'));
    paths.push(await plugin('good', 'export default { enrich() { return { ok: true }; } };'));
    const span = finishedSpan();
    const [result] = await new SpanEnricherRunner(paths).enrich([span], context);
    expect(result.attributes.ok).toBe(true);
    expect(result.attributes.tags).toEqual(['original']);
    expect(span.attributes.ok).toBeUndefined();
  });

  it.each(['null', '[]', '{ good: true, bad: {} }', '{ bad: NaN }', '{ bad: [1, "x"] }', 'JSON.parse(\'{"__proto__":"bad"}\')', 'Promise.reject(new Error("secret"))'])(
    'ignores invalid patches atomically: %s', async expression => {
      const file = await plugin('invalid', `export default { enrich() { return ${expression}; } };`);
      const span = finishedSpan();
      const [result] = await new SpanEnricherRunner([file]).enrich([span], context);
      expect(result).toBe(span);
    },
  );

  it('accepts valid scalar and homogeneous array attributes', async () => {
    const file = await plugin('valid', 'export default { enrich() { return { s: "x", n: 1, b: false, a: [1, null, 2], empty: [] }; } };');
    const [result] = await new SpanEnricherRunner([file]).enrich([finishedSpan()], context);
    expect(result.attributes).toMatchObject({ s: 'x', n: 1, b: false, a: [1, null, 2], empty: [] });
  });

  it('times out a pending module without blocking export', async () => {
    const file = await plugin('pending', 'await new Promise(() => {}); export default { enrich() {} };');
    const span = finishedSpan();
    expect(await new SpanEnricherRunner([file]).enrich([span], context)).toEqual([span]);
  });
});
