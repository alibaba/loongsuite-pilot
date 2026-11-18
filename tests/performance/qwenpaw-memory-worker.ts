// Synthetic QwenPaw lifecycles, through the production flusher and OTLP exporter.
// Build with esbuild (packages external), then run in a memory-limited container.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { OtlpTraceFlusher, type OtlpExporterFactory } from '../../src/flushers/otlp-trace-flusher.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { AgentActivityEntry } from '../../src/types/index.js';

const steps = Number(process.argv[2] ?? 168);
const contextKiB = Number(process.argv[3] ?? 1024);
const toolKiB = Number(process.argv[4] ?? 64);
const sink = process.argv[5] ?? 'count';
const cms = process.env.QWENPAW_PERF_CMS_CONFIG
  ? JSON.parse(readFileSync(process.env.QWENPAW_PERF_CMS_CONFIG, 'utf8')).cms : undefined;
const expectedWorkspace = process.env.QWENPAW_PERF_CMS_WORKSPACE;
if (sink === 'cms' && (!expectedWorkspace || !cms?.endpoint || !cms?.licenseKey || cms?.workspace !== expectedWorkspace)) {
  throw new Error('CMS fixture requires the verified test workspace configuration');
}
const sessionId = process.env.QWENPAW_PERF_SESSION ?? 'synthetic-session';
const runId = process.env.QWENPAW_PERF_RUN ?? 'synthetic-run';
const date = BigInt(Date.now() - 20 * 60_000) * 1_000_000n;
let counter = 0;
let spans = 0;
let wireBytes = 0;
let batches = 0;
let exportFailures = 0;
const kinds: Record<string, number> = {};
const parents = new Map<string, string>();
const ids = new Set<string>();
const traceIds = new Set<string>();
const contentHash = createHash('sha256');
const report = (stage: string, extra = {}) => console.log(JSON.stringify({
  stage, ...extra, memory: process.memoryUsage(), peakRssBytes: process.resourceUsage().maxRSS * 1024,
}));
const receiver = createServer((req, res) => {
  req.on('data', chunk => { wireBytes += chunk.length; });
  req.on('end', () => { batches++; res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(); });
});
await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
const port = (receiver.address() as { port: number }).port;
const exporter: OtlpExporterFactory = options => {
  const delegate = sink !== 'count' ? new OTLPTraceExporter({ url: options.url, headers: options.headers, compression: options.compression }) : undefined;
  return {
  export(batch, done) {
    if (!spans) report('first_export');
    if (!delegate) batches++;
    for (const span of batch) {
      spans++;
      const kind = String(span.attributes['gen_ai.span.kind']);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      ids.add(span.spanContext().spanId);
      traceIds.add(span.spanContext().traceId);
      if (span.parentSpanId) parents.set(span.spanContext().spanId, span.parentSpanId);
      contentHash.update(JSON.stringify(span.attributes));
    }
    if (delegate) delegate.export(batch, result => { if (result.code !== 0) exportFailures++; done(result); });
    else done({ code: 0 });
  },
  shutdown: async () => { await delegate?.shutdown(); },
  };
};
const journal = process.env.QWENPAW_PERF_JOURNAL === '1'
  ? new CodexTurnJournal(path.join(process.env.QWENPAW_PERF_DATA_DIR!, 'qwenpaw-journal'), 10_000, ['qwenpaw'])
  : undefined;
