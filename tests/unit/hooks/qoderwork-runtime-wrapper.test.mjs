import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sourceWrapper = path.resolve('assets/hooks/qoderwork-runtime-wrapper.mjs');
const sdkWorkerRelative = path.join(
  'app.asar.unpacked',
  'node_modules',
  '@qoder-ai',
  'qoder-agent-sdk',
  'dist',
  '_worker',
);

describe('QoderWork-family runtime wrapper forwarding', () => {
  let root;
  let dataDir;
  let wrapper;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-runtime-wrapper-')));
    dataDir = path.join(root, 'pilot-data');
    wrapper = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.copyFile(sourceWrapper, wrapper);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('transparently loads an unknown host own runtime without interception', async () => {
    const marker = path.join(root, 'unknown-runtime-loaded');
    const resources = await createHostRuntime('FutureAgent.app', marker);

    runWrapper(resources, marker);

    expect(await fs.readFile(marker, 'utf-8')).toBe('loaded');
    expect(existsSync(path.join(dataDir, 'logs', 'qoderwork-intercept.jsonl'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'logs', 'qoderworkcn-intercept.jsonl'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
  });

  it('keeps token interception enabled for a recognized host', async () => {
    const marker = path.join(root, 'qwen-runtime-loaded');
    const resources = await createHostRuntime('QwenWorkCN.app', marker);

    runWrapper(resources, marker);

    expect(await fs.readFile(marker, 'utf-8')).toBe('loaded');
    const intercept = await fs.readFile(
      path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(intercept.trim())).toMatchObject({
      type: 'token',
      id: 'chatcmpl-wrapper-test',
      model: 'qwen-test',
      total_tokens: 3,
    });
  });

  it('recognizes QwenWorkCN from a direct Windows resources path', async () => {
    const marker = path.join(root, 'windows-qwen-runtime-loaded');
    const resources = await createWindowsHostRuntime('QwenWorkCN', marker);

    runWrapper(resources, marker);

    expect(await fs.readFile(marker, 'utf-8')).toBe('loaded');
    const intercept = await fs.readFile(
      path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'),
      'utf-8',
    );
    expect(JSON.parse(intercept.trim())).toMatchObject({
      id: 'chatcmpl-wrapper-test',
      total_tokens: 3,
    });
  });

  it.each([
    ['QwenWorkCN', '0.1.8-26081406', 'qwenworkcn-intercept.jsonl'],
    ['QoderWork', '0.1.8-26081406', 'qoderwork-intercept.jsonl'],
    ['QoderWorkCN', '0.1.8-26081406', 'qoderworkcn-intercept.jsonl'],
    ['QoderWork CN', '0.1.8-26081406', 'qoderworkcn-intercept.jsonl'],
  ])('classifies versioned Windows %s resources without cross-agent writes', async (
    appName,
    version,
    expectedIntercept,
  ) => {
    const marker = path.join(root, `windows-${appName}-runtime-loaded`);
    const resources = await createWindowsHostRuntime(appName, marker, version);

    runWrapper(resources, marker, {
      QW_QODER_WORKER_RUNTIME_PATH: wrapper,
      QODER_WORKER_RUNTIME_PATH: wrapper,
    });

    expect(await fs.readFile(marker, 'utf-8')).toBe('loaded');
    for (const intercept of [
      'qwenworkcn-intercept.jsonl',
      'qoderwork-intercept.jsonl',
      'qoderworkcn-intercept.jsonl',
    ]) {
      expect(existsSync(path.join(dataDir, 'logs', intercept))).toBe(intercept === expectedIntercept);
    }
  });

  it('does not classify a deeper unrelated Windows descendant as an app host', async () => {
    const marker = path.join(root, 'windows-nested-runtime-loaded');
    const resources = path.join(root, 'Programs', 'QwenWorkCN', 'version', 'nested', 'resources');
    await createRuntimeAt(resources, marker);

    runWrapper(resources, marker, { QW_QODER_WORKER_RUNTIME_PATH: wrapper });

    expect(await fs.readFile(marker, 'utf-8')).toBe('loaded');
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
  });

  async function createDevProject(name, { pnpm = false } = {}) {
    const project = path.join(root, name);
    const electronDir = path.join(project, 'node_modules', ...(pnpm ? ['.pnpm', 'electron@1', 'node_modules'] : []), 'electron');
    const executable = path.join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, 'fixture');
    await fs.writeFile(path.join(electronDir, 'package.json'), '{"name":"electron"}');
    await fs.writeFile(path.join(electronDir, 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
    if (pnpm) await fs.symlink(electronDir, path.join(project, 'node_modules', 'electron'));
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({
      dependencies: { '@qoder-ai/qoder-agent-sdk': 'npm:@ali/qodercn-agent-sdk-next@1' },
    }));
    const sdk = path.join(project, 'node_modules', '@qoder-ai', 'qoder-agent-sdk');
    await fs.mkdir(path.join(sdk, 'dist', '_worker'), { recursive: true });
    await fs.writeFile(path.join(sdk, 'package.json'), JSON.stringify({
      name: '@ali/qodercn-agent-sdk-next', exports: './dist/index.js',
    }));
    await fs.writeFile(path.join(sdk, 'dist', 'index.js'), '');
    const runtime = path.join(sdk, 'dist', '_worker', 'qoder-worker-runtime.mjs');
    await fs.writeFile(runtime, protocolRuntime);
    return { project, executable, runtime };
  }

  const protocolRuntime = String.raw`
import { createInterface } from 'node:readline';
import { workerData } from 'node:worker_threads';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: 'control_response', response: { subtype: 'success', request_id: request.request_id },
    runtime: import.meta.url,
    assetRoot: process.env.QODER_WORKER_RUNTIME_ASSET_ROOT,
    runtimeRoot: workerData.qoderWorkerRuntime.runtimeRoot,
    cwd: workerData.qoderWorkerRuntime.cwd,
  }) + '\n');
});
`;

  async function initializeWorker({ executable = process.execPath, resources = '', manifest = '', cwd = '/task/workspace' } = {}) {
    const worker = new Worker(`
      Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(executable)} });
      process.resourcesPath = ${JSON.stringify(resources)};
      import(${JSON.stringify(wrapper)});
    `, {
      eval: true, stdin: true, stdout: true, stderr: true,
      env: { ...process.env, npm_package_json: manifest, QODER_WORKER_RUNTIME_ASSET_ROOT: path.dirname(wrapper) },
      workerData: { qoderWorkerRuntime: { cwd, runtimeRoot: path.dirname(wrapper) } },
    });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture initialize timed out')), 3000);
        const finish = (err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); };
        // Model the SDK: it destroys stdout on error without ending the
        // downstream reader. Failure must still reach that reader promptly.
        const reader = new PassThrough();
        worker.stdout.pipe(reader);
        let workerFailure;
        let readerEnded = false;
        worker.on('error', error => {
          workerFailure = error;
          worker.stdout.destroy();
          if (readerEnded) finish(error);
        });
        worker.on('exit', code => {
          workerFailure ??= new Error(`worker exited before initialize: ${code}`);
          worker.stdout.destroy();
          if (readerEnded) finish(workerFailure);
        });
        reader.on('end', () => {
          readerEnded = true;
          if (workerFailure) finish(workerFailure);
        });
        let output = '';
        reader.on('data', data => {
          output += data;
          if (output.includes('\n')) {
            try { finish(null, JSON.parse(output.split('\n')[0])); } catch (err) { finish(err); }
          }
        });
        worker.stdin.on('error', error => finish(error));
        worker.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } }) + '\n');
      });
    } finally {
      await worker.terminate();
    }
  }

  it.each([false, true])('answers initialize with the development SDK (pnpm=%s)', async pnpm => {
    const dev = await createDevProject('dev', { pnpm });
    const result = await initializeWorker({ executable: dev.executable });
    expect(result.response).toEqual({ subtype: 'success', request_id: 'init-1' });
    expect(result.runtime).toBe(pathToFileURL(dev.runtime).href);
    expect(result.assetRoot).toBe(path.dirname(dev.runtime));
    expect(result.runtimeRoot).toBe(path.dirname(dev.runtime));
    expect(result.cwd).toBe('/task/workspace');
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
  });

  it('prefers the verified workspace SDK over a different hoisted SDK', async () => {
    const rootDev = await createDevProject('monorepo');
    const workspace = await createDevProject('monorepo/packages/app');
    await fs.rm(path.join(workspace.project, 'node_modules', 'electron'), { recursive: true });
    const result = await initializeWorker({ executable: rootDev.executable, manifest: path.join(workspace.project, 'package.json') });
    expect(result.runtime).toBe(pathToFileURL(workspace.runtime).href);
    await fs.rm(workspace.runtime);
    await expect(initializeWorker({ executable: rootDev.executable, manifest: path.join(workspace.project, 'package.json') }))
      .rejects.toThrow('Pilot host app runtime not found');
  });

  it('ignores a manifest belonging to another Electron installation', async () => {
    const host = await createDevProject('host');
    const foreign = await createDevProject('foreign');
    const result = await initializeWorker({ executable: host.executable, manifest: path.join(foreign.project, 'package.json') });
    expect(result.runtime).toBe(pathToFileURL(host.runtime).href);
  });

  it('answers initialize for packaged hosts and restores runtime asset context', async () => {
    const resources = await createHostRuntime('QwenWorkCN.app', 'unused');
    const runtime = path.join(resources, sdkWorkerRelative, 'qoder-worker-runtime.mjs');
    await fs.writeFile(runtime, protocolRuntime);
    const result = await initializeWorker({ resources });
    expect(result.response.request_id).toBe('init-1');
    expect(result.assetRoot).toBe(path.dirname(runtime));
  });

  it('reports missing runtime as a Worker error instead of an empty successful exit', async () => {
    await expect(initializeWorker()).rejects.toThrow('Pilot host app runtime not found');
    expect(await fs.readFile(path.join(dataDir, 'logs', 'qoderwork-wrapper-error.log'), 'utf8'))
      .toContain('Pilot host app runtime not found');
  });

  it('propagates runtime import errors without trying another runtime', async () => {
    const dev = await createDevProject('broken');
    await fs.writeFile(path.join(path.dirname(dev.runtime), 'qoder-worker-runtime.obf.mjs'), "throw new Error('native dependency unavailable');");
    await expect(initializeWorker({ executable: dev.executable })).rejects.toThrow('native dependency unavailable');
    expect(await fs.readFile(path.join(dataDir, 'logs', 'qoderwork-wrapper-error.log'), 'utf8'))
      .toContain('host runtime import failed');
  });

  it('does not use a conversation workspace runtime when the host runtime is missing', async () => {
    const host = await createDevProject('host-missing');
    const foreign = await createDevProject('task-workspace');
    await fs.rm(host.runtime);
    await expect(initializeWorker({ executable: host.executable, cwd: foreign.project }))
      .rejects.toThrow('Pilot host app runtime not found');
  });

  it('rejects a runtime symlink pointing back to the wrapper', async () => {
    const dev = await createDevProject('recursive');
    await fs.rm(dev.runtime);
    await fs.symlink(wrapper, dev.runtime);
    await expect(initializeWorker({ executable: dev.executable }))
      .rejects.toThrow('Pilot host app runtime not found');
  });

  async function createHostRuntime(appName, marker) {
    const resources = path.join(root, appName, 'Contents', 'Resources');
    await createRuntimeAt(resources, marker);
    return resources;
  }

  async function createWindowsHostRuntime(appName, marker, version) {
    const resources = path.join(root, 'Programs', appName, ...(version ? [version] : []), 'resources');
    await createRuntimeAt(resources, marker);
    return resources;
  }

  async function createRuntimeAt(resources, marker) {
    const runtimeDir = path.join(resources, sdkWorkerRelative);
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'qoder-worker-runtime.mjs'),
      `import fs from 'node:fs';
fs.writeFileSync(process.env.PILOT_WRAPPER_MARKER, 'loaded');
JSON.parse(JSON.stringify({
  id: 'chatcmpl-wrapper-test',
  model: 'qwen-test',
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}));
`,
    );
  }

  function runWrapper(resources, marker, extraEnv = {}) {
    const launcher = `
process.resourcesPath = process.env.PILOT_TEST_RESOURCES;
import(process.env.PILOT_TEST_WRAPPER).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', launcher], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PILOT_TEST_RESOURCES: resources,
        PILOT_TEST_WRAPPER: wrapper,
        PILOT_WRAPPER_MARKER: marker,
        ...extraEnv,
      },
    });
    expect(result.status, result.stderr).toBe(0);
  }
});
