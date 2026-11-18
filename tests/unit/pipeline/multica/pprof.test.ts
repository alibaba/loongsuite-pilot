import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { collectPprof, convertPprof, type Flamebearer, type PprofKind } from '../../../../src/pipeline/input/multica/pprof.js';
import { validateMulticaConfig, type MulticaInputConfig } from '../../../../src/pipeline/input/multica/types.js';
import { MulticaPipeline } from '../../../../src/pipeline/input/multica/multica-pipeline.js';
import { postWebtracking } from '../../../../src/flushers/sls-transport.js';
import * as fsUtils from '../../../../src/utils/fs-utils.js';

vi.mock('../../../../src/utils/logger.js', () => ({createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()})}));
vi.mock('../../../../src/flushers/sls-transport.js', () => ({postWebtracking: vi.fn()}));
const input: MulticaInputConfig = {Type: 'input_multica'};
const fixture = (kind: PprofKind) => readFile(new URL(`../../../fixtures/multica/${kind}.pprof`, import.meta.url));
let servers: Server[];
let dir: string;
beforeEach(async () => {
  servers = [];
  dir = await mkdtemp(path.join(tmpdir(), 'multica-pprof-'));
  vi.mocked(postWebtracking).mockReset().mockResolvedValue();
});
afterEach(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(dir, {recursive: true, force: true});
});
async function server(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const s = createServer(handler); servers.push(s);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as {port: number}).port}`;
}
function pipeline(config: MulticaInputConfig): MulticaPipeline {
  return new MulticaPipeline({config: {configName: 'pprof', inputs: [config],
    flushers: [{Type: 'flusher_sls', Endpoint: 'https://example.invalid', Project: 'p', Logstore: 'multica-logs'}]},
    stateDir: dir, dataDir: dir, failedLogDir: dir});
}
function verifyFlamebearer(profile: Flamebearer): void {
  const {levels, names, numTicks} = profile.flamebearer;
  expect(levels[0]).toEqual([0, numTicks, 0, 0]);
  for (const level of levels) {
    expect(level.length % 4).toBe(0);
    let end = 0;
    for (let i = 0; i < level.length; i += 4) {
      const [delta, total, self, name] = level.slice(i, i + 4);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(total).toBeGreaterThanOrEqual(self);
      expect(self).toBeGreaterThanOrEqual(0);
      expect(names[name]).toBeTypeOf('string');
      end += delta + total;
    }
    expect(end).toBeLessThanOrEqual(numTicks);
  }
  expect(levels.reduce((sum, level) => sum + level.filter((_, i) => i % 4 === 2).reduce((a, b) => a + b, 0), 0)).toBe(numTicks);
}

describe('native pprof conversion', () => {
  it('preserves real CPU and delta allocation weights and stack orientation', async () => {
    const cpu = convertPprof(await fixture('cpu'), 'cpu', 'lab cpu');
    expect(cpu.profile.flamebearer.numTicks).toBe(17);
    expect(cpu.durationSeconds).toBe(30);
    expect(cpu.profile.metadata).toMatchObject({units: 'samples', sampleRate: 100});
    expect(cpu.timeMs).toBe(Date.parse('2026-11-17T03:42:50.707Z'));
    expect(cpu.profile.flamebearer.names).toContain('total');
    const roots = cpu.profile.flamebearer.levels[1].filter((_, i) => i % 4 === 3).map(id => cpu.profile.flamebearer.names[id]);
    expect(roots.some(name => name.startsWith('net/http.(*conn).serve '))).toBe(true);
    verifyFlamebearer(cpu.profile);
    const allocs = convertPprof(await fixture('allocs'), 'allocs', 'lab allocs');
    expect(allocs.profile.flamebearer.numTicks).toBe(10257869);
    expect(allocs.durationSeconds).toBeGreaterThanOrEqual(10);
    expect(allocs.profile.metadata.units).toBe('bytes');
    verifyFlamebearer(allocs.profile);
  });
  it('rejects wrong profile kinds, malformed input and decompression bombs', async () => {
    expect(() => convertPprof(Buffer.from('not protobuf'), 'cpu', 'bad')).toThrow('pprof_invalid_protobuf');
    expect(() => convertPprof(gzipSync(Buffer.alloc(100_000)), 'cpu', 'bomb', 1024)).toThrow('pprof_invalid_or_oversized_gzip');
    expect(() => convertPprof(Buffer.from([0x1f, 0x8b, 0]), 'cpu', 'bad')).toThrow('pprof_invalid_or_oversized_gzip');
    const allocs = await fixture('allocs');
    expect(() => convertPprof(allocs, 'cpu', 'wrong')).toThrow('pprof_unsupported_sample_type');
  });
  it('enforces independent opt-in, URL validation and sampling bounds', () => {
    validateMulticaConfig(input);
    validateMulticaConfig({...input, PprofBaseUrl: 'http://127.0.0.1:6060', PprofTypes: ['cpu'], PprofIntervalSeconds: 300});
    for (const config of [
      {PprofBaseUrl: 'http://user:password@localhost:6060'}, {PprofBaseUrl: 'http://localhost:6060?token=secret'},
      {PprofBaseUrl: 'http://localhost:6060/debug/pprof'}, {PprofCpuSeconds: 0}, {PprofCpuSeconds: 61},
      {PprofAllocsSeconds: 31}, {PprofIntervalSeconds: 299}, {PprofTypes: ['cpu', 'cpu']}, {PprofMaxBytes: 17 * 1024 * 1024},
    ]) expect(() => validateMulticaConfig({...input, ...config} as MulticaInputConfig)).toThrow();
  });
});

describe('profile HTTP reads and delivery', () => {
  it('fetches native endpoints without PAT, produces complete verifiable ASCII chunks and native time metadata', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'must-not-send');
    const cpu = await fixture('cpu'); const allocs = await fixture('allocs');
    const urls: string[] = [];
    const base = await server((req, res) => {
      urls.push(req.url!);
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers['x-workspace-id']).toBeUndefined();
      res.end(req.url!.includes('/profile') ? cpu : allocs);
    });
    const config = {...input, PprofBaseUrl: base, Instance: 'test 测试', PprofSourceVersion: 'v0.10.0', PprofPodName: 'backend-pod'};
    for (const kind of ['cpu', 'allocs'] as const) {
      const result = await collectPprof(config, kind);
      const records = result.records;
      const raw = records.map(row => row.profile_json_part).join('');
      expect(records.every(row => Buffer.byteLength(row.profile_json_part) <= 1800)).toBe(true);
      expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
      expect(records[0].profile_sha256).toBe(createHash('sha256').update(raw).digest('hex'));
      expect(new Set(records.map(row => row.entity_id)).size).toBe(records.length);
      expect(records[0]).toMatchObject({profile_part_count: String(records.length), profile_metadata_source: 'native_pprof',
        source_version: 'v0.10.0', pod_name: 'backend-pod'});
      expect(Number(records[0].profile_end_ms)).toBe(Date.parse(records[0].profile_ended_at));
      expect(result.checkpoint!.pprofNextCaptureAtMs).toBeGreaterThan(Date.now() + 899_000);
      verifyFlamebearer(JSON.parse(raw));
    }
    expect(urls).toEqual(['/debug/pprof/profile?seconds=30', '/debug/pprof/allocs?seconds=10']);
  });
  it('rejects redirects and oversized binary responses', async () => {
    const base = await server((req, res) => {
      if (req.url!.includes('/profile')) { res.writeHead(302, {Location: 'http://example.invalid/'}); res.end(); }
      else res.end(Buffer.alloc(2048));
    });
    await expect(collectPprof({...input, PprofBaseUrl: base}, 'cpu')).rejects.toThrow('pprof_http_302');
    await expect(collectPprof({...input, PprofBaseUrl: base, PprofMaxBytes: 1024}, 'allocs')).rejects.toThrow('pprof_response_too_large');
  });
  it('does not call pprof with the default off switch or without a Multica fingerprint', async () => {
    let calls = 0;
    const base = await server((_req, res) => { calls++; res.end('plain service'); });
    const config = {...input, PprofBaseUrl: base, PprofTypes: ['cpu'] as const};
    await pipeline({...config, PprofTypes: ['cpu']}).collectOnce();
    await pipeline({...config, PprofTypes: ['cpu'], CollectionMode: 'on'}).collectOnce();
    expect(calls).toBe(0);
    expect(postWebtracking).not.toHaveBeenCalled();
  });
  it('replays the exact profile after SLS failure and persists the sampling cooldown after ACK', async () => {
    const cpu = await fixture('cpu');
    let captures = 0;
    const base = await server((req, res) => {
      if (req.url === '/metrics') res.end('multica_test_total 1\n');
      else { captures++; res.end(cpu); }
    });
    const config: MulticaInputConfig = {...input, CollectionMode: 'on', MetricsUrls: [`${base}/metrics`], PprofBaseUrl: base, PprofTypes: ['cpu']};
    let failed = false;
    vi.mocked(postWebtracking).mockImplementation(async (_target, records) => {
      if (!failed && records.some(row => row.record_type === 'pprof_profile_chunk')) { failed = true; throw new Error('network down'); }
    });
    const first = pipeline(config);
    expect((await first.collectOnce()).failedSources).toBe(1);
    const oldBatch = vi.mocked(postWebtracking).mock.calls.find(([, rows]) => rows.some(row => row.record_type === 'pprof_profile_chunk'))![1];
    const second = pipeline(config);
    expect((await second.collectOnce()).failedSources).toBe(0);
    expect(captures).toBe(1);
    const batches = vi.mocked(postWebtracking).mock.calls.filter(([, rows]) => rows.some(row => row.record_type === 'pprof_profile_chunk'));
    expect(batches[1][1]).toEqual(oldBatch);
    await pipeline(config).collectOnce();
    expect(captures).toBe(1);
  });
  it('reuses the captured profile when the durable spool cannot be written', async () => {
    const cpu = await fixture('cpu');
    let captures = 0;
    const base = await server((req, res) => {
      if (req.url === '/metrics') res.end('multica_test_total 1\n');
      else { captures++; res.end(cpu); }
    });
    const nativeWrite = fsUtils.writeJsonFile;
    let failed = false;
    vi.spyOn(fsUtils, 'writeJsonFile').mockImplementation(async (file, value) => {
      if (!failed && JSON.stringify(value).includes('pprof_profile_chunk')) {
        failed = true;
        throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
      }
      return nativeWrite(file, value);
    });
    const p = pipeline({...input, CollectionMode: 'on', MetricsUrls: [`${base}/metrics`], PprofBaseUrl: base, PprofTypes: ['cpu']});
    expect((await p.collectOnce()).failedSources).toBe(1);
    expect((await p.collectOnce()).failedSources).toBe(0);
    expect(captures).toBe(1);
    expect(vi.mocked(postWebtracking).mock.calls.filter(([, rows]) => rows.some(row => row.record_type === 'pprof_profile_chunk'))).toHaveLength(1);
  });
  it('backs off unavailable profiles while continuing metrics', async () => {
    let captures = 0; let metrics = 0;
    const base = await server((req, res) => {
      if (req.url === '/metrics') { metrics++; res.end('multica_test_total 1\n'); }
      else { captures++; res.writeHead(503); res.end(); }
    });
    const p = pipeline({...input, CollectionMode: 'on', MetricsUrls: [`${base}/metrics`], PprofBaseUrl: base, PprofTypes: ['cpu']});
    expect((await p.collectOnce()).failedSources).toBe(1);
    await p.collectOnce();
    expect(captures).toBe(1);
    expect(metrics).toBe(4);
  });
});
