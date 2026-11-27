import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('built attribute registration CLI/API work across processes without the collector', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pilot-built-invocation-attrs-'));
  const root = path.join(dir, 'contexts');
  const cli = path.join(dir, 'invocation-attributes.js');
  const api = path.join(dir, 'invocation-attributes-api.js');
  const cwd = dir;
  const run = (op, data) => new Promise((resolve, reject) => {
    const args = [cli, op, ...(op !== 'capabilities' ? ['--root', root] : [])];
    const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 6000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    await Promise.all([
      writeFile(path.join(dir, 'package.json'), '{"type":"module"}\n'),
      copyFile(new URL('../../dist/invocation-attributes.js', import.meta.url), cli),
      copyFile(new URL('../../dist/invocation-attributes-api.js', import.meta.url), api),
    ]);
    const info = await run('capabilities');
    assert.equal(info.code, 0, info.stderr);
    assert.equal(JSON.parse(info.stdout).parentContext, false);
    const { InvocationAttributeStore } = await import(pathToFileURL(api).href);
    new InvocationAttributeStore({ root }).close();
    const common = { scope: 'same-gateway', agent: 'codex' };
    const selector = { kind: 'turn', sessionId: 'same-thread', turnId: 'turn-A' };
    const payload = index => ({ ...common, selector, invocationId: 'call-' + index,
      attributes: { 'memory.owner': 'tenant,甲' + index, 'memory.enabled': false, 'memory.retries': 2 } });
    const requests = await Promise.all([run('register', payload(1)), run('register', payload(2))]);
    assert.deepEqual(requests.map(x => x.code).sort(), [0, 1]);
    const winner = requests.findIndex(x => x.code === 0) + 1;
    assert.match(requests.find(x => x.code !== 0).stderr, /conflict/);
    assert.equal(JSON.parse((await run('register', payload(winner))).stdout).status, 'unchanged');
    const staged = { ...common, invocationId: 'call-B' };
    assert.equal((await run('put', { ...staged, attributes: {} })).code, 0);
    const emptyTurn = { ...selector, turnId: 'turn-B' };
    assert.equal((await run('bind', { ...staged, selector: emptyTurn })).code, 0);
    const restored = new InvocationAttributeStore({ root });
    try {
      assert.deepEqual(restored.resolve({ ...common, selector }).attributes, payload(winner).attributes);
      assert.equal(restored.resolve({ ...common, selector: emptyTurn }).state, 'noAttrs');
      assert.throws(() => restored.register({ ...payload(3), selector: { ...selector, turnId: selector.sessionId } }), /invalid_selector/);
    } finally { restored.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
