import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { maskAgentActivityEntry } from '../../src/mask/entry-masker.js';
import { ClientType } from '../../src/types/index.js';

const slsSend = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@alicloud/log', () => ({ default: vi.fn().mockImplementation(() => ({ postLogStoreLogs: slsSend })) }));

describe.each([ClientType.OpenClaw, ClientType.Hermes])('%s audit log destinations', agent => {
  it('keeps native messages, work IDs and receiving turns through JSONL, real HTTP and the SLS SDK boundary, after masking', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-audit-outputs-'));
    const httpRows: Record<string, unknown>[] = [];
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { httpRows.push(...JSON.parse(body).entries); response.end('{}'); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    const jsonl = new JsonlFlusher({ enabled: true, outputDir: root, rotateDaily: false });
    const httpOut = new HttpFlusher({ enabled: true, url: `http://127.0.0.1:${address.port}`,
      batchMaxSize: 10, flushIntervalMs: 99999, requestTimeoutMs: 5000 });
    const sls = new SlsFlusher({ enabled: true, mode: 'ak', endpoint: 'http://unused',
      accessKeyId: 'synthetic', accessKeySecret: 'synthetic', apiKey: '', serviceNamePrefix: '',
      endpoints: [{ name: 'test', endpoint: 'http://unused', project: 'synthetic', logstore: 'synthetic',
        kind: 'agentActivity', mode: 'ak', accessKeyId: 'synthetic', accessKeySecret: 'synthetic' }],
      batchMaxSize: 10, flushIntervalMs: 99999 }, root);
    slsSend.mockClear();
    try {
      await jsonl.start();
      const entries = [];
      for (const kind of ['invoke', 'result']) {
        const entry = await transformHookRecord({
          'event.id': `work-${kind}`, 'event.name': `gen_ai.agent.${kind}`,
          time_unix_nano: '1792400000000000000', 'user.id': 'user',
          'gen_ai.session.id': 'parent', 'gen_ai.turn.id': kind === 'invoke' ? 'dispatch-turn' : 'receive-turn',
          'gen_ai.agent.invocation.id': 'work', 'gen_ai.agent.parent.invocation.id': 'upstream',
          'gen_ai.provider.name': 'openai',
          [kind === 'invoke' ? 'gen_ai.input.messages' : 'gen_ai.output.messages']:
            [{ role: kind === 'invoke' ? 'user' : 'assistant', parts: [{ type: 'text', content: 'AKIAIOSFODNN7EXAMPLE' }] }],
        }, agent, agent);
        entries.push(maskAgentActivityEntry(entry!, { mode: 'all', types: [] }));
      }
      await jsonl.sendBatch(entries);
      await httpOut.sendBatch(entries); await httpOut.flush();
      await sls.sendBatch(entries); await sls.flush();
      const rows = (await fs.readFile(path.join(root, `${agent}-all.jsonl`), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
      const slsRows = slsSend.mock.calls.flatMap(call => call[2].logs.map((log: any) => log.content));
      for (const destination of [rows, httpRows, slsRows]) {
        expect(destination).toHaveLength(2);
        expect(destination.map((r: any) => r['event.name'])).toEqual(['gen_ai.agent.invoke', 'gen_ai.agent.result']);
        expect(destination.map((r: any) => r['gen_ai.turn.id'])).toEqual(['dispatch-turn', 'receive-turn']);
        expect(destination.every((r: any) => r['gen_ai.agent.invocation.id'] === 'work'
          && r['gen_ai.agent.parent.invocation.id'] === 'upstream')).toBe(true);
        expect(JSON.stringify(destination)).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(JSON.stringify(destination)).toContain('[ACCESSKEY_MASKED]');
      }
    } finally {
      await Promise.all([jsonl.shutdown(), httpOut.shutdown(), sls.shutdown()]);
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
