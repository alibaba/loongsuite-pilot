import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourcePodLabels } from '../../../../src/pipeline/input/multica/pod-labels.js';
import { digest, envelope } from '../../../../src/pipeline/input/multica/records.js';
import type { MulticaInputConfig } from '../../../../src/pipeline/input/multica/types.js';

const input: MulticaInputConfig = {Type: 'input_multica'};
const metric = 'metrics:http://127.0.0.1:9090/metrics';
const row = {record_type: 'prometheus_sample', entity_id: 'counter', metric_value: '100'};

afterEach(() => vi.unstubAllEnvs());

describe('Multica replica identity', () => {
  it('assigns the same local source Pod to data and completion markers and keeps simultaneous replicas distinct', () => {
    vi.stubEnv('POD_NAME', 'server-a');
    vi.stubEnv('POD_UID', 'uid-a');
    vi.stubEnv('POD_IP', '10.0.0.1');
    const replicaA = sourcePodLabels(input, metric);
    const replicaB = sourcePodLabels({...input, PodName: 'server-b', PodUid: 'uid-b', PodIp: '10.0.0.2'}, metric);
    const a = envelope(input, metric, 1000, row, undefined, replicaA);
    const b = envelope(input, metric, 1000, row, undefined, replicaB);
    expect(a).toMatchObject({pod_name: 'server-a', pod_uid: 'uid-a', pod_ip: '10.0.0.1', instance: 'multica'});
    expect(b).toMatchObject({pod_name: 'server-b', collector_pod_uid: 'uid-b', pod_ip: '10.0.0.2', instance: 'multica'});
    expect(a.event_id).not.toBe(b.event_id);
    expect(a.snapshot_id).not.toBe(b.snapshot_id);
    expect(envelope(input, metric, 1000, {record_type: 'collection_status'}, undefined, replicaA).snapshot_id).toBe(a.snapshot_id);
  });

  it('keeps the collector identity separate from a business workspace, a remote service or a bridged log source', () => {
    const local = {...input, PodName: 'server-a', PodUid: 'uid-a', PodIp: '10.0.0.1'};
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

    expect(sourcePodLabels(local, 'health:http://10.0.0.1:4317/health')).toMatchObject({pod_uid: 'uid-a'});
    expect(sourcePodLabels({...local, PodIp: 'fd00:0:0:0:0:0:0:1'}, 'metrics:http://[fd00::1]:9090/metrics')).toMatchObject({pod_uid: 'uid-a'});
  });

  it('preserves historical ID derivation and omits the labels when no Pod metadata exists', () => {
    vi.stubEnv('POD_NAME', ''); vi.stubEnv('POD_UID', ''); vi.stubEnv('POD_IP', '');
    const labels = sourcePodLabels(input, metric);
    expect(labels).toEqual({});
    const sample = envelope(input, metric, 1000, row, undefined, labels);
    expect(sample.snapshot_id).toBe(digest(`${metric}\0${1000}`).slice(0, 24));
    expect(sample.event_id).toBe(digest(`multica\0${metric}\0${1000}\0${JSON.stringify(row)}`));
  });
});
