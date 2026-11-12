/**
 * Legacy parser contract tests now exercise two installed components: the real
 * metadata-only Hook and one serialized collector. The test-only lock models
 * BaseInput's single cycle owner when tests launch concurrent Hook processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { QoderTranscriptCollector } from '../../assets/hooks/qoder/transcript-collector.mjs';

const processor = fileURLToPath(new URL('../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
const args = process.argv.slice(2);
const agentId = args[args.indexOf('--agent-id') + 1];
const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
const input = fs.readFileSync(0);
const hook = spawnSync(process.execPath, [processor, ...args], { input, encoding: 'utf8', timeout: 5000 });
if (hook.status !== 0) { process.stderr.write(hook.stderr || 'Hook failed'); process.exit(1); }
process.stdout.write(hook.stdout);
if (process.env.QODER_TEST_CAPTURE_BARRIER === '1' && process.send) {
  // Concurrent-capture tests must establish both observations before starting
  // their collector. Process launch order is not an observation-time contract.
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hook capture barrier timed out')), 5000);
    process.once('message', () => { clearTimeout(timeout); resolve(); });
    process.send({ type: 'hook-published' });
  });
  process.disconnect();
}
fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
const lockFile = path.join(dataDir, 'state/test-collector.lock');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 15000;
let locked = false;
while (!locked && Date.now() < deadline) {
  try { fs.closeSync(fs.openSync(lockFile, 'wx')); locked = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(sleeper, 0, 0, 5); }
}
if (!locked) throw new Error('Test collector lock timed out');
try {
  const stateFile = path.join(dataDir, 'state', `${agentId}-test-native-checkpoints.json`);
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  let now = Date.now();
  const collector = new QoderTranscriptCollector({ dataDir, agentId, now: () => now,
    stableMs: 0, settleMs: 0, warn: (message, fields) => process.stderr.write(message + ' ' + JSON.stringify(fields) + '\n') });
  for (let cycle = 0; cycle < 64; cycle++) {
    const batch = await collector.collect(state);
    state = batch.state;
    if (batch.records.length) {
      const date = new Date();
      const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
      const history = path.join(dataDir, 'logs', agentId, 'history');
      fs.mkdirSync(history, { recursive: true });
      fs.appendFileSync(path.join(history, `${agentId}-${day}.jsonl`), batch.records.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    fs.writeFileSync(stateFile, JSON.stringify(state));
    await collector.acknowledge(state);
    now += 6000;
    if (!batch.changed && batch.records.length === 0) break;
  }
  collector.stop();
} finally { fs.unlinkSync(lockFile); }
