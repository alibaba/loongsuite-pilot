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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-runtime-wrapper-'));
    dataDir = path.join(root, 'pilot-data');
    wrapper = path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs');
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.copyFile(sourceWrapper, wrapper);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['FutureAgent.app', 'QoderWork.app', 'QoderWork CN.app', 'QoderWorkCN.app', 'QwenWorkCN.app'])('loads %s own runtime without interception', async appName => {
    const marker = path.join(root, 'runtime-loaded');
    const resources = await createHostRuntime(appName, marker);

    runWrapper(resources, marker);

    expect(JSON.parse(await fs.readFile(marker, 'utf-8'))).toEqual({
      loaded: true,
      parseUnchanged: true,
      stringifyUnchanged: true,
    });
    expect(existsSync(path.join(dataDir, 'logs', 'qoderwork-intercept.jsonl'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'logs', 'qoderworkcn-intercept.jsonl'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
  });

  it('recognizes QwenWorkCN from a direct Windows resources path', async () => {
    const marker = path.join(root, 'windows-qwen-runtime-loaded');
    const resources = await createWindowsHostRuntime('QwenWorkCN', marker);

    runWrapper(resources, marker);

    expect(JSON.parse(await fs.readFile(marker, 'utf-8'))).toEqual({
      loaded: true,
      parseUnchanged: true,
      stringifyUnchanged: true,
    });
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
  });

  it.each(['QwenWorkCN', 'QoderWork', 'QoderWorkCN', 'QoderWork CN'])(
    'forwards versioned Windows %s resources without interception', async appName => {
    const marker = path.join(root, `windows-${appName}-runtime-loaded`);
    const resources = await createWindowsHostRuntime(appName, marker, '0.1.8-26081406');

    runWrapper(resources, marker, {
      QW_QODER_WORKER_RUNTIME_PATH: wrapper,
      QODER_WORKER_RUNTIME_PATH: wrapper,
    });

    expect(JSON.parse(await fs.readFile(marker, 'utf-8'))).toEqual({
      loaded: true,
      parseUnchanged: true,
      stringifyUnchanged: true,
    });
    for (const intercept of [
      'qwenworkcn-intercept.jsonl',
      'qoderwork-intercept.jsonl',
      'qoderworkcn-intercept.jsonl',
    ]) {
      expect(existsSync(path.join(dataDir, 'logs', intercept))).toBe(false);
    }
  });

  it('does not classify a deeper unrelated Windows descendant as an app host', async () => {
    const marker = path.join(root, 'windows-nested-runtime-loaded');
    const resources = path.join(root, 'Programs', 'QwenWorkCN', 'version', 'nested', 'resources');
    await createRuntimeAt(resources, marker);

    runWrapper(resources, marker, { QW_QODER_WORKER_RUNTIME_PATH: wrapper });

    expect(JSON.parse(await fs.readFile(marker, 'utf-8'))).toEqual({
      loaded: true,
      parseUnchanged: true,
      stringifyUnchanged: true,
    });
    expect(existsSync(path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl'))).toBe(false);
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
fs.writeFileSync(process.env.PILOT_WRAPPER_MARKER, JSON.stringify({
  loaded: true,
  parseUnchanged: JSON.parse === globalThis.originalParse,
  stringifyUnchanged: JSON.stringify === globalThis.originalStringify,
}));
JSON.parse(JSON.stringify({
  id: 'chatcmpl-wrapper-test',
  model: 'qwen-test',
  choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}));
JSON.stringify({ messages: [{ role: 'system', content: 'Synthetic system instruction. '.repeat(5) }] });
`,
    );
  }

  function runWrapper(resources, marker, extraEnv = {}) {
    const launcher = `
globalThis.originalParse = JSON.parse;
globalThis.originalStringify = JSON.stringify;
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
