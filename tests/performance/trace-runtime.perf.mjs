// Offline A/B: real InputManager -> MultiFlusher -> converter, no network I/O.
// Run with Node 22: node tests/performance/trace-runtime.perf.mjs [baseline-ref] [runs]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = execFileSync('git', ['rev-parse', process.argv[2] ?? 'origin/main'], { cwd: root, encoding: 'utf8' }).trim();
const runs = Number(process.argv[3] ?? 5);
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('runs must be 1..20');
const cache = path.join(root, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(path.join(cache, 'trace-runtime-perf-'));

const workload = `
import { createHash } from 'node:crypto';
import { InputManager } from './src/core/input-manager.ts';
import { BaseFlusher } from './src/flushers/base-flusher.ts';
import { MultiFlusher } from './src/flushers/multi-flusher.ts';
import { OtlpTraceFlusher } from './src/flushers/otlp-trace-flusher.ts';

const scenario = process.argv[2];
const short = scenario === 'short-turns';
const large = scenario === 'large-events';
const count = large ? 2000 : short ? 12000 : 10000;
const payload = 'x'.repeat(large ? 32768 : short ? 128 : 2048);
const eventHash = createHash('sha256');
const traceHash = createHash('sha256');
let exportedSpans = 0;
let exportedEvents = 0;
class EventSink extends BaseFlusher {
  name = 'synthetic-json';
  async send(entry) { eventHash.update(JSON.stringify(entry)); exportedEvents++; }
  async sendBatch(entries) { for (const entry of entries) await this.send(entry); }
  async flush() {}
  async shutdown() {}
}
const trace = new OtlpTraceFlusher({
  enabled: true, serviceName: 'synthetic', protocol: 'http/protobuf',
  endpoints: (short ? ['user', 'inner'] : ['single']).map(name => ({ name, serviceName: name, endpoint: 'http://unused:4318' })),
}, undefined, opts => ({
  export(spans, callback) {
    // Random Span IDs are intentionally excluded; content, timing and topology remain checked.
    const positions = new Map(spans.map((span, i) => [span.spanContext().spanId, i]));
    for (const span of spans) {
      traceHash.update(JSON.stringify({ destination: opts.name, name: span.name, kind: span.kind,
        attributes: span.attributes, start: span.startTime, end: span.endTime, status: span.status,
        trace: span.spanContext().traceId,
        parent: span.parentSpanId ? (positions.get(span.parentSpanId) ?? 'external') : null }));
      exportedSpans++;
    }
    callback({ code: 0 });
  }, shutdown: async () => undefined,
}));
const multi = new MultiFlusher([new EventSink(), trace]);
const manager = new InputManager();
manager.setFlusher(multi);
manager.setUserId('synthetic');
function entry(i) {
  const turn = short ? Math.floor(i / 2) : i % 8;
  const request = short && i % 2 === 0;
  return {
    'event.id': 'event-' + i, 'event.name': request ? 'llm.request' : 'llm.response',
    'gen_ai.agent.type': 'opencode', 'gen_ai.session.id': short ? 'session' : 'session-' + turn,
    'gen_ai.turn.id': 'turn-' + turn, 'gen_ai.step.id': 'step-' + (short ? turn : i),
    trace_id: turn.toString(16).padStart(32, '1'),
    time_unix_nano: String(1780000000000000000n + BigInt(i) * 1000000n),
    'gen_ai.request.model': 'synthetic-model',
    'gen_ai.output.messages': payload,
    ...(short && !request ? { 'gen_ai.response.finish_reasons': ['stop'] } : {}),
  };
}
global.gc?.();
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < count; i += 100) {
  const batch = Array.from({ length: Math.min(100, count - i) }, (_, j) => entry(i + j));
  await manager.handleEntries('synthetic-input', batch);
  if (i % 1000 === 0) trace.getTraceRuntimeSnapshot?.();
}
await multi.shutdown();
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const peakRssBytes = process.resourceUsage().maxRSS * 1024;
console.log(JSON.stringify({ scenario, count, payloadBytes: payload.length,
  elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, peakRssBytes,
  exportedEvents, exportedSpans, eventDigest: eventHash.digest('hex'), traceDigest: traceHash.digest('hex') }));
`;

try {
  for (const variant of ['baseline', 'modified']) {
    await build({
      stdin: { contents: workload, resolveDir: root, sourcefile: 'trace-runtime-workload.ts', loader: 'ts' },
      outfile: path.join(temporary, `${variant}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external',
      define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' },
      plugins: variant === 'baseline' ? [{
        name: 'fixed-git-baseline',
        setup(api) {
          api.onLoad({ filter: /\.ts$/ }, args => {
            const relative = path.relative(root, args.path);
            if (!relative.startsWith('src/')) return;
            return { contents: execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 }), loader: 'ts' };
          });
        },
      }] : [],
    });
  }
  const results = [];
  for (const scenario of ['long-turns', 'short-turns', 'large-events']) {
    for (let run = 0; run < runs; run++) {
      for (const variant of run % 2 ? ['modified', 'baseline'] : ['baseline', 'modified']) {
        const output = execFileSync(process.execPath, ['--expose-gc', path.join(temporary, `${variant}.mjs`), scenario], {
          cwd: root, env: { ...process.env, LOG_LEVEL: 'silent' }, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 ** 2,
        });
        results.push({ variant, run, ...JSON.parse(output.trim().split('\n').at(-1)) });
      }
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summaries = ['long-turns', 'short-turns', 'large-events'].map(scenario => {
    const rows = results.filter(row => row.scenario === scenario);
    for (const field of ['exportedEvents', 'exportedSpans', 'eventDigest', 'traceDigest']) {
      if (new Set(rows.map(row => row[field])).size !== 1) throw new Error(`${scenario}: ${field} differs across runs`);
    }
    const values = Object.fromEntries(['baseline', 'modified'].map(variant => [variant, Object.fromEntries(
      ['cpuMs', 'elapsedMs', 'peakRssBytes'].map(field => [field, median(rows.filter(row => row.variant === variant).map(row => row[field]))]),
    )]));
    return { scenario, outputIdentical: true, ...values,
      cpuDeltaPercent: (values.modified.cpuMs / values.baseline.cpuMs - 1) * 100,
      peakRssDeltaMiB: (values.modified.peakRssBytes - values.baseline.peakRssBytes) / 1024 ** 2 };
  });
  const report = { baseline, node: process.version, runs, summaries, results,
    limitations: 'Synthetic data, no real agent/file readers or network latency. Max RSS is process peak including module startup; CPU/wall cover the real InputManager, output hashing and converter. Not an installed or online validation.' };
  if (process.env.TRACE_RUNTIME_PERF_REPORT) writeFileSync(process.env.TRACE_RUNTIME_PERF_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ baseline, node: process.version, runs, summaries }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
