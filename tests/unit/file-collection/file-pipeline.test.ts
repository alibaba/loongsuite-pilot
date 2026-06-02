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

import { FilePipeline } from '../../../src/file-collection/file-pipeline.js';
import type { FileCollectionConfig } from '../../../src/file-collection/types.js';

let tmpDir: string;
let logDir: string;
let stateDir: string;
let failedDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-pipeline-test-'));
  logDir = path.join(tmpDir, 'logs');
  stateDir = path.join(tmpDir, 'state');
  failedDir = path.join(tmpDir, 'failed');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): FileCollectionConfig {
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

describe('FilePipeline', () => {
  it('starts and stops without error', async () => {
    const pipeline = new FilePipeline({
      config: makeConfig(),
      stateDir,
      failedLogDir: failedDir,
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
    });
    await pipeline.start();
    // Wait for flush timer to fire
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
});
