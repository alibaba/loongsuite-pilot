import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { BaseHookInput } from '../../src/inputs/base/base-hook-input.js';
import { LogRetentionService, OUTPUT_RETENTION_MAX_TOTAL_BYTES, RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES } from '../../src/core/log-retention-service.js';
import { ClientType } from '../../src/types/index.js';
import type { AgentActivityEntry, LogRetentionConfig } from '../../src/types/index.js';
import { appendRawJsonl } from '../../assets/hooks/shared/raw-jsonl-writer.mjs';
import { withSyncFileLock } from '../../assets/hooks/shared/sync-file-lock.mjs';
import { DshLogInput } from '../../src/inputs/dsh-log/dsh-log-input.js';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { KiroCliLogInput } from '../../src/inputs/kiro-cli-log/kiro-cli-log-input.js';
import { QwenWorkCNTraceInput } from '../../src/inputs/qwen-work-cn/qwen-work-cn-trace-input.js';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { QoderCnTraceInput } from '../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { QoderWorkTraceInput } from '../../src/inputs/qoder-work-trace/qoder-work-trace-input.js';
import { QoderLegacyHookReader } from '../../src/inputs/qoder-trace/legacy-hook-reader.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import { spawn } from 'node:child_process';
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});

class Input extends BaseHookInput {
  readonly id = 'raw-test';
  readonly agentType = ClientType.ClaudeCliHook;
  protected async transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry> {
    return { 'event.id': String(record.id) } as AgentActivityEntry;
  }
}
const config: LogRetentionConfig = {
  enabled: true, intervalMs: 3600000, hookHistoryDays: 7, hookErrorDays: 7,
  hookDebugDays: 7, outputDays: 7, slsFailedDays: 7, otlpFailedDays: 7, metricAlarmDays: 7,
};
const oldDate = () => {
  const d = new Date(); d.setDate(d.getDate() - 10);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const oldTime = () => new Date(Date.now() - 10 * 86400000);

describe('raw source disk retention', () => {
  let root: string, dir: string, file: string, store: StateStore;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'raw-retention-')));
    dir = path.join(root, 'logs', 'claude-code');
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, 'raw-' + oldDate() + '.jsonl');
    store = new StateStore(path.join(root, 'logs', 'input-state.json'));
  });
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
  async function consume() {
    const input = new Input({ logDir: dir, logPrefix: 'raw', stateStore: store });
    const ids: string[] = [];
    input.on('entries', entries => ids.push(...entries.map((e: AgentActivityEntry) => e['event.id'])));
    await input.start(); await input.stop();
    return ids;
  }
  function seed() { store.set('raw-test', { lastFile: path.basename(file), extra: { hookLogOffsets: { [path.basename(file)]: 0 } } }); }
  const append = (id: string) => appendRawJsonl(file, JSON.stringify({ id }) + '\n', 16);

  describe.each([
    ['qoder', QoderTraceInput], ['qoder-cn', QoderCnTraceInput], ['qoder-work', QoderWorkTraceInput],
  ] as const)('%s primary trace retention', (prefix, TraceInput) => {
    async function setup(offset?: number, extra = {}) {
      const logDir = path.join(root, 'logs', prefix, 'history');
      await fs.mkdir(logDir, { recursive: true });
      const name = `${prefix}-${oldDate()}.jsonl`;
      const source = path.join(logDir, name);
      await fs.writeFile(source, '{}\n');
      await fs.utimes(source, oldTime(), oldTime());
      const input = new TraceInput({ stateStore: store, logDir, dataDir: root,
        sdkLogDir: path.join(root, 'sdk'), segmentsRoot: path.join(root, 'segments') });
      if (offset !== undefined) store.set(input.id, { lastFile: name, lastOffset: offset,
        extra: { preserved: 'native-state', ...extra } });
      await store.save();
      return { input, logDir, name, source };
    }

    it('migrates a consumed legacy daily file without a current-day file and reclaims it after restart', async () => {
      const { input, name, source } = await setup(3);
      await (input as unknown as { readHookJsonl(): Promise<AgentActivityEntry[]> }).readHookJsonl();
      expect(store.isPersisted(input.id)).toBe(false);
      expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 0 });
      await input.start(); await input.stop();
      expect(store.get(input.id).extra).toMatchObject({ preserved: 'native-state', hookLogOffsets: { [name]: 3 } });
      const reloaded = new StateStore(path.join(root, 'logs', 'input-state.json'));
      await reloaded.load();
      expect(await new LogRetentionService(root, config, reloaded).runCleanup()).toMatchObject({ deleted: 1, errors: 0 });
      await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each(['unread', 'partial', 'quarantined', 'replaced'] as const)('preserves %s legacy sources', async mode => {
      const { input, name, source } = await setup(mode === 'unread' ? undefined : mode === 'partial' ? 1 : 3,
        mode === 'quarantined' ? { qoderLegacyQuarantine: [{ file: `${prefix}-${oldDate()}.jsonl` }] } : {});
      await input.start(); await input.stop();
      if (mode === 'replaced') {
        await fs.rename(source, source + '.original');
        await fs.writeFile(source, '{}\n');
        await fs.utimes(source, oldTime(), oldTime());
      }
      expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 0 });
      expect(await fs.readFile(source, 'utf8')).toBe('{}\n');
      if (mode === 'unread') expect(store.get(input.id).extra?.hookLogOffsets ?? {}).not.toHaveProperty(name);
    });

    it('registers new progress, protects incomplete tails and waits for durable state', async () => {
      const { input, logDir, source } = await setup();
      await fs.unlink(source);
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const current = path.join(logDir, name);
      const row = JSON.stringify({ 'event.name': 'test', 'event.id': 'new', 'gen_ai.agent.type': prefix }) + '\n';
      await fs.writeFile(current, row + '{');
      store.set(input.id, { lastFile: name, lastOffset: 0 });
      const reader = input as unknown as { readHookJsonl(): Promise<AgentActivityEntry[]> };
      expect(await reader.readHookJsonl()).toHaveLength(1);
      expect(store.get(input.id).extra?.hookLogOffsets).toMatchObject({ [name]: Buffer.byteLength(row) });
      await store.save();
      expect(store.isPersisted(input.id)).toBe(true);
      await reader.readHookJsonl();
      // An idle partial tail must not dirty the state or become an EOF ACK.
      expect(store.isPersisted(input.id)).toBe(true);
      await fs.appendFile(current, '}\n');
      await reader.readHookJsonl();
      expect(store.isPersisted(input.id)).toBe(false);
      await fs.utimes(current, oldTime(), oldTime());
      expect(await new LogRetentionService(root, { ...config, hookHistoryDays: 0 }, store).runCleanup()).toMatchObject({ deleted: 0 });
      await input.stop();
    });

    it('keeps per-file ACKs across daily rollover and reclaims the older generation', async () => {
      const { input, logDir, source } = await setup();
      await fs.unlink(source);
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const current = path.join(logDir, name);
      const row = JSON.stringify({ 'event.name': 'test', 'gen_ai.agent.type': prefix }) + '\n';
      await fs.writeFile(current, row);
      store.set(input.id, { lastFile: name, lastOffset: 0 });
      const reader = input as unknown as { readHookJsonl(): Promise<AgentActivityEntry[]> };
      await reader.readHookJsonl();
      await store.save();
      const nextDate = Date.now() + 10 * 86400000;
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(nextDate);
        const nextName = `${prefix}-${getTodayDateString()}.jsonl`;
        await fs.writeFile(path.join(logDir, nextName), row);
        expect(await reader.readHookJsonl()).toHaveLength(1);
        expect(store.get(input.id).extra?.hookLogOffsets).toMatchObject({ [name]: row.length, [nextName]: row.length });
        await store.save();
        expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 1 });
        await expect(fs.stat(current)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(path.join(logDir, nextName), 'utf8')).toBe(row);
      } finally { vi.useRealTimers(); }
    });

    it('keeps quarantined evidence even when its complete oversized line reaches EOF', async () => {
      const { input, logDir, source } = await setup();
      await fs.unlink(source);
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const current = path.join(logDir, name);
      const row = prefix === 'qoder-work' ? 'x'.repeat(16 * 1024 * 1024) + '\n'
        : JSON.stringify({ text: 'x'.repeat(128) }) + '\n';
      await fs.writeFile(current, row);
      store.set(input.id, { lastFile: name, lastOffset: 0 });
      const reader = input as unknown as { legacyHookReader: QoderLegacyHookReader; readHookJsonl(): Promise<AgentActivityEntry[]> };
      if (prefix !== 'qoder-work') reader.legacyHookReader = new QoderLegacyHookReader(1024, 16);
      await reader.readHookJsonl();
      await reader.readHookJsonl();
      expect(store.get(input.id).extra).toMatchObject({ hookLogOffsets: { [name]: row.length },
        hookLogRetentionBlocked: { [name]: true } });
      await store.save();
      const later = Date.now() + 10 * 86400000;
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(later);
        expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 0 });
        expect(await fs.readFile(current, 'utf8')).toBe(row);
      } finally { vi.useRealTimers(); }
    });
  });

  it('drains ordered stable segments and reclaims only durable closed segments across restart', async () => {
    const paths = [append('1'), append('2'), append('3')];
    expect(new Set(paths).size).toBe(3);
    seed();
    expect(await consume()).toEqual(['1', '2', '3']);
    const service = new LogRetentionService(root, config, store);
    expect(await service.runCleanup()).toMatchObject({ deleted: 2, errors: 0 });
    await expect(fs.stat(paths[2])).resolves.toBeDefined();
    store = new StateStore(path.join(root, 'logs', 'input-state.json'));
    await store.load();
    append('4');
    expect(await consume()).toEqual(['4']);
    expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ errors: 0 });
  });

  it('keeps unread tails, a live writer lock and unpersisted checkpoints', async () => {
    const paths = [append('1'), append('2'), append('3')];
    seed(); await consume();
    const state = store.get('raw-test');
    store.update('raw-test', { extra: { hookLogOffsets: { ...(state.extra!.hookLogOffsets as object), [path.basename(file)]: 0 } } });
    const service = new LogRetentionService(root, config, store);
    expect((await service.runCleanup()).deleted).toBe(0);
    await store.save();
    await fs.writeFile(file + '.lock', '');
    expect((await service.runCleanup()).deleted).toBe(0);
    await fs.unlink(file + '.lock');
    expect((await service.runCleanup()).deleted).toBe(1);
    await expect(fs.stat(paths[0])).resolves.toBeDefined();
    await expect(fs.stat(paths[2])).resolves.toBeDefined();
  });

  it('preserves replacement inodes and same-name replacement is collected after restart', async () => {
    append('1'); append('2'); seed(); await consume();
    await fs.rename(file, file + '.backup');
    await fs.writeFile(file, JSON.stringify({ id: 'new-record-longer-than-old' }) + '\n');
    const service = new LogRetentionService(root, config, store);
    expect((await service.runCleanup()).deleted).toBe(0);
    expect(await consume()).toEqual(['new-record-longer-than-old']);
  });

  it('reclaims consumed quiet legacy daily files but preserves unknown state and recent late writes', async () => {
    await fs.writeFile(file, '{"id":"legacy"}\n');
    await fs.utimes(file, oldTime(), oldTime());
    expect((await new LogRetentionService(root, config, store).runCleanup()).deleted).toBe(0);
    seed(); await consume();
    expect((await new LogRetentionService(root, config, store).runCleanup()).deleted).toBe(1);
    await fs.writeFile(file, '{"id":"late"}\n');
    await consume();
    expect((await new LogRetentionService(root, config, store).runCleanup()).deleted).toBe(0);
  });

  it('reports Windows-style sharing violations without deleting or advancing the checkpoint', async () => {
    append('1'); append('2'); seed(); await consume();
    const original = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation(async filename => {
      if (filename === file) throw Object.assign(new Error('file in use'), { code: 'EPERM' });
      return original(filename);
    });
    expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 0, errors: 1 });
    await expect(fs.stat(file)).resolves.toBeDefined();
  });

  it('reclaims old all.jsonl below the emergency threshold while protecting recently written output', async () => {
    const output = path.join(root, 'logs', 'output'); await fs.mkdir(output);
    const legacy = path.join(output, 'claude-code-all.jsonl');
    const active = path.join(output, 'codex-all.jsonl');
    for (const name of [legacy, active]) { await fs.writeFile(name, ''); await fs.truncate(name, Math.floor(OUTPUT_RETENTION_MAX_TOTAL_BYTES * 0.6)); }
    await fs.utimes(legacy, oldTime(), oldTime());
    expect((await new LogRetentionService(root, config).runCleanup()).deleted).toBe(1);
    await expect(fs.stat(active)).resolves.toBeDefined();
  });

  it('caps opt-in diagnostics independently from unconsumed raw input', async () => {
    for (let i = 0; i < 20; i++) appendRawJsonl(file, '{"id":"test"}\n', 16, { diagnosticMaxBytes: 32 });
    const sizes = await Promise.all((await fs.readdir(dir)).filter(n => n.endsWith('.jsonl')).map(async n => (await fs.stat(path.join(dir, n))).size));
    expect(sizes.reduce((a, n) => a + n, 0)).toBeLessThanOrEqual(32);
  });

  it('drains a multi-segment backlog over bounded polls without dropping the record crossing the budget', async () => {
    const payload = 'x'.repeat(4 * 1024 * 1024);
    for (const id of ['1', '2', '3']) appendRawJsonl(file, JSON.stringify({ id, payload }) + '\n', 5 * 1024 * 1024);
    seed();
    expect(await consume()).toEqual(['1', '2']);
    expect(await consume()).toEqual(['3']);
  });

  it.each(['dsh', 'hermes-agent'])('reclaims only consumed closed %s session segments', async family => {
    const sessionDir = path.join(root, 'logs', family);
    const source = path.join(sessionDir, family + '-session-a.jsonl');
    const files = ['a', 'b', 'c'].map(sid => appendRawJsonl(source, JSON.stringify({ sid, type: 'turn/end' }) + '\n', 32));
    for (const file of files) await fs.utimes(file, oldTime(), oldTime());
    const InputType = family === 'dsh' ? DshLogInput : HermesLogInput;
    const input = new InputType({ stateStore: store, sessionDir });
    await input.start(); await input.stop();
    expect(await new LogRetentionService(root, config, store).runCleanup()).toMatchObject({ deleted: 2, errors: 0 });
    await expect(fs.stat(files[2])).resolves.toBeDefined();
  });

  it('serializes concurrent writers without renaming an input inode or losing JSONL records', async () => {
    appendRawJsonl(file, '{"id":"warm"}\n', 256);
    const inode = (await fs.stat(file)).ino;
    const module = new URL('../../assets/hooks/shared/raw-jsonl-writer.mjs', import.meta.url).href;
    const script = `import { appendRawJsonl } from ${JSON.stringify(module)};
      for (let i=0;i<25;i++) appendRawJsonl(process.argv[1], JSON.stringify({id:process.argv[2]+':'+i})+'\\n',256);`;
    await Promise.all([0, 1, 2, 3].map(worker => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, String(worker)]);
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    expect((await fs.stat(file)).ino).toBe(inode);
    const lines = (await Promise.all((await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'))
      .map(name => fs.readFile(path.join(dir, name), 'utf8')))).flatMap(text => text.trim().split('\n'));
    expect(new Set(lines.map(line => JSON.parse(line).id)).size).toBe(101);
    expect(lines).toHaveLength(101);
  });

  it('does not steal a live raw owner lock after its stale timeout', async () => {
    await fs.writeFile(file + '.lock', String(process.pid));
    await fs.utimes(file + '.lock', oldTime(), oldTime());
    const action = vi.fn();
    expect(withSyncFileLock(file + '.lock', 0, 1, action, true)).toEqual({ acquired: false });
    expect(action).not.toHaveBeenCalled();
    expect(await fs.readFile(file + '.lock', 'utf8')).toBe(String(process.pid));
  });

  it('does not charge a cached incomplete tail against the budget for a later segment', async () => {
    await fs.writeFile(file, '{"id":"' + 'x'.repeat(9 * 1024 * 1024));
    seed();
    const input = new Input({ logDir: dir, logPrefix: 'raw', stateStore: store });
    const ids: string[] = [];
    const deltas: Array<{ rawReadBytes: number }> = [];
    input.on('entries', entries => ids.push(...entries.map((e: AgentActivityEntry) => e['event.id'])));
    input.on('input-runtime-delta', delta => deltas.push(delta));
    await input.start(); await input.stop();
    expect(ids).toEqual([]);
    const line = '{"id":"next-segment"}\n';
    appendRawJsonl(file, line, 16);
    await input.start(); await input.stop();
    expect(ids).toEqual(['next-segment']);
    expect(deltas[1].rawReadBytes).toBe(Buffer.byteLength(line));
  });

  it('reclaims consumed closed source segments under pressure while retaining the active segment', async () => {
    const closed = append('1');
    const active = append('2');
    seed(); await consume();
    await fs.truncate(closed, RAW_SOURCE_RETENTION_MAX_TOTAL_BYTES + 1);
    const stat = await fs.stat(closed);
    const state = store.get('raw-test');
    store.update('raw-test', { extra: {
      hookLogOffsets: { ...(state.extra!.hookLogOffsets as object), [path.basename(closed)]: stat.size },
      hookLogIdentities: { ...(state.extra!.hookLogIdentities as object), [path.basename(closed)]: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` },
    } });
    await store.save();
    expect(await new LogRetentionService(root, config, store).runPressureCleanup()).toMatchObject({ deleted: 1, errors: 0 });
    await expect(fs.stat(active)).resolves.toBeDefined();
  });

  it.each(['cursor', 'qwen-work-cn'])('protects nested %s history before registration and until its cursor is durable', async family => {
    dir = path.join(root, 'logs', family, 'history');
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, 'raw-' + oldDate() + '.jsonl');
    await fs.writeFile(file, '{"id":"unread"}\n');
    await fs.utimes(file, oldTime(), oldTime());
    expect((await new LogRetentionService(root, config).runCleanup()).deleted).toBe(0);
    const service = new LogRetentionService(root, config, store);
    expect((await service.runCleanup()).deleted).toBe(0);
    seed();
    expect(await consume()).toEqual(['unread']);
    const state = store.get('raw-test');
    store.update('raw-test', { extra: { hookLogOffsets: { [path.basename(file)]: 0 } } });
    expect((await service.runCleanup()).deleted).toBe(0);
    await store.save();
    expect((await service.runCleanup()).deleted).toBe(0);
    store.set('raw-test', state);
    await store.save();
    expect((await service.runCleanup()).deleted).toBe(1);
  });

  it.each([
    { segmentBytes: 5 * 1024 * 1024, appendDuring: false },
    { segmentBytes: 100 * 1024 * 1024, appendDuring: false },
    { segmentBytes: 5 * 1024 * 1024, appendDuring: true },
  ])('suppresses older Kiro turns across polls/restarts ($segmentBytes, live append=$appendDuring)', async ({ segmentBytes, appendDuring }) => {
    const kiroDir = path.join(root, 'logs', 'kiro-cli');
    const stamp = new Date();
    const day = [stamp.getFullYear(), String(stamp.getMonth() + 1).padStart(2, '0'), String(stamp.getDate()).padStart(2, '0')].join('-');
    const source = path.join(kiroDir, 'kiro-cli-' + day + '.jsonl');
    for (const turn of ['old-1', 'old-2', 'old-3']) {
      appendRawJsonl(source, JSON.stringify({ 'event.name': 'llm.request', 'event.id': turn,
        'gen_ai.session.id': 'session', 'gen_ai.turn.id': turn, padding: 'x'.repeat(4 * 1024 * 1024) }) + '\n', segmentBytes);
    }
    const ids: string[] = [];
    for (let poll = 0; poll < 6; poll++) {
      const input = new KiroCliLogInput({ stateStore: store, logDir: kiroDir });
      input.on('entries', entries => ids.push(...entries.map((entry: AgentActivityEntry) => entry['gen_ai.turn.id'] as string)));
      await input.start(); await input.stop();
      if (poll === 0) {
        expect((await fs.stat(path.join(root, 'logs', 'input-state.json'))).size).toBeLessThan(16 * 1024);
        if (appendDuring) appendRawJsonl(source, JSON.stringify({ 'event.name': 'llm.request', 'event.id': 'during',
          'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'during' }) + '\n', segmentBytes);
      }
      store = new StateStore(path.join(root, 'logs', 'input-state.json'));
      await store.load();
    }
    expect(ids).toEqual(['old-3', ...(appendDuring ? ['during'] : [])]);
    appendRawJsonl(source, JSON.stringify({ 'event.name': 'llm.request', 'event.id': 'new',
      'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'new' }) + '\n', segmentBytes);
    const input = new KiroCliLogInput({ stateStore: store, logDir: kiroDir });
    input.on('entries', entries => ids.push(...entries.map((entry: AgentActivityEntry) => entry['gen_ai.turn.id'] as string)));
    await input.start(); await input.stop();
    expect(ids).toEqual(['old-3', ...(appendDuring ? ['during'] : []), 'new']);
  });

  it('uses the primary Qwen Work trace cursor to reclaim nested consumed history', async () => {
    const logDir = path.join(root, 'logs', 'qwen-work-cn', 'history');
    await fs.mkdir(logDir, { recursive: true });
    const name = 'qwen-work-cn-' + oldDate() + '.jsonl';
    const source = path.join(logDir, name);
    await fs.writeFile(source, '{"event.name":"llm.request","gen_ai.session.id":"s","gen_ai.turn.id":"t"}\n');
    await fs.utimes(source, oldTime(), oldTime());
    store.set('qwen-work-cn-trace', { lastFile: name, lastOffset: 0 });
    const service = new LogRetentionService(root, config, store);
    expect((await service.runCleanup()).deleted).toBe(0);
    const input = new QwenWorkCNTraceInput({ stateStore: store, logDir, segmentsRoot: path.join(root, 'native-sessions') });
    const turns: string[] = [];
    input.on('entries', entries => turns.push(...entries.map((entry: AgentActivityEntry) => entry['gen_ai.turn.id'] as string)));
    await input.start(); await input.stop();
    expect(store.get('qwen-work-cn-trace').lastOffset).toBe((await fs.stat(source)).size);
    await fs.rename(source, source + '.backup');
    await fs.writeFile(source, '{"event.name":"llm.request","gen_ai.session.id":"s","gen_ai.turn.id":"u"}\n');
    await fs.utimes(source, oldTime(), oldTime());
    expect((await service.runCleanup()).deleted).toBe(0);
    await input.start(); await input.stop();
    expect(turns).toEqual(['t', 'u']);
    expect((await service.runCleanup()).deleted).toBe(1);
  });

  it('reclaims the last Hermes segment after its process exits, while protecting live or unread sources', async () => {
    const sessionDir = path.join(root, 'logs', 'hermes-agent');
    const source = path.join(sessionDir, 'hermes-agent-1234567-1000-abcdef12.jsonl');
    const files = ['a', 'b'].map(id => appendRawJsonl(source, JSON.stringify({ id }) + '\n', 16));
    for (const name of files) await fs.utimes(name, oldTime(), oldTime());
    const input = new HermesLogInput({ stateStore: store, sessionDir });
    await input.start(); await input.stop();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const service = new LogRetentionService(root, config, store);
    expect((await service.runCleanup()).deleted).toBe(1);
    await expect(fs.stat(files[1])).resolves.toBeDefined();
    kill.mockImplementation(() => { throw Object.assign(new Error('not allowed'), { code: 'EPERM' }); });
    expect((await service.runCleanup()).deleted).toBe(0);
    await fs.appendFile(files[1], '{"id":"unread"}\n');
    await fs.utimes(files[1], oldTime(), oldTime());
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect((await service.runCleanup()).deleted).toBe(0);
    await input.start(); await input.stop();
    expect((await service.runCleanup()).deleted).toBe(1);
  });
});
