import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { InputRuntimeAccumulator, type InputRuntimeDelta } from '../../../src/inputs/base/input-runtime-metrics.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkNativeReader } from '../../../src/inputs/doubao-work/doubao-work-reader.js';
import { parseNativeContent } from '../../../src/inputs/doubao-work/doubao-work-content.js';
import { reconstructNativeRounds } from '../../../src/inputs/doubao-work/doubao-work-rounds.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine, doubaoToolLine } from '../../helpers/doubao-work-fixture.js';

const roots: string[] = [], inputs: Probe[] = [];
class Probe extends DoubaoWorkInput {
  private observer = new InputRuntimeAccumulator();
  delta!: InputRuntimeDelta;
  readHook?: (bytes: number, requested: number) => void;
  constructor(opts: ConstructorParameters<typeof DoubaoWorkInput>[0]) { super({ nativeScanIntervalMs: 0, ...opts }); inputs.push(this); }
  protected override getInputRuntimeAccumulator() { return this.observer; }
  async poll() {
    this.observer = new InputRuntimeAccumulator(); const start = performance.now();
    if (this.readHook) {
      const observe = this.observer.observeRead.bind(this.observer);
      this.observer.observeRead = (bytes, requested, elapsed) => { observe(bytes, requested, elapsed); this.readHook?.(bytes, requested); };
    }
    const result = await this.collect(); this.delta = this.observer.finish(performance.now() - start); return result;
  }
  close() { return this.onStop(); }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(inputs.splice(0).map(p => p.close())); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup(workBudget: ConstructorParameters<typeof DoubaoWorkInput>[0]['workBudget'] = { milliseconds: 1000 }) {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-work-budget-')); roots.push(root);
  const logDir = path.join(root, 'logs'), sessionsRoot = path.join(root, 'native'), snapshotRoot = path.join(root, 'snapshots');
  for (const dir of [logDir, sessionsRoot, snapshotRoot]) await mkdir(dir);
  const file = path.join(logDir, DOUBAO_FILE); await writeFile(file, '');
  const statePath = path.join(root, 'state.json'), stateStore = new StateStore(statePath);
  const options = { stateStore, logDir, sessionsRoot, snapshotRoot, workBudget };
  const input = new Probe(options), clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
  await input.poll(); clock.mockRestore(); return { input, file, stateStore, statePath, options, sessionsRoot };
}

describe('Doubao performance and recovery contracts', () => {
  it('resumes a slow 128-file sweep and gives completed requests a fresh finalization budget', async () => {
    const { input, file, stateStore } = await setup({ milliseconds: 15 });
    const name = (index: number) => DOUBAO_FILE.replace('.0.log', `.${index}.log`);
    for (let index = 1; index < 130; index++) await writeFile(path.join(path.dirname(file), name(index)), '');
    await writeFile(path.join(path.dirname(file), name(129)), doubaoLine('on_message_session_start', {}, 10) + doubaoLine('on_message_session_end'));
    let tick = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => tick++);
    const entries: any[] = [];
    for (let cycle = 0; cycle < 256 && entries.length === 0; cycle++) entries.push(...await input.poll());
    const saved = stateStore.get('doubao-work').extra!.doubaoWork as any;
    expect(Object.keys(saved.files)).toHaveLength(128);
    expect(saved.files[name(1)]).toBeUndefined();
    expect(saved.files[name(129)].offset).toBeGreaterThan(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]['gen_ai.turn.start']).toBe(true); expect(entries[1]['gen_ai.turn.end']).toBe(true);
    for (let cycle = 0; cycle < 64; cycle++) expect(await input.poll()).toEqual([]);
  });

