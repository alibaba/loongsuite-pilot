import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('observes a native lazy module while preserving call count, results and exceptions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-delivery-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"openclaw","type":"module"}');
    const entry = path.join(root, 'openclaw.mjs');
    fs.writeFileSync(entry, '');
    fs.writeFileSync(path.join(root, 'dist/native.js'), `export async function t(params) {
      params.calls++; if (params.error) throw params.error; return params.result;
    }`);
    const file = path.join(root, 'dist/subagent-announce-fixture.js');
    fs.writeFileSync(file, `import { t as deliverSubagentAnnouncement } from './native.js';
      export async function runSubagentAnnounceFlow(params) { return await deliverSubagentAnnouncement(params); }`);
    // A native process is necessary: Vitest's own loader bypasses Node Hooks.
    const observer = pathToFileURL(path.resolve('assets/plugins/openclaw/steered-delivery.mjs')).href;
    const test = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { installSteeredDeliveryObserver } from ${JSON.stringify(observer)};
      const observations = [];
      installSteeredDeliveryObserver({ prepare: p => p, complete: (p, r) => observations.push([p, r]) }, ${JSON.stringify(entry)});
      const native = await import(${JSON.stringify(pathToFileURL(file).href)});
      const result = { delivered: true, path: 'steered', deliveredAt: 1 };
      const params = { calls: 0, result };
      assert.equal(await native.runSubagentAnnounceFlow(params), result);
      assert.equal(params.calls, 1);
      assert.deepEqual(observations, [[params, result]]);
      const error = new Error('native failure');
      const failed = { calls: 0, error };
      await assert.rejects(native.runSubagentAnnounceFlow(failed), value => value === error);
      assert.equal(failed.calls, 1);
      assert.equal(observations.length, 1);
      globalThis[Symbol.for('loongsuite-pilot.openclaw.steered-delivery')].observer = { prepare() { throw Error('telemetry'); } };
      assert.equal(await native.runSubagentAnnounceFlow(params), result);
      assert.equal(params.calls, 2);
    `], { encoding: 'utf8' });
    expect(test.status, test.stderr).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
