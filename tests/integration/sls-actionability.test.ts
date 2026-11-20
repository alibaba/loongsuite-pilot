import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { AlarmManager } from '../../src/metrics/alarm-manager.js';
import { ClientType, CollectionMethod, type AgentActivityEntry, type SlsEndpoint } from '../../src/types/index.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';

async function fixture(mode: SlsEndpoint['mode'], status: number, contentType?: string, body?: string) {
  const receivedLogs: Record<string, string>[] = [];
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (mode === 'webtracking') {
      const logs = JSON.parse(Buffer.concat(chunks).toString('utf8')).__logs__ as Record<string, string>[];
      receivedLogs.push(...logs);
    }
    res.writeHead(status, contentType ? { 'content-type': contentType } : {});
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local server unavailable');
  const root = await mkdtemp(path.join(tmpdir(), 'sls-actionability-review-'));
  const alarms = new AlarmManager({ ip: '127.0.0.1', version: 'test', userId: 'test' });
  const sls = new SlsFlusher({ enabled: true, endpoints: [{ name: 'local', endpoint: `http://127.0.0.1:${address.port}`,
    project: '', logstore: 'events', mode, kind: 'agentActivity', accessKeyId: 'test-key', accessKeySecret: 'test-secret' }],
    batchMaxSize: 20, flushIntervalMs: 60_000, serviceNamePrefix: '', retry: { retryMaxAttempts: 1 } }, root);
  sls.setAlarmManager(alarms);
  return { root, alarms, sls, receivedLogs, requests: () => requests, cleanup: async () => {
    await sls.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

describe('SLS failure actionability through real HTTP transports', () => {
  it('records a quota through the real AK SDK using Alibaba SLS response shape', async () => {
    const h = await fixture('ak', 403, 'application/json', JSON.stringify({
      errorCode: 'WriteQuotaExceed', errorMessage: 'Project write quota exceeded: inflow',
    }));
    try {
      await h.sls.send(buildTestEntry());
      await h.sls.flush();
      expect(h.requests()).toBe(1);
      expect(h.sls.getEndpointCounters().get('local')).toMatchObject({ outEntries: 0, outFailed: 1 });
      expect(h.alarms.serialize().map(entry => [entry.alarm_type, entry.failure_class])).toEqual([
        ['FLUSH_SEND_ALARM', 'quota'], ['FLUSH_QUOTA_ALARM', undefined],
      ]);
    } finally { await h.cleanup(); }
  });

  it('accepts a Codex batch durably when the configured WebTracking endpoint accepts it', async () => {
    const h = await fixture('webtracking', 200);
    const stateFile = path.join(h.root, 'input-state.json');
    const state = new StateStore(stateFile);
    class Source extends BaseInput {
      readonly id = 'codex-sls-size';
      readonly agentType = ClientType.CodexCliHook;
      readonly collectionMethod = CollectionMethod.SessionFilePolling;
      protected async collect(): Promise<AgentActivityEntry[]> {
        this.setState({ lastOffset: 1 });
        return [
          buildTestEntry({ 'event.id': 'large', 'gen_ai.agent.type': this.agentType,
            'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: '界'.repeat(1_070_000) }] }] }),
          buildTestEntry({ 'event.id': 'normal', 'gen_ai.agent.type': this.agentType }),
        ];
      }
    }
    const input = new Source({ stateStore: state, pollIntervalMs: 60_000 });
    state.setOffset(input.id, 0);
    await state.save();
    const manager = new InputManager();
    manager.setFlusher(h.sls);
    manager.registerInput(input);
    try {
      await manager.startInput(input.id);
      await manager.drainInputQueue(input.id);
      await state.save();
      const readback = new StateStore(stateFile);
      await readback.load();
      expect(readback.getOffset(input.id)).toBe(1);
      expect(input.checkpointFailed).toBe(false);
      const originalRecords = h.receivedLogs.filter(log => ['large', 'normal'].includes(log['event.id']));
      expect(originalRecords.map(log => log['event.id'])).toEqual(['large', 'normal']);
      const message = JSON.parse(originalRecords[0]['gen_ai.input.messages_delta'])[0].parts[0].content as string;
      expect(Buffer.byteLength(message)).toBe(3_210_000);
    } finally {
      await manager.stopAll();
      await h.cleanup();
    }
  });
});
