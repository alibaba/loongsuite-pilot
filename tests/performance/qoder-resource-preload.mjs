// Test-only observation/safety wrapper; never installed in Agent hooks.
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const directory = process.env.QODER_PERF_CASE;
const log = directory + '/audit.jsonl';
const transcript = process.env.QODER_PERF_TRANSCRIPT;
const generation = Number(process.env.QODER_PERF_GENERATION ?? 0);
const read = fs.readFileSync;
const spawn = cp.spawn;
const emit = value => fs.appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, ...value }) + '\n');
emit({ event: 'start', node: process.version, retry: process.argv.includes('--retry') });
process.once('exit', () => emit({ event: 'exit', maxRSSKiB: process.resourceUsage().maxRSS, cpu: process.cpuUsage() }));
fs.readFileSync = function(file, ...args) {
  const result = read.call(this, file, ...args);
  if (String(file) === transcript) emit({ event: 'full-read', bytes: Buffer.byteLength(result) });
  return result;
};
cp.spawn = function(command, args, options) {
  if (args?.includes('--retry')) {
    // Safety limits do not change normal delay/lock behavior. A tripped guard
    // invalidates the run; never stress the host until it exhausts memory.
    if (generation >= 3 || fs.existsSync(directory + '/stop')) throw new Error('performance safety guard');
    let slot = false;
    for (let index = 0; index < 64; index++) {
      try { fs.closeSync(fs.openSync(directory + '/slots/' + index, 'wx')); slot = true; break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!slot) { emit({ event: 'guard' }); throw new Error('performance spawn cap'); }
    options = { ...options, env: { ...options.env, QODER_PERF_GENERATION: String(generation + 1) } };
  }
  const child = spawn.call(this, command, args, options);
  emit({ event: 'spawn', childPid: child.pid });
  return child;
};
syncBuiltinESMExports();
