import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendMulticaRecords } from '../../../../src/pipeline/input/multica/sender.js';
import { postApiKeyLogStoreLogs, postWebtracking, WEBTRACKING_MAX_BODY_BYTES, WEBTRACKING_MAX_LOGS } from '../../../../src/flushers/sls-transport.js';

vi.mock('../../../../src/flushers/sls-transport.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/flushers/sls-transport.js')>(),
  postApiKeyLogStoreLogs: vi.fn().mockResolvedValue(undefined),
  postWebtracking: vi.fn().mockResolvedValue(undefined),
}));

const destination = {
  Type: 'flusher_sls' as const,
  Endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
  Project: 'installer-project',
  Logstore: 'multica-logs',
  mode: 'apiKey' as const,
  apiKey: 'unit-test-api-key',
};
const record = {record_type: 'task_snapshot', event_id: 'stable-id', observed_at: '2026-11-18T00:00:00.000Z', task_id: 'task-a', status: 'running'};

beforeEach(() => { vi.clearAllMocks(); });

describe('Multica SLS sender', () => {
  it('sends original records through the API Key transport with dashboard tags and observation time', async () => {
    await sendMulticaRecords(destination, [record], 'server-a');
    expect(postWebtracking).not.toHaveBeenCalled();
    expect(postApiKeyLogStoreLogs).toHaveBeenCalledTimes(1);
    expect(postApiKeyLogStoreLogs).toHaveBeenCalledWith({
      endpoint: destination.Endpoint, project: destination.Project, logstore: 'multica-logs', apiKey: 'unit-test-api-key',
    }, {
      logs: [{timestamp: Date.parse(record.observed_at) / 1000, content: record}],
      topic: 'multica', source: 'server-a', tags: [{pipeline_type: 'multica', schema_version: 'multica.v1'}],
    });
  });

  it('preserves Webtracking for explicitly configured legacy destinations', async () => {
    await sendMulticaRecords({...destination, mode: 'webtracking', apiKey: undefined}, [record], 'server-a');
    expect(postApiKeyLogStoreLogs).not.toHaveBeenCalled();
    expect(postWebtracking).toHaveBeenCalledTimes(1);
    expect(postWebtracking).toHaveBeenCalledWith({
      endpoint: destination.Endpoint, project: destination.Project, logstore: 'multica-logs',
    }, [record], {topic: 'multica', source: 'server-a', tags: {pipeline_type: 'multica', schema_version: 'multica.v1'}});
  });

  it('splits large snapshots into bounded requests without changing IDs or field content', async () => {
    const records = Array.from({length: WEBTRACKING_MAX_LOGS + 1}, (_, index) => ({...record, event_id: String(index)}));
    await sendMulticaRecords(destination, records, 'server-a');
    const groups = vi.mocked(postApiKeyLogStoreLogs).mock.calls.map(call => call[1]);
    expect(groups.map(group => group.logs.length)).toEqual([WEBTRACKING_MAX_LOGS, 1]);
    expect(groups.flatMap(group => group.logs.map(log => log.content))).toEqual(records);
  });

  it('propagates later chunk failure so the pipeline retains the entire durable batch', async () => {
    const unavailable = new Error('unauthorized');
    vi.mocked(postApiKeyLogStoreLogs).mockResolvedValueOnce().mockRejectedValueOnce(unavailable);
    const records = Array.from({length: WEBTRACKING_MAX_LOGS + 1}, (_, index) => ({...record, event_id: String(index)}));
    await expect(sendMulticaRecords(destination, records, 'server-a')).rejects.toBe(unavailable);
    expect(postApiKeyLogStoreLogs).toHaveBeenCalledTimes(2);
    expect(records[0].event_id).toBe('0');
  });

  it('uses current time when a record has no valid observation timestamp', async () => {
    const before = Math.floor(Date.now() / 1000);
    await sendMulticaRecords(destination, [{event_id: 'no-time'}, {...record, observed_at: 'invalid'}], 'server-a');
    const logs = vi.mocked(postApiKeyLogStoreLogs).mock.calls[0][1].logs;
    for (const log of logs) {
      expect(log.timestamp).toBeGreaterThanOrEqual(before);
      expect(log.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    }
  });

  it('rejects missing credentials or unsupported modes without downgrading authentication', async () => {
    await expect(sendMulticaRecords({...destination, apiKey: ''}, [record], 'server-a')).rejects.toThrow('Missing Multica SLS API Key');
    await expect(sendMulticaRecords({...destination, mode: 'ak'}, [record], 'server-a')).rejects.toThrow('Unsupported Multica SLS authentication mode');
    expect(postApiKeyLogStoreLogs).not.toHaveBeenCalled();
    expect(postWebtracking).not.toHaveBeenCalled();
  });

  it('rejects one oversized record without truncating or sending a partial batch', async () => {
    await expect(sendMulticaRecords(destination, [record, {stack: 'x'.repeat(WEBTRACKING_MAX_BODY_BYTES)}], 'server-a'))
      .rejects.toThrow('Multica SLS record exceeds the batch size limit');
    expect(postApiKeyLogStoreLogs).not.toHaveBeenCalled();
  });

  it('does not send empty batches', async () => {
    await sendMulticaRecords(destination, [], 'server-a');
    expect(postApiKeyLogStoreLogs).not.toHaveBeenCalled();
    expect(postWebtracking).not.toHaveBeenCalled();
  });
});
