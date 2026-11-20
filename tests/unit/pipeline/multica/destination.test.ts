import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MulticaPipeline } from '../../../../src/pipeline/input/multica/multica-pipeline.js';
import { resolveMulticaDestination, type MulticaSlsDefaults, type MulticaSlsFlusherConfig } from '../../../../src/pipeline/input/multica/destination.js';
import { digest } from '../../../../src/pipeline/input/multica/records.js';
import { postWebtracking } from '../../../../src/flushers/sls-transport.js';

vi.mock('../../../../src/utils/logger.js', () => ({createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()})}));
vi.mock('../../../../src/flushers/sls-transport.js', () => ({postWebtracking: vi.fn()}));
vi.mock('../../../../src/pipeline/input/multica/activation.js', () => ({MulticaActivationGate: class {
  async evaluate() { return {enabled: true, mode: 'on', reason: 'metrics_detected', consecutiveMisses: 0, stopped: false}; }
}}));

let dir: string;
const original: MulticaSlsFlusherConfig = {Type: 'flusher_sls', Endpoint: 'cn-hongkong.log.aliyuncs.com', Project: 'agentspace-a'};
function collector(flusher: MulticaSlsFlusherConfig = original) {
  return new MulticaPipeline({
    config: {configName: 'multica', inputs: [{Type: 'input_multica', LogFiles: [path.join(dir, 'server.log')]}], flushers: [flusher]},
    stateDir: dir, dataDir: dir, failedLogDir: dir,
  });
}
function logs() { return vi.mocked(postWebtracking).mock.calls.flatMap(call => call[1]).filter(row => row.record_type === 'server_log'); }
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'multica-destination-')); vi.mocked(postWebtracking).mockReset().mockResolvedValue(); });
afterEach(async () => { await rm(dir, {recursive: true, force: true}); });

describe('Multica dispatched destination', () => {
  it('defaults only the logstore and retains the user-dispatched endpoint and project', () => {
    expect(resolveMulticaDestination(original)).toMatchObject({Endpoint: 'https://cn-hongkong.log.aliyuncs.com', Project: 'agentspace-a', Logstore: 'multica-logs'});
    expect(resolveMulticaDestination({...original, Project: 'another-agentspace', Logstore: 'explicit-store'}))
      .toMatchObject({Project: 'another-agentspace', Logstore: 'explicit-store'});
    expect(() => resolveMulticaDestination({...original, Project: ''})).toThrow();
    expect(() => resolveMulticaDestination({...original, Logstore: ''})).toThrow();
    for (const Endpoint of ['https://secret@host', 'https://host/track', 'https://host?token=private', 'https://agentspace-a.cn-hongkong.log.aliyuncs.com']) {
      expect(() => resolveMulticaDestination({...original, Endpoint})).toThrow();
    }
  });

  it.each([
    {Project: 'agentspace-b'},
    {Endpoint: 'cn-hangzhou.log.aliyuncs.com'},
    {Logstore: 'another-store'},
  ])('does not replay pending data to a changed destination: %j', async change => {
    await writeFile(path.join(dir, 'server.log'), 'INFO comment created issue_id=original-event\n');
    vi.mocked(postWebtracking).mockRejectedValue(new Error('offline'));
    await collector().collectOnce();
    const pendingDir = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.multica-pending'))!);
    const pendingFile = path.join(pendingDir, (await readdir(pendingDir))[0]);
    const pending = await readFile(pendingFile, 'utf8');
    await writeFile(path.join(dir, 'server.log'), 'INFO comment created issue_id=current-event\n');
    vi.mocked(postWebtracking).mockClear().mockResolvedValue();
    await collector({...original, ...change}).collectOnce();
    expect(logs().map(row => row.issue_id)).toEqual(['current-event']);
    expect(await readFile(pendingFile, 'utf8')).toBe(pending);
    vi.mocked(postWebtracking).mockClear();
    await collector().collectOnce();
    expect(logs().map(row => row.issue_id)).toEqual(['original-event']);
    expect(logs()[0].event_id).toBe(JSON.parse(pending).records[0].event_id);
  });

  it('starts fresh log offsets for a new project but reuses them for the same normalized destination', async () => {
    const file = path.join(dir, 'server.log');
    await writeFile(file, 'INFO comment created issue_id=one\n');
    await collector().collectOnce();
    await appendFile(file, 'INFO comment created issue_id=two\n');
    vi.mocked(postWebtracking).mockClear();
    await collector({...original, Endpoint: 'https://cn-hongkong.log.aliyuncs.com/', Logstore: 'multica-logs'}).collectOnce();
    expect(logs().map(row => row.issue_id)).toEqual(['two']);
    vi.mocked(postWebtracking).mockClear();
    await collector({...original, Project: 'agentspace-b'}).collectOnce();
    expect(logs().map(row => row.issue_id)).toEqual(['one', 'two']);
  });

  it('does not adopt legacy pending records without a destination identity', async () => {
    const legacy = path.join(dir, 'multica.multica-pending');
    const file = path.join(dir, 'server.log');
    const pendingName = `${digest(`log:${file}`)}.json`;
    await mkdir(legacy);
    await writeFile(path.join(legacy, pendingName), JSON.stringify({records: [{record_type: 'server_log', issue_id: 'old-destination'}]}));
    await writeFile(file, 'INFO comment created issue_id=current\n');
    await collector().collectOnce();
    expect(logs().map(row => row.issue_id)).toEqual(['current']);
    expect(await readdir(legacy)).toEqual([pendingName]);
  });
});

