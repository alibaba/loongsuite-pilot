import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { ClientType, CollectionMethod } from '../../src/types/index.js';
import type { AgentActivityEntry, SlsFlusherConfig } from '../../src/types/index.js';
import { MockStateStore } from '../helpers/mock-state-store.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';

type MockSlsMode = 'fail' | 'ok';

type TestSlsConfig = SlsFlusherConfig & {
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  backpressureHighWatermarkEntries?: number;
  backpressureLowWatermarkEntries?: number;
  backpressureHighWatermarkBytes?: number;
  backpressureLowWatermarkBytes?: number;
};

class SimulatedInput extends BaseInput {
  readonly id = 'simulated-input';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;
  collectCount = 0;

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.collectCount += 1;
    return [buildTestEntry({
      uuid: `simulated-${this.collectCount}`,
      content: `message-${this.collectCount}`,
    })];
  }
}

async function startMockSlsServer() {
  let mode: MockSlsMode = 'fail';
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
    });
    req.on('end', () => {
      bodies.push(raw);
      if (mode === 'fail') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('mock sls unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    get requestCount() {
      return bodies.length;
    },
    get bodies() {
      return [...bodies];
    },
    setMode(next: MockSlsMode) {
      mode = next;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    },
  };
}

function makeSlsConfig(endpoint: string): TestSlsConfig {
  return {
    enabled: true,
    accessKeyId: '',
    accessKeySecret: '',
    endpoint,
    mode: 'webtracking',
    endpoints: [{
      name: 'mock-sls',
      endpoint,
      project: '',
      logstore: 'agent-activity',
      kind: 'agentActivity',
      mode: 'webtracking',
      redact: false,
    }],
    batchMaxSize: 100,
    flushIntervalMs: 60_000,
    serviceNamePrefix: '',
    retryInitialDelayMs: 1,
    retryMaxDelayMs: 1,
    backpressureHighWatermarkEntries: 2,
    backpressureLowWatermarkEntries: 1,
    backpressureHighWatermarkBytes: Number.MAX_SAFE_INTEGER,
    backpressureLowWatermarkBytes: Number.MAX_SAFE_INTEGER,
  };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(intervalMs);
  }
  throw new Error('condition was not met before timeout');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('SLS backpressure integration flow', () => {
  let tmpDir: string | undefined;
  let input: SimulatedInput | undefined;
  let flusher: SlsFlusher | undefined;
  let server: Awaited<ReturnType<typeof startMockSlsServer>> | undefined;

  afterEach(async () => {
    if (input?.running) await input.stop();
    if (flusher) await flusher.shutdown();
    if (server) await server.close();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    input = undefined;
    flusher = undefined;
    server = undefined;
    tmpDir = undefined;
  });

  it('pauses input collection while SLS is backpressured and resumes after SLS recovers', async () => {
    server = await startMockSlsServer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-backpressure-integ-'));
    flusher = new SlsFlusher(makeSlsConfig(server.endpoint), tmpDir);

    const manager = new InputManager();
    manager.setFlusher(new MultiFlusher([flusher]));
    input = new SimulatedInput({
      stateStore: new MockStateStore() as any,
      pollIntervalMs: 100,
    });
    manager.registerInput(input);

    await input.start();
    await waitFor(() => flusher!.getBackpressureState().active);

    const pausedCollectCount = input.collectCount;
    expect(flusher.getBackpressureState()).toMatchObject({
      active: true,
      queuedEntries: pausedCollectCount,
      reason: 'entries_high_watermark',
    });

    await sleep(220);
    expect(input.collectCount).toBe(pausedCollectCount);

    await flusher.flush();
    expect(server.requestCount).toBe(3);
    expect(flusher.getBackpressureState()).toMatchObject({
      active: true,
      queuedEntries: pausedCollectCount,
    });

    server.setMode('ok');
    await sleep(5);
    await flusher.flush();
    expect(flusher.getBackpressureState().active).toBe(false);

    await waitFor(() => input!.collectCount > pausedCollectCount);
    expect(input.collectCount).toBeGreaterThan(pausedCollectCount);
    expect(flusher.getBackpressureState().active).toBe(false);
  }, 10_000);
});
