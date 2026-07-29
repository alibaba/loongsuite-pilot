import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockPostWebtracking = vi.fn().mockResolvedValue(undefined);
const mockPersistFailedLogs = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/flushers/sls-transport.js', () => ({
  postWebtracking: (...args: unknown[]) => mockPostWebtracking(...args),
  persistFailedLogs: (...args: unknown[]) => mockPersistFailedLogs(...args),
}));

import { FilePipeline, parseCheckpointKey } from '../../../src/pipeline/input/file/file-pipeline.js';
import type { PipelineConfig } from '../../../src/pipeline/types.js';

let tmpDir: string;
let logDir: string;
let stateDir: string;
let failedDir: string;
let dataDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-pipeline-test-'));
  logDir = path.join(tmpDir, 'logs');
  stateDir = path.join(tmpDir, 'state');
  failedDir = path.join(tmpDir, 'failed');
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): PipelineConfig {
  return {
    configName: 'test-pipeline',
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
}

describe('parseCheckpointKey', () => {
  it('parses path*dev*inode format', () => {
    expect(parseCheckpointKey('/tmp/file_test/data.log*16777229*425807574')).toBe('/tmp/file_test/data.log');
  });

  it('handles paths with special characters', () => {
    expect(parseCheckpointKey('/tmp/my app/data.log*1*2')).toBe('/tmp/my app/data.log');
  });

  it('returns the key itself for legacy plain path keys', () => {
    expect(parseCheckpointKey('/tmp/file_test/data.log')).toBe('/tmp/file_test/data.log');
  });

  it('returns null for malformed key with single star', () => {
    expect(parseCheckpointKey('/tmp/data.log*123')).toBe(null);
  });
});

describe('FilePipeline', () => {
  it('starts and stops without error', async () => {
    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
      dataDir,
    });
    await pipeline.start();
    await pipeline.stop();
  });

  it('collects lines from log files on poll cycle', async () => {
    fs.writeFileSync(path.join(logDir, 'app.log'), 'hello\nworld\n');

    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
      dataDir,
    });
    await pipeline.start();
    await new Promise((r) => setTimeout(r, 3000));
    await pipeline.stop();

    expect(mockPostWebtracking).toHaveBeenCalled();
    const logs = mockPostWebtracking.mock.calls[0][1];
    expect(logs).toEqual(
      expect.arrayContaining([
        { content: 'hello' },
        { content: 'world' },
      ]),
    );
  });

  it('persists checkpoints with path*dev*inode key format', async () => {
    const logFile = path.join(logDir, 'app.log');
    fs.writeFileSync(logFile, 'line1\n');

    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
      dataDir,
    });
    await pipeline.start();
    await new Promise((r) => setTimeout(r, 2000));
    await pipeline.stop();

    const stateFile = path.join(stateDir, 'test-pipeline.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keys = Object.keys(state);
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      const parts = key.split('*');
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe(logFile);
      expect(Number(parts[1])).toBeGreaterThanOrEqual(0);
      expect(Number(parts[2])).toBeGreaterThan(0);
    }
  });

  it('handleWake preserves checkpoint and picks up new data', async () => {
    const logFile = path.join(logDir, 'app.log');
    fs.writeFileSync(logFile, 'before-sleep\n');

    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
      dataDir,
    });
    await pipeline.start();
    await new Promise((r) => setTimeout(r, 2000));

    const stateFile = path.join(stateDir, 'test-pipeline.json');
    const stateBefore = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keysBefore = Object.keys(stateBefore);
    expect(keysBefore.length).toBeGreaterThan(0);
    const offsetBefore = stateBefore[keysBefore[0]].lastOffset;

    fs.appendFileSync(logFile, 'after-wake\n');

    await pipeline.handleWake();
    await new Promise((r) => setTimeout(r, 2000));
    await pipeline.stop();

    const stateAfter = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keysAfter = Object.keys(stateAfter);
    expect(keysAfter.length).toBeGreaterThan(0);
    const offsetAfter = stateAfter[keysAfter[0]].lastOffset;
    expect(offsetAfter).toBeGreaterThan(offsetBefore);

    const allCalls = mockPostWebtracking.mock.calls.flatMap((c: unknown[]) => c[1] as Record<string, string>[]);
    expect(allCalls).toEqual(
      expect.arrayContaining([{ content: 'after-wake' }]),
    );
  });

  it('handleWake is safe when pipeline is stopped', async () => {
    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
      dataDir,
    });
    await pipeline.start();
    await pipeline.stop();

    await expect(pipeline.handleWake()).resolves.toBeUndefined();
  });
});
