import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { guardrailSnapshotFromVerdict, stampGuardrail } from '../../../src/interceptor/guardrail.js';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import {
  TOOL_VERDICT_TTL_MS,
  TOOL_VERDICT_MAX_RECORDS,
  ToolVerdictStore,
  type ToolVerdictRecord,
} from '../../../src/interceptor/tool-verdict-store.js';

describe('tool verdict store', () => {
  it.each([1, 128, TOOL_VERDICT_MAX_RECORDS])('keeps %i newer checkpoint records when an old full mirror is merged', (added) => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    const base = Date.now() - 30_000;
    for (let i = 0; i < TOOL_VERDICT_MAX_RECORDS; i++) {
      store.put({ toolUseId: `old-${i}`, phase: 'PreToolUse' }, 'allow', new Date(base + i));
    }
    const oldMirror = store.records();
    for (let i = 0; i < added; i++) {
      store.put({ toolUseId: `new-${i}`, phase: 'PreToolUse' }, 'block', new Date(base + TOOL_VERDICT_MAX_RECORDS + i));
    }
    store.dump();
    const restored = new ToolVerdictStore(file);
    restored.restore();
    restored.merge(oldMirror);
    const retained = restored.records();
    expect(retained).toHaveLength(TOOL_VERDICT_MAX_RECORDS);
    expect(retained.filter(record => record.toolUseId.startsWith('new-'))).toHaveLength(added);
    expect(retained.map(record => record.recordedAt)).toEqual(retained.map(record => record.recordedAt).sort());
  });

  it('keeps checkpoint records when disjoint mirror records share the same timestamp at capacity', () => {
    const file = checkpointFile();
    const now = new Date();
    const store = new ToolVerdictStore(file);
    for (let i = 0; i < TOOL_VERDICT_MAX_RECORDS; i++) {
      store.put({ toolUseId: `checkpoint-${i}`, phase: 'PreToolUse' }, 'block', now);
    }
    store.dump(now);
    const restored = new ToolVerdictStore(file);
    restored.restore(now);
    const mirror: ToolVerdictRecord[] = Array.from({ length: TOOL_VERDICT_MAX_RECORDS }, (_, i) => ({
      toolUseId: `mirror-${i}`, phase: 'PreToolUse', action: 'allow', recordedAt: now.toISOString(),
    }));
    restored.merge(mirror);
    expect(restored.records()).toHaveLength(TOOL_VERDICT_MAX_RECORDS);
    expect(restored.records().every(record => record.toolUseId.startsWith('checkpoint-'))).toBe(true);
    restored.merge(mirror);
    expect(restored.records().every(record => record.toolUseId.startsWith('checkpoint-'))).toBe(true);
  });

  it('selects the newest bounded records from unordered input and preserves checkpoint ties and TTL', () => {
    const store = new ToolVerdictStore(checkpointFile());
    const base = Date.now() - 30_000;
    const records: ToolVerdictRecord[] = Array.from({ length: TOOL_VERDICT_MAX_RECORDS + 2 }, (_, i) => ({
      toolUseId: `call-${i}`, phase: 'PreToolUse', action: 'allow', recordedAt: new Date(base + i).toISOString(),
    }));
    store.merge(records.reverse());
    expect(store.records()).toHaveLength(TOOL_VERDICT_MAX_RECORDS);
    expect(store.get({ toolUseId: 'call-0', phase: 'PreToolUse' })).toBeNull();
    const key = { toolUseId: 'call-100', phase: 'PreToolUse' as const };
    store.merge([{ ...key, action: 'block', recordedAt: new Date(base + 100).toISOString() }]);
    expect(store.get(key)).toBe('allow');
    store.merge([{ ...key, action: 'block', recordedAt: new Date(base + 101).toISOString() }]);
    expect(store.get(key)).toBe('block');
    expect(store.get(key, new Date(base + 101 + TOOL_VERDICT_TTL_MS))).toBe('block');
    expect(store.get(key, new Date(base + 102 + TOOL_VERDICT_TTL_MS))).toBeNull();

    const file = checkpointFile();
    fs.writeFileSync(file, JSON.stringify({ schema: 1, records }));
    const restored = new ToolVerdictStore(file);
    restored.restore();
    expect(restored.records()).toHaveLength(TOOL_VERDICT_MAX_RECORDS);
    expect(restored.get({ toolUseId: 'call-0', phase: 'PreToolUse' })).toBeNull();
    expect(restored.get({ toolUseId: `call-${TOOL_VERDICT_MAX_RECORDS + 1}`, phase: 'PreToolUse' })).toBe('allow');
  });

  it('cleans abandoned checkpoint temporaries only when the checkpoint writer starts', async () => {
    const file = checkpointFile();
    const abandoned = `${file}.${process.pid}.012345abcdef.tmp`;
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    const deadProcess = `${file}.${deadPid}.012345abcdef.tmp`;
    const liveProcess = `${file}.${process.ppid}.012345abcdef.tmp`;
    const unrelated = [`${file}.notes.tmp`, `${file}.${process.pid}.invalid.tmp`, `${file}.backup.${process.pid}.012345abcdef.tmp`];
    for (const candidate of [abandoned, deadProcess, liveProcess, ...unrelated]) fs.writeFileSync(candidate, 'temporary');
    const mirror = new ToolVerdictStore(file);
    mirror.restore();
    expect(fs.existsSync(abandoned)).toBe(true);
    const writer = new ToolVerdictStore(file);
    writer.restore();
    writer.startCheckpointLoop();
    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.existsSync(deadProcess)).toBe(false);
    expect(fs.existsSync(liveProcess)).toBe(true);
    expect(unrelated.every(candidate => fs.existsSync(candidate))).toBe(true);
    fs.writeFileSync(abandoned, 'active write');
    writer.startCheckpointLoop();
    expect(fs.existsSync(abandoned)).toBe(true);
    await writer.stopCheckpointLoop();
  });

  it('preserves temporary files when their process liveness cannot be checked', async () => {
    const file = checkpointFile();
    const candidate = `${file}.${process.ppid}.012345abcdef.tmp`;
    fs.writeFileSync(candidate, 'temporary');
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    const store = new ToolVerdictStore(file);
    try {
      store.startCheckpointLoop();
      expect(fs.existsSync(candidate)).toBe(true);
    } finally {
      kill.mockRestore();
      await store.stopCheckpointLoop();
    }
  });

  it('does not clean temporary files when a checkpoint is already in flight', async () => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    store.put({ toolUseId: 'one', phase: 'PreToolUse' }, 'allow');
    const pending = store.checkpoint();
    const active = `${file}.${process.pid}.012345abcdef.tmp`;
    fs.writeFileSync(active, 'active write');
    store.startCheckpointLoop();
    expect(fs.existsSync(active)).toBe(true);
    await pending;
    await store.stopCheckpointLoop();
  });

  it('persists known audit hits independently of a later fail-open result', async () => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    const key = { toolUseId: 'audit-call', phase: 'PreToolUse' as const };
    const snapshot = guardrailSnapshotFromVerdict({ action: 'allow', matched: true, enforcement: 'audit', failOpen: true,
      ruleId: 'observe', ruleVersion: '3', reason: 'audit hit', title: 'label', message: 'reminder', severity: 'HIGH', evaluatedRules: ['observe'] });
    expect(snapshot.severity).toBe('HIGH');
    store.put(key, snapshot);
    await store.checkpoint();
    const restored = new ToolVerdictStore(file);
    restored.restore();
    expect(restored.getSnapshot(key)).toEqual(snapshot);
    const mirror = new ToolVerdictStore(checkpointFile());
    mirror.merge(restored.records());
    expect(mirror.getSnapshot(key)).toEqual(snapshot);
    const event = buildAgentActivityEntry({ 'event.name': 'tool.call' });
    stampGuardrail(event, mirror.getSnapshot(key)!);
    expect(event).toMatchObject({ 'gen_ai.guardrail.severity': 'HIGH', 'gen_ai.guardrail.action': 'allow' });
  });
  it('merges IPC snapshots without refreshing expiry and caps retained records', () => {
    const store = new ToolVerdictStore(checkpointFile());
    const now = Date.now();
    store.merge([{ toolUseId: 'expired', phase: 'PreToolUse', action: 'block', recordedAt: new Date(now - TOOL_VERDICT_TTL_MS - 1000).toISOString() }]);
    expect(store.get({ toolUseId: 'expired', phase: 'PreToolUse' })).toBeNull();
    for (let i = 0; i <= TOOL_VERDICT_MAX_RECORDS; i++) {
      store.put({ toolUseId: String(i), phase: 'PreToolUse' }, 'allow');
    }
    expect(store.records()).toHaveLength(TOOL_VERDICT_MAX_RECORDS);
    expect(store.get({ toolUseId: '0', phase: 'PreToolUse' })).toBeNull();
    expect(store.get({ toolUseId: String(TOOL_VERDICT_MAX_RECORDS), phase: 'PreToolUse' })).toBe('allow');
  });

  it('writes dirty checkpoints asynchronously and keeps unchanged checkpoints untouched', async () => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    store.put({ toolUseId: 'one', phase: 'PreToolUse' }, 'allow');
    await store.checkpoint();
    fs.writeFileSync(file, 'unchanged sentinel');
    await store.checkpoint();
    expect(fs.readFileSync(file, 'utf8')).toBe('unchanged sentinel');
    store.put({ toolUseId: 'two', phase: 'PreToolUse' }, 'block');
    await store.stopCheckpointLoop();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).records).toHaveLength(2);
  });
  it('keeps Pre and Post apart and overwrites the same key', () => {
    const file = checkpointFile();
    const store = new ToolVerdictStore(file);
    const now = new Date('2026-09-23T08:00:00.000Z');
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', now);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PostToolUse' }, 'block', now);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'block', now);

    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBe('block');
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PostToolUse' }, now)).toBe('block');
    expect(store.get({ sessionId: 's2', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBeNull();
  });

  it('drops records older than 30 minutes', () => {
    const store = new ToolVerdictStore(checkpointFile());
    const writtenAt = new Date('2026-09-23T08:00:00.000Z');
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', writtenAt);
    const stillFresh = new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS);
    const expired = new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS + 1);
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, stillFresh)).toBe('allow');
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, expired)).toBeNull();
  });

  it('dumps one checkpoint file and restores it', () => {
    const file = checkpointFile();
    const now = new Date('2026-09-23T08:00:00.000Z');
    const store = new ToolVerdictStore(file);
    store.put({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, 'allow', now);
    store.put({ toolUseId: 'call-2', phase: 'PostToolUse' }, 'block', now);
    store.dump(now);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { schema: number; records: unknown[] };
    expect(raw.schema).toBe(1);
    expect(raw.records).toEqual([
      {
        sessionId: 's1',
        toolUseId: 'call-1',
        phase: 'PreToolUse',
        action: 'allow',
        recordedAt: now.toISOString(),
      },
      {
        toolUseId: 'call-2',
        phase: 'PostToolUse',
        action: 'block',
        recordedAt: now.toISOString(),
      },
    ]);

    const restored = new ToolVerdictStore(file);
    restored.restore(now);
    expect(restored.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toBe('allow');
    expect(restored.get({ toolUseId: 'call-2', phase: 'PostToolUse' }, now)).toBe('block');
  });

  it('restores the rule snapshot with the action', () => {
    const file = checkpointFile();
    const now = new Date('2026-09-23T08:00:00.000Z');
    const store = new ToolVerdictStore(file);
    store.put(
      { sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' },
      {
        action: 'block',
        ruleId: 'flow-probe',
        ruleVersion: '3',
        reason: 'flow-probe-v3',
        title: 'ak-leak',
        message: '不要在对话里粘贴 AccessKey',
      },
      now,
    );
    store.dump(now);
    const restored = new ToolVerdictStore(file);
    restored.restore(now);
    expect(restored.getSnapshot({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' }, now)).toEqual({
      action: 'block',
      ruleId: 'flow-probe',
      ruleVersion: '3',
      reason: 'flow-probe-v3',
      title: 'ak-leak',
      message: '不要在对话里粘贴 AccessKey',
    });
  });

  it('ignores a corrupt or unknown checkpoint', () => {
    const file = checkpointFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{');
    const broken = new ToolVerdictStore(file);
    broken.restore();
    expect(broken.get({ toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ schema: 2, records: [] }));
    const unknown = new ToolVerdictStore(file);
    unknown.restore();
    expect(unknown.get({ toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();
  });

  it('does not restore records older than 30 minutes', () => {
    const file = checkpointFile();
    const writtenAt = new Date('2026-09-23T08:00:00.000Z');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: 1,
      records: [{
        sessionId: 's1',
        toolUseId: 'call-1',
        phase: 'PreToolUse',
        action: 'block',
        recordedAt: writtenAt.toISOString(),
      }],
    }));
    const store = new ToolVerdictStore(file);
    store.restore(new Date(writtenAt.getTime() + TOOL_VERDICT_TTL_MS + 1));
    expect(store.get({ sessionId: 's1', toolUseId: 'call-1', phase: 'PreToolUse' })).toBeNull();
  });
});

function checkpointFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-verdict-')), 'tool-verdicts.json');
}
