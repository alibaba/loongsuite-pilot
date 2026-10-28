import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InputRuntimeAccumulator } from '../../../../src/inputs/base/input-runtime-metrics.js';
import { CodexWorkBudget } from '../../../../src/inputs/codex-transcript/codex-transcript-work-scheduler.js';
import { codexSourceSnapshot } from '../../../../src/inputs/codex-transcript/codex-transcript-reader.js';
import { CodexTranscriptOwnerProbe, parseCodexOwnerProbeState } from '../../../../src/inputs/codex-transcript/codex-transcript-owner-probe.js';

const roots: string[] = [];
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const meta = (id: string, padding = '') => JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'openai', padding } }) + '\n';
const snapshot = async (file: string) => codexSourceSnapshot(await fs.stat(file));
function budget(bytes = 128, runtime?: InputRuntimeAccumulator): CodexWorkBudget {
  return new CodexWorkBudget({ cycleReadBytes: bytes, fileCycleReadBytes: bytes, fileQuantumBytes: bytes,
    maxReadChunkBytes: Math.min(64, bytes) }, runtime, () => 0);
}
async function fixture(raw: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-owner-probe-'));
  roots.push(root);
  const file = path.join(root, `rollout-${CHILD}.jsonl`);
  await fs.writeFile(file, raw);
  return { file, raw, source: await snapshot(file) };
}
async function finish(probe: CodexTranscriptOwnerProbe, file: string, bytes = 128, runtime?: InputRuntimeAccumulator) {
  for (let cycle = 0; cycle < 200; cycle++) {
    const source = await snapshot(file);
    await probe.step(budget(bytes, runtime).fileSlice(file), source);
    if (probe.readyFor(source)) return;
  }
  throw new Error('owner probe did not finish');
}

