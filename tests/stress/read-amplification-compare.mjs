import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// 同机、同 Node、同 runner、同夹具交替对照；临时数据与安装态完全隔离。
const args = process.argv.slice(2);
const option = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const baseline = option('--baseline-root');
assert(baseline, '必须指定 --baseline-root 隔离基线工作树');
const repeats = Number(option('--repeats', '5'));
assert(Number.isSafeInteger(repeats) && repeats >= 5, '正式对照至少执行 5 次');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(repo, 'tests/stress/read-amplification-stress.ts');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-io-comparison-'));
const results = Object.fromEntries(['growing', 'waves', 'peer', 'A', 'C', 'D', 'E'].map(mode => [mode, { baseline: [], candidate: [] }]));
const scaling = { 50: [], 100: [], 200: [] };

function execute(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['--prefix', repo, 'exec', '--offline', '--', 'tsx', runner, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`对照子进程失败 (${code ?? signal}): ${output}`)));
  });
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const median = values => percentile(values, 0.5);
const cpu = result => result.totalCpuUserMs + result.totalCpuSystemMs;
const read = result => result.startupReadBytes + [...result.warmup, ...result.metrics, ...result.drain].reduce((sum, metric) => sum + metric.readBytes, 0);
const allCpu = result => result.startupCpuMs + cpu(result)
  + [...result.warmup, ...result.drain].reduce((sum, metric) => sum + metric.cpuUserMs + metric.cpuSystemMs, 0);