describe('Multica installed SLS inheritance', () => {
  const installed: MulticaSlsDefaults = {enabled: true, endpoints: [{
    name: 'user-sls', endpoint: 'https://cn-hangzhou.log.aliyuncs.com/', project: 'agentloop-installed',
    logstore: 'agent-event', kind: 'agentActivity', mode: 'apiKey', apiKey: 'dummy-installed-api-key',
  }]};
  const inherited = {Type: 'flusher_sls'} as const;

  it('inherits endpoint, project and authentication without inheriting the ordinary agent logstore', () => {
    for (const flusher of [undefined, inherited]) {
      expect(resolveMulticaDestination(flusher, installed)).toEqual({
        Type: 'flusher_sls', Endpoint: 'https://cn-hangzhou.log.aliyuncs.com', Project: 'agentloop-installed',
        Logstore: 'multica-logs', mode: 'apiKey', apiKey: 'dummy-installed-api-key',
      });
    }
    expect(resolveMulticaDestination({...inherited, Logstore: 'custom-multica'}, installed).Logstore).toBe('custom-multica');
    expect(installed.endpoints[0].logstore).toBe('agent-event');
  });

  it('inherits authentication only for the exact explicit endpoint and project', () => {
    expect(resolveMulticaDestination({Type: 'flusher_sls', Endpoint: 'cn-hangzhou.log.aliyuncs.com', Project: 'agentloop-installed'}, installed))
      .toMatchObject({mode: 'apiKey', apiKey: 'dummy-installed-api-key'});
    for (const target of [original, {...original, Endpoint: 'cn-hangzhou.log.aliyuncs.com'}, {...original, Project: 'agentloop-installed'}]) {
      const resolved = resolveMulticaDestination(target, installed);
      expect(resolved.mode).toBe('webtracking');
      expect(resolved).not.toHaveProperty('apiKey');
    }
    expect(() => resolveMulticaDestination({...inherited, Project: 'another-project'}, installed)).toThrow('set together');
    expect(() => resolveMulticaDestination({...inherited, Endpoint: 'different.example'}, installed)).toThrow('set together');
  });

  it('requires selection among multiple projects and does not deduplicate differing credentials', () => {
    const other = {...installed.endpoints[0], name: 'second', project: 'another-project', apiKey: 'dummy-second-key'};
    const multi = {...installed, endpoints: [...installed.endpoints, other]};
    expect(() => resolveMulticaDestination(inherited, multi)).toThrow('Ambiguous');
    expect(resolveMulticaDestination({...inherited, Endpoint: other.endpoint, Project: other.project}, multi))
      .toMatchObject({Project: 'another-project', apiKey: 'dummy-second-key'});
    const differentLogstores = {...installed, endpoints: [...installed.endpoints, {...installed.endpoints[0], logstore: 'other-logs'}]};
    expect(resolveMulticaDestination(inherited, differentLogstores).Project).toBe('agentloop-installed');
    expect(() => resolveMulticaDestination(inherited, {...installed, endpoints: [...installed.endpoints,
      {...installed.endpoints[0], apiKey: 'conflicting-key'}]})).toThrow('Ambiguous');
  });

  it('keeps explicit standalone targets independent of unrelated malformed installed targets', () => {
    const broken = {...installed, enabled: false, endpoints: [{...installed.endpoints[0], endpoint: ''}]};
    expect(resolveMulticaDestination(original, broken)).toMatchObject({Project: 'agentspace-a', mode: 'webtracking'});
    expect(resolveMulticaDestination(original, broken)).not.toHaveProperty('apiKey');
    expect(() => resolveMulticaDestination(inherited, broken)).toThrow('Invalid inherited');
  });

  it('rejects disabled, missing, ambiguous, or unsupported installed authentication without downgrading', () => {
    expect(() => resolveMulticaDestination(inherited)).toThrow();
    expect(() => resolveMulticaDestination(inherited, {...installed, enabled: false})).toThrow('disabled');
    for (const change of [{apiKey: ''}, {accessKeyId: 'dummy-ak'}, {mode: 'ak' as const, apiKey: undefined, accessKeyId: 'dummy-ak', accessKeySecret: 'dummy-sk'}]) {
      expect(() => resolveMulticaDestination(inherited, {...installed, endpoints: [{...installed.endpoints[0], ...change}]})).toThrow();
    }
  });
});
