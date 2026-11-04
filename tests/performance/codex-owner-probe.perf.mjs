// Offline owner-probe benchmark. Run the same script with --source-root pointing
// at each checkout; timings are descriptive, content-read counters are exact.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const options = { sourceRoot: process.cwd(), files: 2056, cycles: 3 };
const flags = { '--source-root': 'sourceRoot', '--files': 'files', '--cycles': 'cycles',
  '--total-bytes': 'totalBytes', '--output': 'output' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = flags[process.argv[i]];
  if (!key || process.argv[i + 1] === undefined) {
    throw new Error('Usage: node codex-owner-probe.perf.mjs [--source-root PATH] [--files N] [--total-bytes N] [--cycles N] [--output PATH]');
  }
  options[key] = ['files', 'cycles', 'totalBytes'].includes(key) ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
for (const key of ['files', 'cycles', 'totalBytes']) {
  if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < 1)) {
    throw new Error(`${key} must be a positive safe integer`);
  }
}
options.sourceRoot = path.resolve(options.sourceRoot);
options.totalBytes ??= options.files * 4096;
if (!Number.isSafeInteger(options.totalBytes) || options.totalBytes < options.files * 128) {
  throw new Error('total-bytes must allow at least 128 bytes per file');
}

const scriptRoot = fileURLToPath(new URL('../../', import.meta.url));
// External ESM dependencies resolve through this repository's node_modules.
const cache = path.join(scriptRoot, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const compiled = mkdtempSync(path.join(cache, 'codex-owner-probe-'));
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'codex-owner-probe-data-'));
const sourceImport = relative => JSON.stringify(path.join(options.sourceRoot, relative));
const worker = `
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StateStore } from ${sourceImport('src/checkpoints/state-store.ts')};
import { CodexTranscriptInput } from ${sourceImport('src/inputs/codex-transcript/codex-transcript-input.ts')};
import { InputRuntimeAccumulator } from ${sourceImport('src/inputs/base/input-runtime-metrics.ts')};

const opts = JSON.parse(process.argv[2]);
const root = process.argv[3];
const sessions = path.join(root, 'sessions');
await fs.mkdir(sessions, { recursive: true });
const baseBytes = Math.floor(opts.totalBytes / opts.files);
const remainder = opts.totalBytes % opts.files;
const newline = String.fromCharCode(10);
const empty = JSON.stringify({ type: 'event_msg', payload: { type: 'historical_without_owner', padding: '' } }) + newline;
let writtenBytes = 0;
for (let start = 0; start < opts.files; start += 64) {
  await Promise.all(Array.from({ length: Math.min(64, opts.files - start) }, (_, j) => {
    const index = start + j;
    const size = baseBytes + (index < remainder ? 1 : 0);
    const body = JSON.stringify({ type: 'event_msg', payload: { type: 'historical_without_owner',
      padding: 'x'.repeat(size - Buffer.byteLength(empty)) } }) + newline;
    const bytes = Buffer.from(body);
    if (bytes.at(-1) !== 0x0a || bytes.length !== size) throw new Error('Invalid JSONL fixture newline or byte length');
    JSON.parse(bytes.toString('utf8').trim());
    writtenBytes += bytes.length;
    return fs.writeFile(path.join(sessions, 'rollout-missing-' + String(index).padStart(8, '0') + '.jsonl'), bytes);
  }));
}
if (writtenBytes !== opts.totalBytes) throw new Error('Fixture total bytes differ from requested workload');
let events = 0;
function create(state) {
  const input = new CodexTranscriptInput({ stateStore: state, sessionDir: sessions,
    wakeupDir: path.join(root, 'wakeups'), spanContextDir: path.join(root, 'contexts') });
  input.on('entries', batch => { events += batch.length; });
  return input;
}
async function measure(input, action) {
  const runtime = new InputRuntimeAccumulator();
  input.activeRuntimeAccumulator = runtime;
  const beforeEvents = events;
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  try {
    const entries = await action();
    if (Array.isArray(entries)) events += entries.length;
  } finally {
    input.activeRuntimeAccumulator = null;
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(beforeCpu);
  const delta = runtime.finish(wallMs);
  const row = { wallMs, cpuMs: (cpu.user + cpu.system) / 1000,
    raw_read_bytes: delta.rawReadBytes, raw_read_calls: delta.rawReadCalls,
    raw_in_bytes: delta.rawInBytes, raw_in_records: delta.rawInRecords, events: events - beforeEvents };
  if (row.raw_in_bytes !== 0 || row.events !== 0) throw new Error('Synthetic historical files unexpectedly produced new input or events');
  return row;
}
const stateFile = path.join(root, 'state.json');
const state = new StateStore(stateFile);
const input = create(state);
const rows = [];
try {
  rows.push({ phase: 'startup', ...await measure(input, () => input.onStart()) });
  for (let cycle = 1; cycle <= opts.cycles; cycle++) {
    rows.push({ phase: 'collect', cycle, ...await measure(input, () => input.collect()) });
  }
  await state.save();
} finally {
  await input.onStop();
}
const restored = new StateStore(stateFile);
await restored.load();
const restarted = create(restored);
try {
  rows.push({ phase: 'restart-startup', ...await measure(restarted, () => restarted.onStart()) });
  rows.push({ phase: 'restart-collect', ...await measure(restarted, () => restarted.collect()) });
} finally {
  await restarted.onStop();
}
process.stdout.write(JSON.stringify({ fixtureValidated: true, writtenBytes, rows }));
`;

try {
  const outfile = path.join(compiled, 'worker.mjs');
  await build({ stdin: { contents: worker, resolveDir: options.sourceRoot, sourcefile: 'owner-probe-workload.mjs' },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' } });
  const output = execFileSync(process.execPath, [outfile, JSON.stringify(options), dataRoot], {
    cwd: options.sourceRoot, env: { ...process.env, LOG_LEVEL: 'silent' },
    encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 ** 2,
  });
  let commit = 'unknown';
  let sourceWorkingTreeDirty = null;
  const gitOptions = { cwd: options.sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim();
    sourceWorkingTreeDirty = execFileSync('git', ['status', '--porcelain'], gitOptions).trim().length > 0;
  } catch {}
  const report = { sourceRoot: options.sourceRoot, commit, sourceWorkingTreeDirty, node: process.version,
    workload: { files: options.files, totalBytes: options.totalBytes, cycles: options.cycles, ownerMetadata: false },
    ...JSON.parse(output), limitations: 'Synthetic static JSONL; real Input/StateStore/accumulator, no user transcript or network. Startup reconstructs baselines; collect excludes state-file save. Restart loads persisted state before timing. CPU and wall time vary with host load; no timing threshold.' };
  if (options.output) {
    const target = path.resolve(options.output);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(compiled, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
}