describe('CodexTranscriptOwnerProbe', () => {
  it('keeps an ancestor candidate gated until a later matching header and its boundary are verified', async () => {
    const prefix = meta(PARENT) + meta(PARENT, 'x'.repeat(512));
    const { file, source } = await fixture(prefix + meta(CHILD) + '{"type":"turn_context","payload":{}}\n');
    const probe = new CodexTranscriptOwnerProbe(file, source);
    const runtime = new InputRuntimeAccumulator();
    expect((await probe.step(budget(128, runtime).fileSlice(file), source)).status).toBe('deferred');
    expect(probe.resolution).toMatchObject({ kind: 'searching', probe: { candidateOwnerOffset: 0, nextCompleteOffset: Buffer.byteLength(meta(PARENT)) } });
    expect(probe.readyFor(source)).toBe(false);
    await finish(probe, file, 128, runtime);
    expect(probe.resolution).toMatchObject({ kind: 'resolved', ownerOffset: Buffer.byteLength(prefix) });
    expect(probe.ownerMeta!.threadId).toBe(CHILD);
    expect(runtime.finish(0).rawInBytes).toBe(0);
    expect(runtime.finish(0).rawReadBytes).toBe(source.size);
  });

  it('caches absence only through a complete watermark and searches appended bytes independently', async () => {
    const { file, source } = await fixture('{"type":"event_msg","payload":{}}\n'.repeat(16));
    const probe = new CodexTranscriptOwnerProbe(file, source);
    const runtime = new InputRuntimeAccumulator();
    await finish(probe, file, 128, runtime);
    expect(probe.resolution).toEqual({ kind: 'absent-at-watermark', verifiedThroughOffset: source.size });
    expect(probe.eligible(source)).toBe(false);
    const idle = new InputRuntimeAccumulator();
    await probe.step(budget(128, idle).fileSlice(file), source);
    expect(idle.finish(0).rawReadCalls).toBe(0);
    const appended = meta(CHILD) + '{"type":"turn_context","payload":{}}\n';
    await fs.appendFile(file, appended);
    const next = new InputRuntimeAccumulator();
    await finish(probe, file, 128, next);
    expect(probe.resolution).toMatchObject({ kind: 'resolved', ownerOffset: source.size });
    expect(next.finish(0).codexRead!.readBytes.owner_probe).toBe(Buffer.byteLength(appended));
    expect(next.finish(0).codexRead!.readBytes.integrity_check).toBeGreaterThan(0);
    expect(probe.sourceGeneration).toBe(0);
  });

  it('resumes a fixed half-line only through its first newline before starting another observation', async () => {
    const before = '{"type":"event_msg","payload":{}}\n{"type":"session_meta","payload":';
    const { file, source } = await fixture(before);
    const probe = new CodexTranscriptOwnerProbe(file, source);
    await probe.step(budget(4096).fileSlice(file), source);
    expect(probe.resolution.kind).toBe('searching');
    expect(probe.eligible(source)).toBe(false);
    const boundary = JSON.stringify({ id: CHILD, model_provider: 'openai' }) + '}\n';
    await fs.appendFile(file, boundary + meta(CHILD, 'later') + '{"type":"turn_context","payload":{}}\n');
    const current = await snapshot(file);
    await probe.step(budget(4096).fileSlice(file), current);
    expect(probe.serialize().probe.targetSize).toBe(source.size);
    expect(probe.resolution).toMatchObject({ kind: 'resolved', verifiedThroughOffset: Buffer.byteLength(before + boundary) });
    expect(probe.readyFor(current)).toBe(false);
    expect(probe.eligible(current)).toBe(true);
    await finish(probe, file, 4096);
    expect(probe.readyFor(current)).toBe(true);
    expect(probe.resolution).toMatchObject({ ownerOffset: Buffer.byteLength(before + boundary) });
  });

  it('round-trips an unfinished probe without persisting half-line bytes or losing its candidate', async () => {
    const { file, source } = await fixture(meta(PARENT) + meta(PARENT, 'x'.repeat(512)) + '{"type":"turn_context","payload":{}}\n');
    const probe = new CodexTranscriptOwnerProbe(file, source);
    await probe.step(budget(128).fileSlice(file), source);
    const state = probe.serialize();
    const restored = parseCodexOwnerProbeState(JSON.parse(JSON.stringify(state)))!;
    expect(restored).toEqual(state);
    const next = new CodexTranscriptOwnerProbe(file, source, restored);
    await finish(next, file);
    expect(next.resolution).toMatchObject({ kind: 'resolved', ownerOffset: 0 });
    expect(next.ownerMeta!.threadId).toBe(PARENT);
    expect(next.serialize().ownerRef!.sha256).toHaveLength(64);
  });

  it('blocks a rewritten prefix followed by growth and restores only the original fingerprints', async () => {
    const original = meta(CHILD) + '{"type":"turn_context","payload":{}}\n';
    const { file, source } = await fixture(original);
    let now = 0;
    const probe = new CodexTranscriptOwnerProbe(file, source, undefined, null, () => now);
    await finish(probe, file, 4096);
    const expected = probe.serialize();
    await fs.writeFile(file, ' ' + original.slice(1) + 'padding\n');
    const changed = await snapshot(file);
    expect(changed.inode).toBe(source.inode);
    expect(changed.size).toBeGreaterThan(source.size);
    await probe.step(budget(4096).fileSlice(file), changed);
    expect(probe.resolution.kind).toBe('searching');
    expect(probe.sourceConflict).toBe(true);
    expect(probe.serialize().ownerRef).toEqual(expected.ownerRef);
    expect(probe.serialize().anchors).toEqual(expected.anchors);
    expect(probe.sourceGeneration).toBe(0);
    const idle = new InputRuntimeAccumulator();
    await probe.step(budget(4096, idle).fileSlice(file), changed);
    expect(idle.finish(0).rawReadCalls).toBe(0);
    await fs.writeFile(file, original + '{"tail":true}\n');
    now = 10_000;
    await finish(probe, file, 4096);
    expect(probe.sourceConflict).toBe(false);
    expect(probe.ownerMeta!.threadId).toBe(CHILD);
    expect(probe.serialize().ownerRef).toEqual(expected.ownerRef);
    expect(probe.sourceGeneration).toBe(0);
  });

  it('does not release cached identity before a budgeted integrity check completes', async () => {
    const { file, source } = await fixture(meta(CHILD) + '{"type":"turn_context","payload":{}}\n');
    const probe = new CodexTranscriptOwnerProbe(file, source);
    await finish(probe, file, 4096);
    await fs.appendFile(file, '{"tail":true}\n');
    const changed = await snapshot(file);
    const result = await probe.step(budget(1).fileSlice(file), changed);
    expect(result.status).toBe('deferred');
    expect(probe.readyFor(changed)).toBe(false);
    expect(probe.serialize().conflict).toBeUndefined();
    await finish(probe, file, 4096);
    expect(probe.readyFor(changed)).toBe(true);
  });

  it('rejects unsafe persisted ranges and fingerprints', async () => {
    const { file, source } = await fixture(meta(CHILD));
    const probe = new CodexTranscriptOwnerProbe(file, source);
    await finish(probe, file, 4096);
    const state = probe.serialize();
    expect(parseCodexOwnerProbeState({ ...state, probe: { ...state.probe, nextCompleteOffset: -1 } })).toBeUndefined();
    expect(parseCodexOwnerProbeState({ ...state, ownerRef: { ...state.ownerRef, sha256: 'bad' } })).toBeUndefined();
    expect(parseCodexOwnerProbeState({ ...state, ownerRef: { ...state.ownerRef, sourceGeneration: 5 } })).toBeUndefined();
    expect(parseCodexOwnerProbeState({ ...state, snapshot: { ...state.snapshot, ctimeMs: Number.NaN } })).toBeUndefined();
    const parsed = parseCodexOwnerProbeState(state)!;
    parsed.anchors[0]!.sha256 = '0'.repeat(64);
    expect(probe.serialize().anchors[0]!.sha256).not.toBe(parsed.anchors[0]!.sha256);
  });
});
