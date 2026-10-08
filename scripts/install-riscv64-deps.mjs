#!/usr/bin/env node
// Shared by the Unix installer and updater. Native failure must not remove JS deps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const INSTALL_BUDGET_MS = 30 * 60_000;
// Match the packages' published N-API targets, both supported by Node18.
export const NATIVE_API_VERSIONS = { sqlite3: 6, 'zstd-napi': 8 };

export function runCommand(executable, args, { cwd, env, timeoutMs, logPath, outputLimitBytes = Infinity }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Command timeout must be positive');
  return new Promise(resolve => {
    // Open before spawning: an unwritable log must not leave a detached compiler.
    const fd = fs.openSync(logPath, 'a');
    const log = fs.createWriteStream(logPath, { fd, autoClose: true });
    const logClosed = new Promise(done => log.once('close', done));
    const started = Date.now();
    const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false, interrupted = false, terminating = false, childClosed = false, spawnError, killTimer;
    const terminate = () => {
      terminating = true;
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') spawnError = String(error); }
      killTimer ??= setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 5000);
    };
    const onSignal = () => { interrupted = true; terminate(); };
    process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    log.on('error', error => {
      spawnError = `Cannot write command log ${logPath}: ${error.message}`;
      if (!childClosed) terminate();
    });
    let forwarded = 0;
    let outputTruncated = false;
    const capture = chunk => {
      log.write(chunk);
      const count = Math.min(chunk.length, Math.max(0, outputLimitBytes - forwarded));
      if (count) { process.stdout.write(chunk.subarray(0, count)); forwarded += count; }
      if (count < chunk.length && !outputTruncated) {
        outputTruncated = true;
        process.stdout.write(`\n[pilot-native] Further output is saved in ${logPath}\n`);
      }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { spawnError = String(error); });
    child.once('close', async (exitCode, signal) => {
      childClosed = true;
      // A parent may exit before a compiler descendant. Reap this process group
      // on timeout/interruption even if its leader has already exited.
      if (terminating && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      }
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
      log.end();
      await logClosed;
      resolve({ exit_code: exitCode, signal, timed_out: timedOut, interrupted,
        error: spawnError, output_truncated: outputTruncated, elapsed_ms: Date.now()-started });
    });
  });
}

function probeProgram(module) {
  if (module === 'sqlite3') return `const s=require('sqlite3');const d=new s.Database(':memory:');d.get('SELECT 42 AS answer',(e,r)=>{if(e)throw e;if(r.answer!==42)throw new Error('SQL probe failed');d.close(e=>{if(e)throw e;console.log('sqlite3 query passed')})})`;
  return `const z=require('zstd-napi');const b=Buffer.from('pilot-native-install');if(!z.decompress(z.compress(b)).equals(b))throw new Error('zstd roundtrip failed');console.log('zstd roundtrip passed')`;
}

export async function installRiscv64Dependencies({ packageDir, logDir, budgetMs = INSTALL_BUDGET_MS,
  nodeBin = process.execPath, npmBin }) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Installation budget must be positive');
  packageDir = path.resolve(packageDir);
  fs.accessSync(path.join(packageDir, 'package.json'));
  const runDir = path.join(path.resolve(logDir), `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
  fs.mkdirSync(runDir, { recursive: true });
  const deadline = Date.now() + budgetMs;
  const nodeRoot = path.dirname(path.dirname(fs.realpathSync(nodeBin)));
  const env = { ...process.env, PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ''}`, npm_config_jobs: '4' };
  if (!npmBin) {
    const adjacent = path.join(path.dirname(nodeBin), 'npm');
    try { fs.accessSync(adjacent, fs.constants.X_OK); npmBin = adjacent; }
    catch { npmBin = 'npm'; } // Match the installer's fallback to npm on PATH.
  }
  // Binary tarballs include headers; distro installations may use node-gyp's
  // normal header acquisition. Never claim a sysroot is a full target runtime.
  if (fs.existsSync(path.join(nodeRoot, 'include/node/node.h'))) env.npm_config_nodedir = nodeRoot;
  const report = { schema: 1, started_at: new Date().toISOString(), arch: process.arch,
    node: process.version, node_bin: nodeBin, npm_bin: npmBin, napi_build_versions: NATIVE_API_VERSIONS, log_dir: runDir,
    status: 'failed', modules: {} };
  const remaining = cap => Math.max(1, Math.min(cap, deadline-Date.now()));
  try {
    report.dependencies = await runCommand(npmBin,
      ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: packageDir, env, timeoutMs: remaining(5*60_000), outputLimitBytes: 64*1024,
        logPath: path.join(runDir, 'npm-install.log') });
    if (report.dependencies.exit_code !== 0 || report.dependencies.timed_out || report.dependencies.interrupted || report.dependencies.error) {
      throw new Error('JavaScript dependency installation failed; native degradation cannot recover missing JS dependencies');
    }
    for (const module of ['sqlite3', 'zstd-napi']) {
      const item = {};
      report.modules[module] = item;
      if (Date.now() < deadline) {
        item.build = await runCommand(npmBin, ['rebuild', module, '--foreground-scripts'], {
          cwd: packageDir, env: { ...env, npm_config_build_from_source: 'true',
            npm_config_napi_build_version: String(NATIVE_API_VERSIONS[module]) },
          timeoutMs: remaining(20*60_000), outputLimitBytes: 64*1024, logPath: path.join(runDir, `${module}-build.log`),
        });
        if (item.build.interrupted) throw new Error('Native dependency installation interrupted');
      } else item.build = { skipped: 'total installation budget exhausted' };
      // Probe in a child: an incompatible ABI can SIGSEGV instead of throwing.
      item.probe = await runCommand(nodeBin, ['-e', probeProgram(module)], {
        cwd: packageDir, env, timeoutMs: remaining(30_000), outputLimitBytes: 64*1024,
        logPath: path.join(runDir, `${module}-probe.log`),
      });
      if (item.probe.interrupted) throw new Error('Native capability probe interrupted');
      item.available = item.probe.exit_code === 0 && !item.probe.timed_out && !item.probe.error;
      console.log(`[pilot-native] ${module}: ${item.available ? 'available' : 'unavailable; continuing with reduced capabilities'}`);
    }
    report.status = Object.values(report.modules).every(item=>item.available) ? 'ready' : 'degraded';
    return report;
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    report.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2)+'\n');
    console.log(`[pilot-native] status=${report.status}; diagnostics=${path.join(runDir, 'result.json')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'linux' || process.arch !== 'riscv64') throw new Error('This installer helper is for Linux riscv64');
    const args = process.argv.slice(2);
    const options = {};
    while (args.length) {
      const name = args.shift(); const value = args.shift();
      const key = { '--package-dir': 'packageDir', '--log-dir': 'logDir', '--npm-bin': 'npmBin' }[name];
      if (!value || !key) throw new Error('Usage: install-riscv64-deps.mjs --package-dir DIR --log-dir DIR [--npm-bin FILE]');
      options[key] = value;
    }
    if (!options.packageDir || !options.logDir) throw new Error('Both --package-dir and --log-dir are required');
    await installRiscv64Dependencies(options);
  } catch (error) { console.error(`[pilot-native] ${error.message}`); process.exitCode = 1; }
}
