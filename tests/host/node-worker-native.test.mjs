// Explicit optional host acceptance: real Node -> Rust supervisor -> real Node worker.
// No default Cargo test or native worker requires Node.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const bridge = process.env.PILOT_NATIVE_NODE_WORKER_BRIDGE;
let root;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });
function fixture() {
  if (!bridge || !path.isAbsolute(bridge)) throw new Error('Build --example host_node_worker_bridge and supply absolute PILOT_NATIVE_NODE_WORKER_BRIDGE.');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native Node worker 自动发现 '));
  const bundle = path.join(root, 'bundle 空格🚀'); fs.mkdirSync(bundle);
  const capture = path.join(bundle, 'worker-capture.json');
  const entry = path.join(bundle, 'worker Unicode.mjs');
  fs.writeFileSync(entry, "import fs from 'node:fs';fs.writeFileSync(process.argv[2],JSON.stringify({execPath:process.execPath,value:process.argv[3],path:process.env.PATH}));");
  const manifest = { name: 'actual-node-host', command: ['${pilot:node}', entry, capture, '保留 空格🚀'], cwd: '.', paths: { pid: 'worker.pid', status: 'worker-status.json', log: 'worker.log' }, restartPolicy: { type: 'never' }, env: { PATH: path.join(root, 'untrusted-manifest-path') } };
  fs.writeFileSync(path.join(bundle, 'worker.manifest.json'), JSON.stringify(manifest));
  return { bundle, capture, manifest };
}
function run(bundle, overrides, request = {}) {
  const env = { ...process.env, PATH: path.dirname(process.execPath), ...overrides };
  // Exercise automatic discovery with the override truly absent.
  if (!Object.hasOwn(overrides ?? {}, 'PILOT_NODE_BIN')) delete env.PILOT_NODE_BIN;
  const child = spawnSync(bridge, [], { input: JSON.stringify({ installDir: bundle, ...request }), env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
describe('optional Node worker native automatic discovery', () => {
  it('preserves the original L92 Node executable, argument, and exit assertions', () => {
    const f = fixture();
    const entry = path.join(f.bundle, 'original worker-entrypoint.mjs');
    fs.writeFileSync(entry, "import fs from 'node:fs';fs.writeFileSync(process.argv[2],JSON.stringify({execPath:process.execPath,value:process.argv[3]}));");
    f.manifest.command = ['${pilot:node}', entry, f.capture, '保留 空格'];
    fs.writeFileSync(path.join(f.bundle, 'worker.manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.bundle, {});
    expect(result.started).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8'))).toEqual({ execPath: process.execPath, value: '保留 空格' });
    expect(result.status.state).toBe('exited'); expect(result.status.exitCode).toBe(0);
  }, 30_000);
  it('maps USERPROFILE to HOME in an actual managed Node child without mutating the parent environment', () => {
    const f = fixture();
    const entry = path.join(f.bundle, 'home reader.mjs');
    fs.writeFileSync(entry, "import fs from 'node:fs';fs.writeFileSync(process.argv[2],process.env.HOME ?? '');");
    f.manifest.command = ['${pilot:node}', entry, f.capture];
    delete f.manifest.env;
    fs.writeFileSync(path.join(f.bundle, 'worker.manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.bundle, {}, { platform: 'win32', managed: true, workerEnv: { USERPROFILE: 'C:\\Users\\测试 用户' } });
    expect(result.started).toBe(true);
    expect(fs.readFileSync(f.capture, 'utf8')).toBe('C:\\Users\\测试 用户');
    expect(result.parentEnvironmentUnchanged).toBe(true);
    expect(result.status.state).toBe('exited'); expect(result.status.exitCode).toBe(0);
  }, 30_000);
  it('starts the original real Node worker with Unicode arguments and records its actual exit', () => {
    const f = fixture(); const result = run(f.bundle, {});
    expect(result.started).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8'))).toEqual({ execPath: fs.realpathSync(process.execPath), value: '保留 空格🚀', path: f.manifest.env.PATH });
    expect(result.status.state).toBe('exited'); expect(result.status.exitCode).toBe(0);
  }, 30_000);
  it('honors an explicit host Node when PATH has no Node', () => {
    const f = fixture(); const result = run(f.bundle, { PATH: '', PILOT_NODE_BIN: process.execPath });
    expect(result.started).toBe(true);
    expect(JSON.parse(fs.readFileSync(f.capture, 'utf8')).value).toBe('保留 空格🚀');
    expect(result.status.state).toBe('exited'); expect(result.status.exitCode).toBe(0);
  }, 30_000);
  it('refuses an invalid explicit override instead of falling back to a usable host Node', () => {
    const f = fixture(); const result = run(f.bundle, { PILOT_NODE_BIN: 'relative-node' });
    expect(result.started).toBe(false); expect(fs.existsSync(f.capture)).toBe(false);
    expect(result.status.reason).toBe('WorkerManifestPlaceholderInvalid');
  }, 15_000);
  it('does not discover Node from the manifest PATH or implicit current directory', () => {
    const f = fixture();
    f.manifest.env.PATH = path.dirname(process.execPath);
    fs.writeFileSync(path.join(f.bundle, 'worker.manifest.json'), JSON.stringify(f.manifest));
    const result = run(f.bundle, { PATH: '' });
    expect(result.started).toBe(false); expect(fs.existsSync(f.capture)).toBe(false);
    expect(result.status.reason).toBe('WorkerManifestPlaceholderInvalid');
    expect(result.status.error).toContain('Node');
  }, 15_000);
});
