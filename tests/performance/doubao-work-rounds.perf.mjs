// Synthetic collector CPU benchmark; it sends no traffic and reads no user data.
// Run with Node.js 22+: node tests/performance/doubao-work-rounds.perf.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-rounds-perf-'));
try {
  const bundle = path.join(temporary, 'rounds.cjs');
  await build({
    stdin: { contents: `export {parseNativeContent} from './src/inputs/doubao-work/doubao-work-content.ts';
export {reconstructNativeRounds} from './src/inputs/doubao-work/doubao-work-rounds.ts';`, resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent',
  });
  const worker = path.join(temporary, 'worker.cjs');
  await fs.writeFile(worker, `
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {performance} = require('node:perf_hooks');
const api = require(${JSON.stringify(bundle)});
(async () => {
  const count = Number(process.argv[2]), actor = 'm_main', query = Date.UTC(2026, 9, 28);
  const rows = [{role:'user', content:'OLD'}];
  for (let i = 0; i < count; i++) rows.push({role:i % 2 ? 'assistant' : 'user', content:String(i)+':'+ 'x'.repeat(64)});
  rows.push({role:'user',content:'CURRENT'}, {role:'assistant',content:'FINAL'});
  const raw = rows.map(row => JSON.stringify(row)).join('\\n')+'\\n';
  const assignment = '## ['+new Date(query-1000).toISOString()+'] 需求\\nOLD\\n\\n## ['+new Date(query+1).toISOString()+'] 需求\\nCURRENT\\n';
  const content = api.parseNativeContent({[actor]:raw}, {[actor]:assignment});
  const timerStart = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now()-timerStart), 0));
  const cpuStart = process.cpuUsage(), start = performance.now();
  const value = api.reconstructNativeRounds(content,actor,query,String(BigInt(query+5000)*1000000n),[]);
  const wallMs = performance.now()-start, cpu = process.cpuUsage(cpuStart);
  assert.equal(value.rounds.length,1); assert.equal(value.rounds[0].sourceIndex,count+2);
  const encoded = JSON.stringify(value);
  console.log(JSON.stringify({historicRows:count, rawBytes:Buffer.byteLength(raw), wallMs,
    cpuMs:(cpu.user+cpu.system)/1000, timerDelayMs:await timer,
    rssMiB:process.memoryUsage().rss/1048576, maxRSSMiB:process.resourceUsage().maxRSS/1024,
    outputBytes:Buffer.byteLength(encoded), outputSha256:createHash('sha256').update(encoded).digest('hex')}));
})().catch(error => {console.error(error);process.exitCode=1;});
`);
  const results = [];
  for (const count of [4000, 8000, 16000]) {
    const child = spawnSync(process.execPath, [worker, String(count)], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
    if (child.error || child.status !== 0) throw child.error ?? new Error(child.stderr || `Benchmark exited ${child.status}`);
    results.push(JSON.parse(child.stdout));
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model,
    scope: 'Synthetic reconstruction only; timer delay is not client latency.', results }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
