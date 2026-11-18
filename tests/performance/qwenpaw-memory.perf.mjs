// Offline reproduction: no Agent, model credentials or cloud endpoint required.
// node tests/performance/qwenpaw-memory.perf.mjs [baseline-ref] [output-dir]
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = execFileSync('git', ['rev-parse', process.argv[2] ?? 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const output = path.resolve(process.argv[3] ?? path.join(root, 'node_modules/.cache/qwenpaw-memory'));
mkdirSync(output, { recursive: true });
const dependencies = realpathSync(process.env.QWENPAW_PERF_NODE_MODULES ?? path.join(root, 'node_modules'));
for (const variant of ['baseline', 'candidate']) {
  await build({ entryPoints: [path.join(root, 'tests/performance/qwenpaw-memory-worker.ts')],
    outfile: path.join(output, `${variant}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' },
    plugins: variant === 'baseline' ? [{ name: 'pinned-baseline', setup(api) {
      api.onLoad({ filter: /\.ts$/ }, args => {
        const relative = path.relative(root, args.path);
        if (!relative.startsWith('src/')) return;
        return { contents: execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 }), loader: 'ts' };
      });
    } }] : [],
  });
}
const results = [];
const cases = [
  { name: 'baseline-512', variant: 'baseline', memory: '512m', steps: 168, sink: 'count' },
  { name: 'candidate-512', variant: 'candidate', memory: '512m', steps: 168, sink: 'count' },
  { name: 'baseline-1024', variant: 'baseline', memory: '1024m', steps: 168, sink: 'count' },
  { name: 'candidate-http', variant: 'candidate', memory: '512m', steps: 168, sink: 'http' },
  { name: 'candidate-double', variant: 'candidate', memory: '512m', steps: 336, sink: 'http' },
];
for (const test of cases) {
  const name = `pilot-qwenpaw-perf-${process.pid}-${test.name}`;
  const spill = path.join(output, 'spill', test.name);
  mkdirSync(spill, { recursive: true, mode: 0o700 });
  const args = ['run', '--name', name, '--platform', 'linux/amd64', '--memory', test.memory,
    '--memory-swap', test.memory, '--network', 'none', '-e', 'LOG_LEVEL=silent',
    '-e', 'QWENPAW_PERF_DATA_DIR=/spill', '--mount', `type=bind,source=${spill},target=/spill`,
    '--mount', `type=bind,source=${path.join(output, `${test.variant}.mjs`)},target=/app/runner.mjs,readonly`,
    '--mount', `type=bind,source=${dependencies},target=/app/node_modules,readonly`,
    'node:24.14.0-bookworm-slim', 'node', '--max-old-space-size=2048', '/app/runner.mjs', String(test.steps), '1024', '64', test.sink];
  console.log(JSON.stringify({ starting: test }));
  let state;
  const started = Date.now();
  const execution = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 ** 2 });
  try {
    state = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .State}}', name], { encoding: 'utf8' }));
  } finally { spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }); }
  writeFileSync(path.join(output, `${test.name}.stdout.jsonl`), execution.stdout ?? '');
  writeFileSync(path.join(output, `${test.name}.stderr`), execution.stderr ?? '');
  const stages = (execution.stdout ?? '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = { ...test, elapsedMs: Date.now() - started, exitCode: execution.status, oomKilled: state.OOMKilled, stages };
  results.push(result);
  console.log(JSON.stringify({ finished: test.name, exitCode: result.exitCode, oomKilled: result.oomKilled, lastStage: stages.at(-1) }));
}
const completed = result => result.stages.find(stage => stage.stage === 'done');
const reference = completed(results.find(result => result.name === 'baseline-1024'));
const candidate = completed(results.find(result => result.name === 'candidate-512'));
const report = { baseline, nodeImage: 'node:24.14.0-bookworm-slim', platform: 'linux/amd64',
  configuration: { contextKiB: 1024, toolKiB: 64, maxOldSpaceMiB: 2048 },
  reproduced: results[0].oomKilled && results[0].exitCode === 137,
  lossless: !!reference && !!candidate && reference.spans === candidate.spans && reference.contentDigest === candidate.contentDigest,
  candidatesPassed: results.filter(result => result.variant === 'candidate').every(result => result.exitCode === 0 && !result.oomKilled && completed(result)),
  results, limitations: 'Synthetic canonical events through the real collector flusher. HTTP cases use a loopback OTLP protobuf receiver; no model or cloud calls. On arm64 hosts linux/amd64 emulation contributes to maxRSS; OOMKilled is the kernel/container result. Input-reader backlog and total host/Runtime memory are separate workloads.' };
writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: path.join(output, 'report.json'), reproduced: report.reproduced, lossless: report.lossless, candidatesPassed: report.candidatesPassed }));
if (!report.reproduced || !report.lossless || !report.candidatesPassed) process.exitCode = 1;
