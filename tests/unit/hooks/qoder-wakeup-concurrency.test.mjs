import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MAX_WAKEUPS_PER_SOURCE, publishQoderWakeup, qoderWakeupRoot } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let root;
const children = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve); child.kill();
  })));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Qoder wakeup capacity under competing writers', () => {
  it('reserves the last context slot before another process can publish', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-wakeup-race-'));
    const transcript = path.join(root, 'native.jsonl');
    fs.writeFileSync(transcript, '{"type":"last-prompt"}\n');
    const payload = { session_id: 'synthetic', transcript_path: transcript, hook_event_name: 'Stop' };
    for (let index = 0; index < MAX_WAKEUPS_PER_SOURCE - 1; index++) {
      expect(publishQoderWakeup({ ...payload, cwd: `/seed-${index}` }, { dataDir: root, agentId: 'qoder-cn' })).toBe(true);
    }
    const release = path.join(root, 'release-writers');
    const moduleUrl = new URL('../../../assets/hooks/qoder/hook-wakeup.mjs', import.meta.url).href;
    const source = `
      import fs from 'node:fs';
      import { publishQoderWakeup } from ${JSON.stringify(moduleUrl)};
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to.includes('/events/')) {
          process.send({ publishing: true });
          const deadline = Date.now() + 4000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(process.argv[1]) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
        }
        return rename(from, to);
      };
      process.on('message', payload => {
        const accepted = publishQoderWakeup(payload, { dataDir: process.argv[2], agentId: 'qoder-cn' });
        process.send({ accepted }, () => process.exit(0));
      });
      process.send({ ready: true });
    `;
    let releaseTimer;
    try {
      const workers = Array.from({ length: 4 }, () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, release, root], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { PATH: process.env.PATH, HOME: root },
        });
        children.push(child);
        const ready = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.on('message', message => { if (message.ready) resolve(); });
        });
        const done = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.on('message', message => {
            if (message.publishing && !releaseTimer) {
              releaseTimer = setTimeout(() => fs.writeFileSync(release, ''), 150);
            }
            if ('accepted' in message) resolve(message.accepted);
          });
          child.once('exit', code => { if (code) reject(new Error(`writer exited ${code}`)); });
        });
        return { child, ready, done };
      });
      await Promise.all(workers.map(worker => worker.ready));
      workers.forEach(({ child }, index) => child.send({ ...payload, cwd: `/writer-${index}` }));
      const accepted = await Promise.all(workers.map(worker => worker.done));
      expect(accepted.filter(Boolean)).toHaveLength(1);
      const directory = path.join(qoderWakeupRoot(root, 'qoder-cn'), fs.readdirSync(qoderWakeupRoot(root, 'qoder-cn'))[0]);
      expect(fs.readdirSync(path.join(directory, 'events'))).toHaveLength(MAX_WAKEUPS_PER_SOURCE);
      expect(fs.readdirSync(directory).some(name => name.endsWith('.lock'))).toBe(false);
      expect(fs.existsSync(path.join(directory, 'source.json'))).toBe(true);
    } finally { clearTimeout(releaseTimer); }
  });
});
