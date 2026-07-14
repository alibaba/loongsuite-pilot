import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/flushers/sls-transport.js', () => ({
  postWebtracking: vi.fn().mockResolvedValue(undefined),
  persistFailedLogs: vi.fn().mockResolvedValue(undefined),
}));

import { PipelineManager } from '../../../src/pipeline/pipeline-manager.js';
import { SleepDetector } from '../../../src/pipeline/sleep-detector.js';

let tmpDir: string;
let configDir: string;
let stateDir: string;
let failedDir: string;
let dataDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-test-'));
  configDir = path.join(tmpDir, 'config');
  stateDir = path.join(tmpDir, 'state');
  failedDir = path.join(tmpDir, 'failed');
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(name: string, logDir = '/tmp/test') {
  const config = {
    configName: name,
    inputs: [{
      Type: 'input_file',
      FilePaths: [path.join(logDir, '*.log')],
      FileEncoding: 'utf8',
      MaxDirSearchDepth: 0,
    }],
    flushers: [{
      Type: 'flusher_sls',
      Endpoint: 'cn-hangzhou.log.aliyuncs.com',
      Project: 'test-project',
      Logstore: 'test-logstore',
    }],
  };
  fs.writeFileSync(
    path.join(configDir, `${name}.json`),
    JSON.stringify(config),
  );
}

describe('PipelineManager', () => {
  it('starts and stops with no configs', async () => {
    const manager = new PipelineManager({
      configDir,
      stateDir,
      failedLogDir: failedDir,
      dataDir,
      pipelineConfig: { enabled: true, file: { enabled: true }, qoderApi: { enabled: true } },
    });
    await manager.start();
    await manager.stop();
  });

  it('loads existing configs on start', async () => {
    writeConfig('app-logs');
    writeConfig('nginx-logs');

    const manager = new PipelineManager({
      configDir,
      stateDir,
      failedLogDir: failedDir,
      dataDir,
      pipelineConfig: { enabled: true, file: { enabled: true }, qoderApi: { enabled: true } },
    });
    await manager.start();
    // Pipelines should have been created (no direct way to check count,
    // but stop should succeed without error)
    await manager.stop();
  });

  it('skips invalid config files', async () => {
    fs.writeFileSync(path.join(configDir, 'bad.json'), 'not json');
    fs.writeFileSync(
      path.join(configDir, 'incomplete.json'),
      JSON.stringify({ configName: 'incomplete' }),
    );
    writeConfig('valid');

    const manager = new PipelineManager({
      configDir,
      stateDir,
      failedLogDir: failedDir,
      dataDir,
      pipelineConfig: { enabled: true, file: { enabled: true }, qoderApi: { enabled: true } },
    });
    await manager.start();
    await manager.stop();
  });

  it('ignores non-json files', async () => {
    fs.writeFileSync(path.join(configDir, 'readme.txt'), 'hello');
    writeConfig('valid');

    const manager = new PipelineManager({
      configDir,
      stateDir,
      failedLogDir: failedDir,
      dataDir,
      pipelineConfig: { enabled: true, file: { enabled: true }, qoderApi: { enabled: true } },
    });
    await manager.start();
    await manager.stop();
  });

  it('stop is safe to call multiple times', async () => {
    const manager = new PipelineManager({
      configDir,
      stateDir,
      failedLogDir: failedDir,
      dataDir,
      pipelineConfig: { enabled: true, file: { enabled: true }, qoderApi: { enabled: true } },
    });
    await manager.start();
    await manager.stop();
    await manager.stop();
  });
});

describe('SleepDetector integration', () => {
  it('SleepDetector can be started and stopped independently', () => {
    const detector = new SleepDetector();
    detector.start();
    detector.stop();
  });
});