  it('retains an ended request across temporary native I/O failure and restart instead of finalizing missing content', async () => {
    const { input, file, sessionsRoot, stateStore, statePath, options } = await setup();
    const cid = '12345678', directory = path.join(sessionsRoot, cid, 'agents/m_main/system'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'assignment.md'), `## [${new Date(DOUBAO_EPOCH + 1).toISOString()}] 需求\nCURRENT\n`);
    await writeFile(path.join(directory, 'trajectory.jsonl'), JSON.stringify({ role: 'assistant', content: 'FINAL' }) + '\n');
    await appendFile(file, doubaoLine('on_message_session_start', { conversation_id: cid }, 10) + doubaoLine('on_message_session_end', { conversation_id: cid }));
    vi.spyOn(DoubaoWorkNativeReader.prototype, 'graph').mockRejectedValueOnce(Object.assign(new Error('temporary permission failure'), { code: 'EACCES' }));
    expect(await input.poll()).toEqual([]); await stateStore.save(); await input.close();
    const checkpoint = stateStore.get('doubao-work').extra!.doubaoWork as any;
    expect(Object.keys(checkpoint.pending)).toHaveLength(1); expect(checkpoint.completed).toEqual({});
    const restored = new StateStore(statePath); await restored.load(); const resumed = new Probe({ ...options, stateStore: restored });
    const entries = await resumed.poll(); expect(entries).toHaveLength(2);
    expect((entries[0]['agent.doubao_work.assistant_rounds'] as any).rounds[0].outputMessages[0].parts[0].content).toBe('FINAL');
    expect(await resumed.poll()).toEqual([]);
  });

  it('never treats a valid read buffer as an oversized line when the time budget expires during I/O', async () => {
    const { input, file, stateStore } = await setup({ milliseconds: 50 });
    const start = doubaoLine('on_message_session_start', {}, 10), source = start + 'unrelated diagnostic row\n'.repeat(50_000) + doubaoLine('on_message_session_end');
    await appendFile(file, source);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    input.readHook = (_bytes, requested) => { if (requested === 1024 * 1024) clock.mockReturnValue(1000); };
    expect(await input.poll()).toEqual([]);
    const cursor = (stateStore.get('doubao-work').extra!.doubaoWork as any).files[DOUBAO_FILE];
    expect(cursor.offset).toBe(Buffer.byteLength(start)); expect(cursor.skippingLine).toBe(false);
    input.readHook = undefined; clock.mockReturnValue(0);
    const emitted: any[] = [];
    for (let i = 0; i < 5 && emitted.length === 0; i++) emitted.push(...await input.poll());
    expect(emitted).toHaveLength(2); expect(emitted[0]['gen_ai.turn.start']).toBe(true); expect(emitted[1]['gen_ai.turn.end']).toBe(true);
    expect((stateStore.get('doubao-work').extra!.doubaoWork as any).files[DOUBAO_FILE].offset).toBe(Buffer.byteLength(source));
  });

  it('does not clone committed records or replace an unchanged shared checkpoint', async () => {
    const { input, stateStore, statePath } = await setup();
    const checkpoint = stateStore.get('doubao-work').extra!.doubaoWork as any;
    const now = Date.now(); checkpoint.nativeCompleted = {}; checkpoint.executionsCompleted = {};
    for (let i = 0; i < 4096; i++) {
      const key = i.toString(16).padStart(64, '0');
      checkpoint.completed[key] = now; checkpoint.nativeCompleted[key] = now; checkpoint.executionsCompleted[key] = { digest: key, updatedMs: now };
    }
    await input.poll(); await stateStore.save();
    const original = stateStore.get('doubao-work').extra!.doubaoWork as any;
    const bytes = await readFile(statePath), before = await stat(statePath), update = vi.spyOn(stateStore, 'update');
    for (let i = 0; i < 10; i++) { expect(await input.poll()).toEqual([]); await stateStore.save(); }
    expect(update).not.toHaveBeenCalled();
    expect(stateStore.get('doubao-work').extra!.doubaoWork).toBe(original);
    expect((await readFile(statePath)).equals(bytes)).toBe(true);
    expect(await stat(statePath)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000);
    await input.poll(); await stateStore.save(); clock.mockRestore();
    const cleaned = stateStore.get('doubao-work').extra!.doubaoWork as any;
    expect(Object.keys(cleaned.completed)).toHaveLength(0); expect(Object.keys(cleaned.executionsCompleted)).toHaveLength(0);
    expect(Object.keys(original.completed)).toHaveLength(4096);
  });

  it('uses one read budget for logs and native files and resumes a >2 MiB source after restart without duplicate output', async () => {
    const maxBytes = 128 * 1024;
    const { input, file, stateStore, statePath, sessionsRoot, options } = await setup({ bytes: maxBytes, records: 512, milliseconds: 1000 });
    const actor = 'm_main', cid = '12345678';
    const rows = [
      ...Array.from({ length: 220 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) + 'x'.repeat(16_000) })),
      { role: 'user', content: 'CURRENT' },
      { role: 'assistant', content: 'parallel', tool_calls: ['one', 'two'].map(id => ({ id, function: { name: 'Read', arguments: { file_path: id } } })) },
      { role: 'tool', tool_call_id: 'two', content: 'second' }, { role: 'tool', tool_call_id: 'one', content: 'first' },
      { role: 'assistant', content: 'FINAL' },
    ];
    const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    const assignments = `## [${new Date(DOUBAO_EPOCH - 1000).toISOString()}] 需求\nOLD\n\n## [${new Date(DOUBAO_EPOCH + 1).toISOString()}] 需求\nCURRENT\n`;
    const system = path.join(sessionsRoot, cid, 'agents', actor, 'system'); await mkdir(system, { recursive: true });
    await writeFile(path.join(system, 'trajectory.jsonl'), raw); await writeFile(path.join(system, 'assignment.md'), assignments);
    const meta = { conversation_id: cid };
    await appendFile(file, doubaoLine('on_message_session_start', meta, 10)
      + doubaoToolLine({ tcid: 'one' }, 100) + doubaoToolLine({ tcid: 'two' }, 110)
      + doubaoToolLine({ toolCallID: 'two', phase: 'execution_settled', status: 'success' }, 200)
      + doubaoToolLine({ toolCallID: 'one', phase: 'execution_settled', status: 'success' }, 210)
      + doubaoLine('on_message_session_end', meta));
    expect(await input.poll()).toEqual([]); expect(input.delta.rawReadBytes).toBeLessThanOrEqual(maxBytes); await stateStore.save();
    const pending = stateStore.get('doubao-work').extra!.doubaoWork as any;
    expect(Object.keys(pending.pending)).toHaveLength(1); expect(Object.keys(pending.completed)).toHaveLength(0);
    await input.close();
    const restored = new StateStore(statePath); await restored.load(); const resumed = new Probe({ ...options, stateStore: restored });
    let entries: any[] = [], cycles = 0;
    for (; cycles < 50 && !entries.length; cycles++) {
      entries = await resumed.poll(); expect(resumed.delta.rawReadBytes).toBeLessThanOrEqual(maxBytes); await restored.save();
    }
    expect(cycles).toBeGreaterThan(2); expect(entries).toHaveLength(6);
    const rebuilt = entries[0]['agent.doubao_work.assistant_rounds'];
    const end = entries.at(-1).time_unix_nano;
    expect(rebuilt).toEqual(reconstructNativeRounds(parseNativeContent({ [actor]: raw }, { [actor]: assignments }), actor, DOUBAO_EPOCH, end, ['one', 'two']));
    expect(rebuilt.rounds).toHaveLength(2); expect(rebuilt.rounds[0].callIds).toEqual(['one', 'two']);
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(6);
    expect(await resumed.poll()).toEqual([]);
    expect((restored.get('doubao-work').extra!.doubaoWork as any).pending).toEqual({});
  });

  it('resumes CPU reconstruction across record budgets using its validated immutable request snapshot', async () => {
    const { input, file, sessionsRoot, stateStore } = await setup({ bytes: 8 * 1024 * 1024, records: 512, milliseconds: 1000 });
    const cid = '12345678', actor = 'm_main';
    const rows = [...Array.from({ length: 8000 }, (_, i) => ({ role: 'assistant', content: 'current-' + i })),
      { role: 'assistant', content: 'FINAL' }];
    const tasks = `## [${new Date(DOUBAO_EPOCH + 1).toISOString()}] 需求\nCURRENT\n`;
    const system = path.join(sessionsRoot, cid, 'agents', actor, 'system'); await mkdir(system, { recursive: true });
    await writeFile(path.join(system, 'trajectory.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); await writeFile(path.join(system, 'assignment.md'), tasks);
    await appendFile(file, doubaoLine('on_message_session_start', { conversation_id: cid }, 10) + doubaoLine('on_message_session_end', { conversation_id: cid }));
    let entries: any[] = [], reconstructedCycles = 0, priorRead = 0;
    for (let i = 0; i < 80 && !entries.length; i++) {
      entries = await input.poll();
      if ((input as any).reconstructionJobs.size) {
        reconstructedCycles++;
        if (reconstructedCycles > 1) expect(input.delta.rawReadBytes).toBeLessThanOrEqual(64); // at most the unchanged log boundary
        priorRead = (input as any).nativeReader.stats().bodyReadBytes;
      }
    }
    expect(entries).toHaveLength(2); expect(reconstructedCycles).toBeGreaterThan(2);
    const rebuilt = entries[0]['agent.doubao_work.assistant_rounds'];
    expect(rebuilt).toEqual(reconstructNativeRounds(parseNativeContent({ [actor]: rows.map(row => JSON.stringify(row)).join('\n') + '\n' }, { [actor]: tasks }), actor, DOUBAO_EPOCH, entries[1].time_unix_nano, []));
    expect(rebuilt.rounds[0].sourceIndex).toBe(0); expect(rebuilt.omittedRounds).toBeGreaterThan(7900);
    expect((input as any).nativeReader.stats().bodyReadBytes).toBe(priorRead);
    expect((stateStore.get('doubao-work').extra!.doubaoWork as any).pending).toEqual({});
  });
});
