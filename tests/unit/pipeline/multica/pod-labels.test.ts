import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMulticaLog } from '../../../../src/pipeline/input/multica/parsers.js';
import { sourcePodLabels } from '../../../../src/pipeline/input/multica/pod-labels.js';
import { digest, envelope } from '../../../../src/pipeline/input/multica/records.js';
import type { MulticaInputConfig } from '../../../../src/pipeline/input/multica/types.js';

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  return {...os, hostname: vi.fn(os.hostname)};
});

const input: MulticaInputConfig = {Type: 'input_multica'};
const metric = 'metrics:http://127.0.0.1:9090/metrics';
const row = {record_type: 'prometheus_sample', entity_id: 'counter', metric_value: '100'};

beforeEach(() => { vi.stubEnv('POD_NAME', ''); });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(hostname).mockReset();
});

describe('Multica replica identity', () => {
  it('assigns the same local source Pod to data and completion markers and keeps simultaneous replicas distinct', () => {
    vi.mocked(hostname).mockReturnValue('server-a');
    vi.stubEnv('POD_UID', 'uid-a');
    vi.stubEnv('POD_IP', '10.0.0.1');
    const replicaA = sourcePodLabels(input, metric);
    vi.mocked(hostname).mockReturnValue('server-b');
    const replicaB = sourcePodLabels({...input, PodUid: 'uid-b', PodIp: '10.0.0.2'}, metric);
    const a = envelope(input, metric, 1000, row, undefined, replicaA);
    const b = envelope(input, metric, 1000, row, undefined, replicaB);
    expect(a).toMatchObject({pod_name: 'server-a', pod_uid: 'uid-a', pod_ip: '10.0.0.1', instance: 'multica'});
    expect(b).toMatchObject({pod_name: 'server-b', collector_pod_uid: 'uid-b', pod_ip: '10.0.0.2', instance: 'multica'});
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.snapshot_id).not.toBe(b.snapshot_id);
    expect(envelope(input, metric, 1000, {record_type: 'collection_status'}, undefined, replicaA).snapshot_id).toBe(a.snapshot_id);
  });

  it('uses the explicit Pod name for local sources and as the observer of remote and bridged sources', () => {
    vi.mocked(hostname).mockReturnValue('custom-hostname');
    vi.stubEnv('POD_NAME', 'server-a');
    const local = {...input, PodUid: 'uid-a', PodIp: '10.0.0.1'};
    const observer = {collector_pod_name: 'server-a', collector_pod_uid: 'uid-a', collector_pod_ip: '10.0.0.1'};
    for (const source of ['api:w:issues', 'metrics:http://127.svc.cluster.local/metrics',
      'health:http://daemon.ns.svc:4317/health', 'log:/logs/backend.log']) {
      expect(sourcePodLabels(local, source)).toEqual(observer);
    }
    const profile = sourcePodLabels({...local, PprofPodName: 'target-b', PprofBaseUrl: 'http://target-b:6060'}, 'pprof:http://target-b:6060:cpu');
    expect(profile).toEqual({...observer, pod_name: 'target-b'});
    const forwarded = sourcePodLabels({...local, PprofPodName: 'target-b', PprofBaseUrl: 'http://127.0.0.1:6060'}, 'pprof:http://127.0.0.1:6060:cpu');
    expect(forwarded).toEqual({...observer, pod_name: 'target-b'});
    const line = envelope(input, 'log:/logs/backend.log', 1000, {pod_name: 'origin', pod_uid: 'uid-origin'}, 'stable', observer);
    expect(line).toMatchObject({pod_name: 'origin', pod_uid: 'uid-origin', collector_pod_name: 'server-a'});

    expect(sourcePodLabels(local, 'health:http://10.0.0.1:4317/health')).toMatchObject({pod_name: 'server-a', pod_uid: 'uid-a'});
    expect(sourcePodLabels({...local, PprofBaseUrl: 'http://localhost:6060'}, 'pprof:http://localhost:6060:cpu'))
      .toMatchObject({pod_name: 'server-a', collector_pod_name: 'server-a'});
    expect(sourcePodLabels({...local, PodIp: 'fd00:0:0:0:0:0:0:1'}, 'metrics:http://[fd00::1]:9090/metrics')).toMatchObject({pod_uid: 'uid-a'});
  });

  it('falls back to the hostname when the explicit Pod name is invalid', () => {
    vi.mocked(hostname).mockReturnValue('server-a');
    vi.stubEnv('POD_NAME', 'invalid/pod');
    expect(sourcePodLabels(input, metric)).toMatchObject({pod_name: 'server-a', collector_pod_name: 'server-a'});
  });

  it('separates simultaneous local samples and daemon logs by POD_NAME under a shared hostname', () => {
    vi.mocked(hostname).mockReturnValue('shared-host');
    vi.stubEnv('POD_UID', '');
    vi.stubEnv('POD_IP', '');
    const cfg = {...input, PprofBaseUrl: 'http://localhost:6060'};
    const log = parseMulticaLog('12:00:01.123 ERR task failed task_id=t1')!;
    const sources = [[metric, row], ['health:http://localhost:4317/health', {record_type: 'daemon_health'}],
      ['pprof:http://localhost:6060:cpu', {record_type: 'pprof_profile_chunk'}],
      ['log:/root/.multica/daemon.log', log]] as const;
    const [a, b] = ['backend-a', 'backend-b'].map(name => {
      vi.stubEnv('POD_NAME', name);
      return sources.map(([source, record]) => {
        const labels = sourcePodLabels({...cfg, LocalDaemonPid: 1}, source);
        expect(labels).toEqual({pod_name: name, collector_pod_name: name});
        return envelope(cfg, source, 1000, record, undefined, labels);
      });
    });
    for (const [index, sample] of a.entries()) {
      expect(sample.event_id).not.toBe(b[index].event_id);
      expect(sample.snapshot_id).not.toBe(b[index].snapshot_id);
    }
  });

  it('preserves historical ID derivation and omits the labels when the hostname and Pod metadata are unavailable', () => {
    vi.mocked(hostname).mockReturnValue(''); vi.stubEnv('POD_UID', ''); vi.stubEnv('POD_IP', '');
    const labels = sourcePodLabels(input, metric);
    expect(labels).toEqual({});
    const sample = envelope(input, metric, 1000, row, undefined, labels);
    expect(sample.snapshot_id).toBe(digest(`${metric}\0${1000}`).slice(0, 24));
    expect(sample.event_id).toBe(digest(`multica\0${metric}\0${1000}\0${JSON.stringify(row)}`));
  });
});