const summaries = {};
let runnerSha256;
let passed = false;
try {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const mode of ['growing', 'waves', 'peer', 'idle']) {
      // 交替先后次序，避免把固定顺序的缓存/热机效应误当成收益。
      const order = repeat % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const variant of order) {
        const report = path.join(directory, `${mode}-${variant}-${repeat}.json`);
        const flags = ['--cycles', '100', '--paths', mode === 'idle' ? 'A,C,D,E' : 'B', '--complete', '--live-fork', '--report', report];
        if (mode === 'waves' || mode === 'peer') flags.push('--waves');
        if (mode === 'peer') flags.push('--peer');
        if (variant === 'baseline') flags.push('--source-root', path.resolve(baseline));
        else flags.push('--accept');
        await execute(flags);
        const document = JSON.parse(await fs.readFile(report, 'utf8'));
        assert.equal(document.node, process.version);
        assert.equal(document.results.length, mode === 'idle' ? 4 : 1);
        runnerSha256 ??= document.runnerSha256;
        assert.equal(document.runnerSha256, runnerSha256, '对照期间 runner 内容变化');
        for (const result of document.results) {
          results[mode === 'idle' ? result.path : mode][variant].push(result);
          console.log(`${repeat + 1}/${repeats} ${mode === 'idle' ? result.path : mode}/${variant}: CPU ${cpu(result).toFixed(1)} ms`);
        }
      }
    }
  }
  for (const mode of Object.keys(results)) {
    const base = results[mode].baseline;
    const candidate = results[mode].candidate;
    summaries[mode] = {
      baselineCpuMs: median(base.map(cpu)), candidateCpuMs: median(candidate.map(cpu)),
      baselineReadBytes: median(base.map(result => result.totalReadBytes)), candidateReadBytes: median(candidate.map(result => result.totalReadBytes)),
      baselineP95Ms: median(base.map(result => percentile(result.metrics.map(metric => metric.wallMs), 0.95))),
      candidateP95Ms: median(candidate.map(result => percentile(result.metrics.map(metric => metric.wallMs), 0.95))),
      allPhaseReadAmplification: median(candidate.map(result => read(result) / result.uniqueInputBytes)),
      baselineAllPhaseReadBytes: median(base.map(read)), candidateAllPhaseReadBytes: median(candidate.map(read)),
      baselineAllPhaseCpuMs: median(base.map(allCpu)), candidateAllPhaseCpuMs: median(candidate.map(allCpu)),
      baselineRunP95CpuMs: percentile(base.map(cpu), 0.95), candidateRunP95CpuMs: percentile(candidate.map(cpu), 0.95),
      candidatePeakHeapBytes: Math.max(...candidate.flatMap(result => [...result.warmup, ...result.metrics, ...result.drain].map(metric => metric.memory.heapUsed))),
      candidatePeakRssBytes: Math.max(...candidate.flatMap(result => [...result.warmup, ...result.metrics, ...result.drain].map(metric => metric.memory.rss))),
    };
    if (mode === 'waves' || mode === 'growing' || mode === 'peer') for (let index = 0; index < repeats; index++) {
      assert.equal(base[index].steadyEntries, candidate[index].steadyEntries, `${mode} 前缀事件数量不一致`);
      assert.deepEqual(base[index].eventFacts.slice(0, base[index].steadyEntries), candidate[index].eventFacts.slice(0, candidate[index].steadyEntries), `${mode} 前缀完整业务字段不一致`);
      assert.deepEqual(base[index].eventFacts, candidate[index].eventFacts, `${mode} terminal 排空后完整业务字段不一致`);
    }
    if (mode === 'peer') {
      for (const run of [...base, ...candidate]) assert.deepEqual([run.peer.published, run.peer.emitted], [100, 100], '并行 Input 丢失事件');
      summaries.peer.baselinePeerP95Ms = median(base.map(result => result.peer.p95Ms));
      summaries.peer.candidatePeerP95Ms = median(candidate.map(result => result.peer.p95Ms));
    }
    if ('ACDE'.includes(mode)) assert.equal(summaries[mode].candidateReadBytes, 0, `${mode} 静止回读未消除`);
  }
  assert(summaries.growing.candidateReadBytes <= summaries.growing.baselineReadBytes * 0.1, '增长场景读取降幅不足 90%');
  assert(summaries.growing.allPhaseReadAmplification <= 3, '计入启动、恢复和 hydrate 后读取超过 3x');
  assert(summaries.growing.candidateCpuMs <= summaries.growing.baselineCpuMs * 0.5, '增长场景 CPU 降幅不足 50%');
  assert(summaries.waves.candidateP95Ms <= summaries.waves.baselineP95Ms * 1.1, '普通多 wave p95 回退超过 10%');
  assert(summaries.peer.candidatePeerP95Ms <= summaries.peer.baselinePeerP95Ms * 1.1, '并行 Input p95 延迟回退超过 10%');
  // 相同每轮追加量，验证 50/100/200 轮的读量与解析成本随新增输入扩展。
  for (let repeat = 0; repeat < repeats; repeat++) for (const cycles of [50, 100, 200]) {
    const report = path.join(directory, `scaling-${cycles}-${repeat}.json`);
    await execute(['--cycles', String(cycles), '--paths', 'B', '--accept', '--report', report]);
    const document = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.equal(document.runnerSha256, runnerSha256);
    scaling[cycles].push(document.results[0]);
    console.log(`${repeat + 1}/${repeats} scaling/${cycles}: CPU ${cpu(document.results[0]).toFixed(1)} ms`);
  }
  summaries.scaling = Object.fromEntries(Object.entries(scaling).map(([cycles, runs]) => [cycles, {
    uniqueInputBytes: median(runs.map(result => result.uniqueInputBytes)), readBytes: median(runs.map(read)),
    cpuMs: median(runs.map(cpu)), cpuPerMiB: median(runs.map(result => cpu(result) / result.uniqueInputBytes * 1024 * 1024)),
    allPhaseReadAmplification: median(runs.map(result => read(result) / result.uniqueInputBytes)),
  }]));
  const small = summaries.scaling[50];
  const large = summaries.scaling[200];
  assert(large.readBytes / large.uniqueInputBytes <= small.readBytes / small.uniqueInputBytes * 1.2, '读取扩展超过线性范围');
  assert(large.cpuPerMiB <= small.cpuPerMiB * 1.5, '解析成本出现超线性增长');
  passed = true;
  console.log(JSON.stringify(summaries, null, 2));
} finally {
  const report = option('--report');
  if (report) {
    const summary = { node: process.version, platform: `${os.platform()}/${os.arch()}`,
      evidence: 'REAL_MEASURED', cpu: os.cpus()[0]?.model, runnerSha256, passed,
      repeats, baseline: path.resolve(baseline), summaries };
    await fs.writeFile(path.resolve(report), JSON.stringify({ ...summary, results, scaling }, null, 2));
    await fs.writeFile(path.resolve(`${report}.summary.json`), JSON.stringify(summary, null, 2));
  }
  await fs.rm(directory, { recursive: true, force: true });
}