const flusher = new OtlpTraceFlusher({
  enabled: true, serviceName: process.env.QWENPAW_PERF_SERVICE ?? 'qwenpaw-oom-synthetic', protocol: 'http/protobuf',
  dataDir: process.env.QWENPAW_PERF_DATA_DIR,
  appendAgentTypeToServiceName: false,
  endpoints: [sink === 'cms' ? { name: 'cms', endpoint: cms.endpoint,
    headers: { 'x-arms-license-key': cms.licenseKey, 'x-cms-workspace': cms.workspace } }
    : { name: 'local', endpoint: `http://127.0.0.1:${port}/v1/traces` }],
  maxExportBatchBytes: 4 * 1024 * 1024, debug: false,
}, undefined, exporter, journal);
const hex = (n: number) => n.toString(16).padStart(16, '0');
function event(kind: string, id: number, parent: number, phase: string, ms: number, fields = {}): AgentActivityEntry {
  return {
    time_unix_nano: String(date + BigInt(ms) * 1_000_000n), 'event.id': `event-${counter++}`,
    'event.name': kind === 'llm' ? (phase === 'start' ? 'llm.request' : 'llm.response')
      : kind === 'tool' ? (phase === 'start' ? 'tool.call' : 'tool.result') : 'other',
    'user.id': 'synthetic', 'gen_ai.agent.type': 'qwenpaw',
    'gen_ai.session.id': sessionId, 'gen_ai.turn.id': runId, 'gen_ai.conversation.id': sessionId,
    'gen_ai.agent.name': 'synthetic-agent', 'gen_ai.agent.id': 'synthetic-agent',
    'gen_ai.request.model': 'synthetic-model', 'gen_ai.provider.name': 'synthetic',
    'agent.qwenpaw.span.id': hex(id), 'agent.qwenpaw.parent.id': parent ? hex(parent) : '',
    ...(['entry', 'agent', 'step'].includes(kind) ? { 'agent.qwenpaw.boundary': `${kind}.${phase}` } : {}),
    ...fields,
  } as AgentActivityEntry;
}
const message = (text: string) => [{ role: 'user', parts: [{ type: 'text', content: text }] }];
report('start', { node: process.version, arch: process.arch, steps, contextKiB, toolKiB, sink, journal: !!journal });
await flusher.sendBatch([
  event('entry', 1, 0, 'start', 0, { 'gen_ai.input.messages': message('Synthetic long-turn memory fixture') }),
  event('agent', 2, 1, 'start', 1),
]);
for (let step = 0; step < steps; step++) {
  const id = 3 + step * 3;
  const t = 10 + step * 6000;
  // Parse independent payloads, as a JSONL reader does. Shared string fixtures
  // otherwise hide the memory cost of repeated model histories.
  const input = JSON.parse(JSON.stringify(message(`${step}:` + 'x'.repeat(contextKiB * 1024))));
  const batch = [
    event('step', id, 2, 'start', t),
    event('llm', id + 1, id, 'start', t + 1, { 'gen_ai.input.messages': input }),
    event('llm', id + 1, id, 'end', t + 2000, {
      'gen_ai.output.messages': [{ role: 'assistant', parts: step === steps - 1
        ? [{ type: 'text', content: `answer-${step}` }]
        : [{ type: 'tool_call', id: `call-${step}`, name: 'synthetic_tool', arguments: { step } }] }],
      'gen_ai.usage.input_tokens': 1000 + step, 'gen_ai.usage.output_tokens': 20,
      'gen_ai.response.finish_reasons': [step === steps - 1 ? 'stop' : 'tool_calls'],
    }),
  ];
  if (step < steps - 1) batch.push(
    event('tool', id + 2, id, 'start', t + 2001, { 'gen_ai.tool.name': 'synthetic_tool', 'gen_ai.tool.call.id': `call-${step}`, 'gen_ai.tool.call.arguments': { step } }),
    event('tool', id + 2, id, 'end', t + 4000, { 'gen_ai.tool.call.result': { text: `${step}:` + 'y'.repeat(toolKiB * 1024) } }),
  );
  batch.push(event('step', id, 2, 'end', t + 5000));
  await flusher.sendBatch(batch);
  if ((step + 1) % 42 === 0) report('buffering', { stepsBuffered: step + 1 });
}
report('before_terminal');
await flusher.sendBatch([
  event('agent', 2, 1, 'end', steps * 6000 + 20, {
    'gen_ai.usage.input_tokens': steps * 1000 + steps * (steps - 1) / 2,
    'gen_ai.usage.output_tokens': steps * 20,
  }),
  event('entry', 1, 0, 'end', steps * 6000 + 21, { 'gen_ai.turn.end': true }),
]);
await flusher.flush();
await flusher.shutdown();
await new Promise<void>(resolve => receiver.close(() => resolve()));
const missingParents = [...parents.values()].filter(parent => !ids.has(parent)).length;
if (spans !== steps * 3 + 1 || missingParents || traceIds.size !== 1 || exportFailures) throw new Error('Trace content/topology/export mismatch');
report('done', { spans, kinds, batches, wireBytes, missingParents, exportFailures, traceCount: traceIds.size, contentDigest: contentHash.digest('hex') });
