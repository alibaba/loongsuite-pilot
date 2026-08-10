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

  async function createHostRuntime(appName, marker) {
    const resources = path.join(root, appName, 'Contents', 'Resources');
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
    return resources;
  }

  function runWrapper(resources, marker) {
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
      },
    });
    expect(result.status, result.stderr).toBe(0);
  }
});
