/**
 * Stress-test reproducer for issue #720491: Codex transcript collection read amplification.
 *
 * Constructs 5 independent scenarios (Path A–E) that exercise the read-amplification
 * code paths in codex-transcript-input.ts, then runs repeated collect() cycles while
 * measuring CPU time, cumulative I/O bytes, and per-cycle wall-clock cost.
 *
 * Usage:
 *   npx tsx tests/stress/read-amplification-stress.ts [--cycles N] [--paths A,B,C,D,E]
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import type { AgentActivityEntry } from '../../src/types/index.js';
import type { InputRuntimeDelta } from '../../src/inputs/base/input-runtime-metrics.js';

// ---------------------------------------------------------------------------
// I/O instrumentation — must be installed BEFORE importing application code
// ---------------------------------------------------------------------------
let totalReadBytes = 0;
let cycleReadBytes = 0;
const readRanges: { file: string; start: number; bytes: number }[] = [];
const openedPaths = new WeakMap<fsp.FileHandle, string>();
const originalOpen = fs.promises.open;
fs.promises.open = (async (...args: Parameters<typeof originalOpen>) => {
  const handle = await originalOpen(...args);
  openedPaths.set(handle, String(args[0]));
  return handle;
}) as typeof originalOpen;
syncBuiltinESMExports();

const probeFh = await fsp.open(os.devNull, 'r');
const fhProto = Object.getPrototypeOf(probeFh);
await probeFh.close();

const origFhRead: typeof probeFh.read = fhProto.read;
fhProto.read = async function instrumentedRead(
  this: fsp.FileHandle,
  ...args: Parameters<typeof probeFh.read>
) {
  const result = await origFhRead.apply(this, args);
  const bytesRead = (result as { bytesRead: number }).bytesRead;
  if (typeof bytesRead === 'number') {
    totalReadBytes += bytesRead;
    cycleReadBytes += bytesRead;
    const file = openedPaths.get(this);
    if (file?.endsWith('.jsonl')) readRanges.push({ file, start: Number(args[3] ?? 0), bytes: bytesRead });
  }
  return result;
};

// 用同一 runner/脚本/追加顺序比较隔离的基线工作树；不修改安装态。
const ACCEPT = process.argv.includes('--accept');
const COMPLETE = ACCEPT || process.argv.includes('--complete');
const LIVE_FORK = ACCEPT || process.argv.includes('--live-fork');
const NORMAL_WAVES = process.argv.includes('--waves');
const DETAILS = process.argv.includes('--details');
const PEER = process.argv.includes('--peer');
const sourceIndex = process.argv.indexOf('--source-root');
const sourceRoot = sourceIndex < 0 ? path.resolve(import.meta.dirname, '../..') : path.resolve(process.argv[sourceIndex + 1]!);
const { StateStore } = await import(pathToFileURL(path.join(sourceRoot, 'src/checkpoints/state-store.ts')).href);
const { CodexTranscriptInput } = await import(pathToFileURL(path.join(sourceRoot, 'src/inputs/codex-transcript/codex-transcript-input.ts')).href);
const { BaseInput } = await import(pathToFileURL(path.join(sourceRoot, 'src/inputs/base/base-input.ts')).href);
const { ClientType, CollectionMethod } = await import(pathToFileURL(path.join(sourceRoot, 'src/types/index.ts')).href);
class DrivenInput extends CodexTranscriptInput {
  // 所有周期由脚本驱动，Hook 文件写入不产生未测量的并发周期。
  protected requestCollection(): void {}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const cliArgs = process.argv.slice(2);
function argValue(flag: string, fallback: string): string {
  const idx = cliArgs.indexOf(flag);
  return idx >= 0 && cliArgs[idx + 1] ? cliArgs[idx + 1]! : fallback;
}
const TOTAL_CYCLES = Number(argValue('--cycles', '100'));
const OUTPUT_BYTES = Number(argValue('--output-bytes', NORMAL_WAVES ? '1000' : '100000'));
assert(Number.isSafeInteger(OUTPUT_BYTES) && OUTPUT_BYTES > 0, '--output-bytes 必须为正整数');
const ENABLED_PATHS = new Set(
  argValue('--paths', 'A,B,C,D,E').split(',').map(s => s.trim().toUpperCase()),
);
assert(Number.isSafeInteger(TOTAL_CYCLES) && TOTAL_CYCLES > 0, '--cycles 必须为正整数');
assert([...ENABLED_PATHS].every(label => 'ABCDE'.includes(label) && label.length === 1), '--paths 仅允许 A–E');
const startupCosts = new WeakMap<object, { cpuMs: number; wallMs: number }>();
const observations = new WeakMap<object, { entries: AgentActivityEntry[]; deltas: InputRuntimeDelta[]; errors: unknown[];
  ids: Set<unknown>; duplicates: number; store: StoreType }>();
function compact(value: unknown): unknown {
  if (typeof value === 'string') {
    assert(!value.includes('\u0000codex:'), '内部正文 ref 泄漏');
    if (value.length > 4096) return { bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') };
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}
function observe(input: InputType, store: StoreType): void {
  const data = { entries: [] as AgentActivityEntry[], deltas: [] as InputRuntimeDelta[], errors: [] as unknown[],
    ids: new Set<unknown>(), duplicates: 0, store };
  observations.set(input, data);
  let rangeOffset = readRanges.length;
  input.on('entries', (batch: AgentActivityEntry[]) => {
    for (const entry of batch) {
      if (data.ids.has(entry['event.id'])) data.duplicates++;
      data.ids.add(entry['event.id']);
      data.entries.push(compact(entry) as AgentActivityEntry);
    }
  });
  input.on('input-runtime-delta', (delta: InputRuntimeDelta) => {
    if (ACCEPT) {
      assert(delta.codexRead, 'Codex 原因计数缺失');
      assert.equal(Object.values(delta.codexRead.readBytes).reduce((sum, bytes) => sum + bytes, 0), delta.rawReadBytes);
      assert.equal(Object.values(delta.codexRead.readCalls).reduce((sum, calls) => sum + calls, 0), delta.rawReadCalls);
      const ranges = readRanges.slice(rangeOffset);
      assert.equal(ranges.reduce((sum, range) => sum + range.bytes, 0), delta.rawReadBytes, '源探针与 runtime 读量不同');
      assert.equal(ranges.length, delta.rawReadCalls, '源探针与 runtime 调用次数不同');
      assert(delta.rawReadBytes <= 32 * 1024 * 1024 && delta.rawReadCalls <= 128, 'startup/collect 整轮预算超额');
      const perFile = new Map<string, number>();
      for (const range of ranges) perFile.set(range.file, (perFile.get(range.file) ?? 0) + range.bytes);
      for (const bytes of perFile.values()) assert(bytes <= 16 * 1024 * 1024, 'startup/collect 同文件预算超额');
    }
    rangeOffset = readRanges.length;
    data.deltas.push(delta);
  });
  input.on('collect-error', (error: unknown) => data.errors.push(error));
}
function checkpoint(input: InputType, file: string): any {
  return observations.get(input)!.store.get(`codex-transcript:${file}`).extra?.codexTranscript;
}
function assertEntries(input: InputType): void {
  const data = observations.get(input)!;
  assert.equal(data.errors.length, 0, '采集发生异常');
  assert.equal(data.duplicates, 0, 'event.id 重复');
}
async function filesFor(input: InputType): Promise<string[]> {
  const root = (input as any).sessionDir;
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(dir, entry.name))
      : Promise.resolve(entry.name.endsWith('.jsonl') ? [path.join(dir, entry.name)] : [])));
    return nested.flat();
  };
  return walk(root);
}
async function ready(input: InputType, allowActive = true): Promise<boolean> {
  for (const file of await filesFor(input)) {
    const cp = checkpoint(input, file);
    if (!cp || cp.startupBaselineTarget || cp.deferredScan || cp.scanOffset < (await fsp.stat(file)).size
      || cp.ownerProbe?.kind === 'searching' || cp.recordReads?.length || (!allowActive && cp.activeTurn)
      || (cp.pendingTerminal && !cp.pendingTerminal.nextRetryAtMs)) return false;
  }
  return true;
}
async function drain(input: InputType, phase: string, allowActive = true): Promise<CycleMetric[]> {
  const metrics: CycleMetric[] = [];
  for (let cycle = 0; cycle < 4096 && !await ready(input, allowActive); cycle++) metrics.push(await measureCycle(input, cycle + 1, phase));
  assert(await ready(input, allowActive), `${phase} 未能排空任务`);
  return metrics;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_ID = 'stress-session-001';
const TURN_ID_1 = '019710a0-0001-7000-8000-000000000001';
// UUIDv7 的原生时间必须与 owner 创建时间一致，不能把 owned 夹具误造为更早的历史。
const uuidV7 = (timestamp: string, tail: string): string => {
  const hex = Date.parse(timestamp).toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${tail}`;
};
const PARENT_THREAD_ID = uuidV7('2026-10-25T00:00:00Z', 'aaaaaaaaaaaa');
const FORK_THREAD_ID = uuidV7('2026-10-26T00:00:00.100Z', 'bbbbbbbbbbbb');
const COPIED_TURN_ID = uuidV7('2026-10-25T00:00:01Z', 'cccccccccccc');
const OWNED_TURN_ID = uuidV7('2026-10-26T00:00:02Z', 'dddddddddddd');

// ---------------------------------------------------------------------------
// Transcript record helpers
// ---------------------------------------------------------------------------
function rec(
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, type, payload });
}

function sessionMeta(id: string, extra: Record<string, unknown> = {}): string {
  return rec('2026-10-26T00:00:00.000Z', 'session_meta', {
    id,
    model_provider: 'openai',
    session_id: id,
    ...extra,
  });
}

function forkSessionMeta(childId: string, parentId: string): string {
  return rec('2026-10-26T00:00:00.100Z', 'session_meta', {
    id: childId,
    model_provider: 'openai',
    session_id: childId,
    forked_from_id: parentId,
    thread_source: 'subagent',
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: parentId, depth: 1 },
      },
    },
  });
}

function turnContext(turnId: string): string {
  return rec('2026-10-26T00:00:01.000Z', 'turn_context', {
    turn_id: turnId,
    model: 'gpt-5.5',
    cwd: '/tmp/stress',
  });
}

function taskStarted(turnId: string): string {
  return rec('2026-10-26T00:00:02.000Z', 'event_msg', {
    type: 'task_started',
    turn_id: turnId,
  });
}

function userMessage(): string {
  return rec('2026-10-26T00:00:02.500Z', 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'stress test prompt' }],
  });
}

function functionCall(callId: string, name: string, argsStr: string): string {
  return rec('2026-10-26T00:00:03.000Z', 'response_item', {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: argsStr,
  });
}

function functionOutput(callId: string, output: string): string {
  return rec('2026-10-26T00:00:04.000Z', 'response_item', {
    type: 'function_call_output',
    call_id: callId,
    output,
  });
}

function tokenCount(inputTok: number, outputTok: number): string {
  return rec('2026-10-26T00:00:05.000Z', 'event_msg', {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: inputTok,
        output_tokens: outputTok,
        cached_input_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: inputTok + outputTok,
      },
    },
  });
}

function taskComplete(turnId: string): string {
  return rec('2026-10-26T00:00:06.000Z', 'event_msg', {
    type: 'task_complete',
    turn_id: turnId,
    last_agent_message: 'done',
  });
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------
async function writeTranscript(
  sessionDir: string,
  name: string,
  lines: string[],
): Promise<string> {
  const dir = path.join(sessionDir, '2026', '10', '26');
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${name}.jsonl`);
  await fsp.writeFile(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

async function appendTranscript(filePath: string, lines: string[]): Promise<void> {
  await fsp.appendFile(filePath, lines.join('\n') + '\n', 'utf8');
}

type StoreType = InstanceType<typeof StateStore>;
type InputType = InstanceType<typeof CodexTranscriptInput>;

async function createInput(
  root: string,
): Promise<{ input: InputType; stateStore: StoreType }> {
  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const input = new DrivenInput({
    stateStore,
    sessionDir: path.join(root, 'sessions'),
    wakeupDir: path.join(root, 'wakeups'),
    spanContextDir: path.join(root, 'span-contexts'),
    pollIntervalMs: 600_000,
  });
  observe(input, stateStore);
  return { input, stateStore };
}

async function createInputWithStore(
  root: string,
  stateStore: StoreType,
): Promise<InputType> {
  const input = new DrivenInput({
    stateStore,
    sessionDir: path.join(root, 'sessions'),
    wakeupDir: path.join(root, 'wakeups'),
    spanContextDir: path.join(root, 'span-contexts'),
    pollIntervalMs: 600_000,
  });
  observe(input, stateStore);
  return input;
}

async function startInput(input: InputType): Promise<void> {
  const start = performance.now();
  const cpu = process.cpuUsage();
  await input.start();
  await (input as any).cyclePromise;
  const elapsed = process.cpuUsage(cpu);
  startupCosts.set(input, { cpuMs: (elapsed.user + elapsed.system) / 1000, wallMs: performance.now() - start });
}

async function doRunCycle(input: InputType): Promise<void> {
  await (input as unknown as { runCycle(): Promise<void> }).runCycle();
}

// 验收专用的独立 Input：轮询小 JSON，与 Codex 共享 checkpoint，测量发布到输出的延迟。
async function createPeerProbe(root: string, store: StoreType) {
  const file = path.join(root, 'peer-input.json');
  await fsp.writeFile(file, JSON.stringify({ sequence: 0, publishedAt: performance.now() }));
  let sequence = 0;
  let consumed = 0;
  const latencies: number[] = [];
  const ids = new Set<string>();
  const errors: unknown[] = [];
  class PeerInput extends BaseInput {
    readonly id = 'acceptance-peer';
    readonly agentType = ClientType.Qoder;
    readonly collectionMethod = CollectionMethod.SessionFilePolling;
    protected async collect(): Promise<AgentActivityEntry[]> {
      const item = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (item.sequence <= consumed) return [];
      consumed = item.sequence;
      return [{ 'event.id': `peer-${item.sequence}`, 'event.name': 'other',
        'gen_ai.session.id': 'acceptance-peer', publishedAt: item.publishedAt } as AgentActivityEntry];
    }
  }
  const input = new PeerInput({ stateStore: store, pollIntervalMs: 1 });
  input.on('entries', (entries: AgentActivityEntry[]) => {
    for (const entry of entries) {
      const id = String(entry['event.id']);
      assert(!ids.has(id), 'peer Input 重复事件');
      ids.add(id);
      latencies.push(performance.now() - Number(entry.publishedAt));
    }
  });
  input.on('collect-error', (error: unknown) => errors.push(error));
  await input.start();
  return {
    async publish() {
      // 原子发布防止轮询遇到造数过程中的半个 JSON；该造数成本不计入 Codex 采集 CPU。
      const temporary = `${file}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify({ sequence: ++sequence, publishedAt: performance.now() }));
      await fsp.rename(temporary, file);
    },
    async flush() {
      for (let attempt = 0; attempt < 8 && ids.size < sequence; attempt++) await (input as any).runCycle();
      assert.equal(ids.size, sequence, 'peer Input 丢失事件');
      assert.equal(errors.length, 0, 'peer Input 采集异常');
    },
    async stop() {
      await input.stop();
      assert.equal(ids.size, sequence);
      const sorted = [...latencies].sort((a, b) => a - b);
      return { published: sequence, emitted: ids.size, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
        maxMs: sorted.at(-1) ?? 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Path A: findTurnStartOffset stuck on >16 MiB record in fork transcript
// ---------------------------------------------------------------------------
async function setupPathA(
  baseDir: string,
): Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }> {
  const root = path.join(baseDir, 'path-a');
  const sessionDir = path.join(root, 'sessions');
  await fsp.mkdir(sessionDir, { recursive: true });
  await fsp.mkdir(path.join(root, 'wakeups'), { recursive: true });

  const { input } = await createInput(root);
  if (LIVE_FORK) await startInput(input);
  const hugeLine = rec('2026-10-26T00:00:02.000Z', 'response_item', {
    type: 'function_call_output',
    call_id: 'call-huge',
    output: 'X'.repeat(20 * 1024 * 1024),
  });

  const lines = [
    sessionMeta(PARENT_THREAD_ID),
    forkSessionMeta(FORK_THREAD_ID, PARENT_THREAD_ID),
    turnContext(COPIED_TURN_ID),
    taskStarted(COPIED_TURN_ID),
    userMessage(),
    functionCall('call-huge', 'shell', '{"cmd":"cat bigfile"}'),
    hugeLine,
    tokenCount(100, 200),
    taskComplete(COPIED_TURN_ID),
    turnContext(OWNED_TURN_ID),
    taskStarted(OWNED_TURN_ID),
    userMessage(),
    rec('2026-10-26T00:00:05.000Z', 'event_msg', { type: 'agent_message', message: 'owned result', phase: 'final' }),
    tokenCount(50, 100),
    taskComplete(OWNED_TURN_ID),
  ];

  await writeTranscript(sessionDir, FORK_THREAD_ID, lines);

  await fsp.writeFile(
    path.join(root, 'wakeups', `${FORK_THREAD_ID}.json`),
    JSON.stringify({
      session_id: FORK_THREAD_ID,
      ...(LIVE_FORK ? { initial_turn_id: OWNED_TURN_ID, hook_event: 'stop' } : {}),
      received_at: new Date().toISOString(),
      codex_home: path.join(root, 'codex-home'),
      session_dir: sessionDir,
    }),
  );

  if (!input.running) await startInput(input);
  return { root, input };
}

// ---------------------------------------------------------------------------
// Path B: Large unterminated tail re-read every cycle
//
// The file grows between cycles. Each cycle, recoverTurnSegment re-reads
// from activeTurn.startOffset (near the start) to the growing scan frontier.
// ---------------------------------------------------------------------------
async function setupPathB(
  baseDir: string,
): Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }> {
  const root = path.join(baseDir, 'path-b');
  const sessionDir = path.join(root, 'sessions');
  await fsp.mkdir(sessionDir, { recursive: true });

  // Initial file: session_meta + turn start + user message + some tool data
  const initialTools: string[] = [];
  for (let i = 0; i < 50; i++) {
    initialTools.push(functionCall(`call-init-${i}`, 'shell', `{"cmd":"init-${i}"}`));
    initialTools.push(functionOutput(`call-init-${i}`, 'O'.repeat(100_000)));
  }

  const lines = [
    sessionMeta(SESSION_ID),
    turnContext(TURN_ID_1),
    taskStarted(TURN_ID_1),
    userMessage(),
    ...initialTools,
  ];

  const transcriptPath = await writeTranscript(sessionDir, SESSION_ID, lines);

  const { input } = await createInput(root);
  await startInput(input);

  // Append data between cycles to simulate a growing transcript
  let appendCounter = 0;
  const onCycle = async () => {
    const newRecords: string[] = [];
    for (let i = 0; i < 10; i++) {
      const idx = 50 + appendCounter * 10 + i;
      newRecords.push(functionCall(`call-grow-${idx}`, 'shell', `{"cmd":"grow-${idx}"}`));
      newRecords.push(functionOutput(`call-grow-${idx}`, 'G'.repeat(OUTPUT_BYTES)));
      if (NORMAL_WAVES) newRecords.push(tokenCount(100, 200));
    }
    await appendTranscript(transcriptPath, newRecords);
    appendCounter++;
  };

  return { root, input, onCycle };
}

// ---------------------------------------------------------------------------
// Path C: Missing session_meta → full-file scan every cycle
// ---------------------------------------------------------------------------
async function setupPathC(
  baseDir: string,
): Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }> {
  const root = path.join(baseDir, 'path-c');
  const sessionDir = path.join(root, 'sessions');
  await fsp.mkdir(sessionDir, { recursive: true });

  const lines: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    lines.push(
      rec('2026-10-26T00:00:01.000Z', 'event_msg', {
        type: 'agent_message',
        message: `commentary line ${i} ${'P'.repeat(100)}`,
        phase: 'commentary',
      }),
    );
  }

  await writeTranscript(sessionDir, SESSION_ID, lines);

  const { input } = await createInput(root);
  await startInput(input);
  return { root, input };
}

// ---------------------------------------------------------------------------
// Path D: Unrecoverable pending terminal — infinite retry
//
// We pre-populate the checkpoint with a pendingTerminal pointing at a range
// filled with unrecognized record types. The extractor finds no prompt, no
// steps, and no matching terminal → returns null → 'unparseable'. The code
// keeps retrying every cycle without backoff, re-reading the same 5 MiB
// range each time.
// ---------------------------------------------------------------------------
async function setupPathD(
  baseDir: string,
): Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }> {
  const root = path.join(baseDir, 'path-d');
  const sessionDir = path.join(root, 'sessions');
  await fsp.mkdir(sessionDir, { recursive: true });

  const lines: string[] = [sessionMeta(SESSION_ID)];
  for (let i = 0; i < 50; i++) {
    lines.push(
      rec('2026-10-26T00:00:01.000Z', 'internal_annotation', {
        index: i,
        data: 'D'.repeat(100_000),
      }),
    );
  }

  const transcriptPath = await writeTranscript(sessionDir, SESSION_ID, lines);
  const stat = await fsp.stat(transcriptPath);

  const stateStore = new StateStore(path.join(root, 'input-state.json'));
  await stateStore.load();
  const stateKey = `codex-transcript:${transcriptPath}`;
  stateStore.update(stateKey, {
    lastOffset: 0,
    extra: {
      codexTranscript: {
        inode: stat.ino,
        scanOffset: stat.size,
        activeTurn: {
          turnId: TURN_ID_1,
          startOffset: 0,
          startedAtMs: Date.now(),
          emittedPrompt: false,
          emittedStepCount: 0,
          emittedStepRequestIds: [],
          emittedStepResponseIds: [],
          emittedToolCallIds: [],
          emittedToolResultIds: [],
        },
        pendingTerminal: {
          turnId: TURN_ID_1,
          terminalEndOffset: stat.size,
          retryCount: 0,
          firstPendingAtMs: Date.now(),
          lastAttemptAtMs: Date.now(),
          sourceRecordCount: 0,
        },
        pendingFusion: null,
        pendingSubagent: null,
        ownerSessionMetaOffset: 0,
      },
    },
  });
  await stateStore.save();

  const input = await createInputWithStore(root, stateStore);
  await startInput(input);
  return { root, input };
}

// ---------------------------------------------------------------------------
// Path E: Metadata cache full → cold file header re-reads
//
// We create 500 files, each with a ~200 KB base_instructions in session_meta.
// The cache byte limit (64 MiB) can hold ~320 entries. The remaining ~180
// files are rejected as 'discovery' entries each cycle, forcing readJsonLineAt
// to re-read the large session_meta headers from disk every cycle.
// ---------------------------------------------------------------------------
async function setupPathE(
  baseDir: string,
): Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }> {
  const root = path.join(baseDir, 'path-e');
  const sessionDir = path.join(root, 'sessions');
  await fsp.mkdir(sessionDir, { recursive: true });

  const fileCount = 500;
  const largeInstructions = 'E'.repeat(200_000);

  for (let i = 0; i < fileCount; i++) {
    const sid = `stress-e-session-${String(i).padStart(4, '0')}`;
    const completedTurn = [
      rec('2026-10-26T00:00:00.000Z', 'session_meta', {
        id: sid,
        model_provider: 'openai',
        session_id: sid,
        base_instructions: largeInstructions,
      }),
      turnContext(TURN_ID_1),
      taskStarted(TURN_ID_1),
      userMessage(),
      functionCall(`call-e-${i}`, 'shell', `{"cmd":"task-${i}"}`),
      functionOutput(`call-e-${i}`, 'E'.repeat(1_000)),
      tokenCount(100, 200),
      taskComplete(TURN_ID_1),
    ];
    await writeTranscript(sessionDir, sid, completedTurn);
  }

  const { input } = await createInput(root);
  await startInput(input);
  return { root, input };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
interface CycleMetric {
  cycle: number;
  phase: string;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  readBytes: number;
  readCalls: number;
  reasons?: InputRuntimeDelta['codexRead'];
  workMemory?: { fullMetaBytes: number; ownerIndexBytes: number; continuationBytes: number;
    pausedReaderBytes: number; giantReaderFiles: number; giantReaderBytes: number };
  memory: NodeJS.MemoryUsage;
  checkpoints: unknown[];
}
async function measureCycle(input: InputType, cycle: number, phase: string): Promise<CycleMetric> {
  const data = observations.get(input)!;
  const offset = data.deltas.length;
  cycleReadBytes = 0;
  const start = performance.now();
  const cpu = process.cpuUsage();
  await doRunCycle(input);
  const elapsed = process.cpuUsage(cpu);
  const wallMs = performance.now() - start;
  const deltas = data.deltas.slice(offset);
  assert.equal(deltas.length, 1, '每个显式周期必须生成一个 runtime delta');
  const delta = deltas[0]!;
  const workMemory = (input as any).workMemorySnapshot?.();
  if (ACCEPT) {
    assert(workMemory.fullMetaBytes <= 64 * 1024 * 1024 && workMemory.ownerIndexBytes <= 16 * 1024 * 1024);
    assert(workMemory.continuationBytes <= 32 * 1024 * 1024 && workMemory.pausedReaderBytes <= 32 * 1024 * 1024);
    assert(workMemory.giantReaderFiles <= 1, '同时占用多个巨大槽位');
  }
  assertEntries(input);
  return { cycle, phase, wallMs, cpuUserMs: elapsed.user / 1000, cpuSystemMs: elapsed.system / 1000,
    readBytes: delta.rawReadBytes, readCalls: delta.rawReadCalls, reasons: delta.codexRead, workMemory, memory: process.memoryUsage(),
    checkpoints: [...(input as any).ownerSnapshots?.keys() ?? []].slice(0, DETAILS ? undefined : 4).map(file => {
      const cp = checkpoint(input, file);
      return { file, inode: cp?.inode, scanOffset: cp?.scanOffset, ownerOffset: cp?.ownerSessionMetaOffset,
        owner: cp?.ownerProbe?.kind, probeOffset: cp?.ownerProbe?.probe?.nextCompleteOffset,
        startupTarget: cp?.startupBaselineTarget, active: cp?.activeTurn ? { turnId: cp.activeTurn.turnId,
          startOffset: cp.activeTurn.startOffset, steps: cp.activeTurn.emittedStepCount } : null,
        pending: cp?.pendingTerminal ? { endOffset: cp.pendingTerminal.terminalEndOffset,
          retryCount: cp.pendingTerminal.retryCount, nextRetryAtMs: cp.pendingTerminal.nextRetryAtMs } : null };
    }) };
}

interface ScenarioResult {
  path: string;
  description: string;
  fileSize: number;
  fileCount: number;
  cycles: number;
  metrics: CycleMetric[];
  totalWallMs: number;
  totalCpuUserMs: number;
  totalCpuSystemMs: number;
  totalReadBytes: number;
  avgWallMs: number;
  avgCpuMs: number;
  avgReadMiB: number;
  readAmplification: number;
  startupReadBytes: number;
  startupCpuMs: number;
  startupWallMs: number;
  warmup: CycleMetric[];
  drain: CycleMetric[];
  producerCpuMs: number;
  uniqueInputBytes: number;
  entries: number;
  eventLoopP95Ms: number;
  steadyEntries: number;
  eventFacts: string[];
  peer?: { published: number; emitted: number; p95Ms: number; maxMs: number };
}

async function measureFileStats(
  sessionDir: string,
): Promise<{ size: number; count: number }> {
  let size = 0;
  let count = 0;
  const dir = path.join(sessionDir, '2026', '10', '26');
  try {
    for (const f of await fsp.readdir(dir)) {
      if (f.endsWith('.jsonl')) {
        size += (await fsp.stat(path.join(dir, f))).size;
        count++;
      }
    }
  } catch {
    /* empty */
  }
  return { size, count };
}

type SetupFn = (
  baseDir: string,
) => Promise<{ root: string; input: InputType; onCycle?: () => Promise<void> }>;

async function runScenario(
  label: string,
  description: string,
  setup: SetupFn,
  cycles: number,
  baseDir: string,
): Promise<ScenarioResult> {
  const startupRangeOffset = readRanges.length;
  const { root, input, onCycle } = await setup(baseDir);
  // start() 的 readiness 可以早于首轮 checkpoint 完成；排空首轮后才进入采样。
  await (input as any).cyclePromise;
  const data = observations.get(input)!;
  // 旧基线没有 startup runtime delta，仍用相同源探针统计，避免隐去历史读取。
  const startupReadBytes = readRanges.slice(startupRangeOffset).reduce((sum, range) => sum + range.bytes, 0);
  if (ACCEPT) assert.equal(startupReadBytes, data.deltas.reduce((sum, delta) => sum + delta.rawReadBytes, 0), 'startup 读量遗漏');
  const startup = startupCosts.get(input)!;
  const { size: fileSize, count: fileCount } = await measureFileStats(path.join(root, 'sessions'));
  const warmup: CycleMetric[] = [];
  const metrics: CycleMetric[] = [];
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let producerCpuMs = 0;
  let drained: CycleMetric[] = [];
  let uniqueInputBytes = fileSize;
  let steadyEntries = 0;
  let peer: Awaited<ReturnType<typeof createPeerProbe>> | undefined;
  let peerResult: ScenarioResult['peer'];
  try {
    if (ACCEPT) warmup.push(...await drain(input, 'warmup'));
    if (PEER) peer = await createPeerProbe(root, data.store);
    for (let i = 0; i < cycles; i++) {
      const cpu = process.cpuUsage();
      await peer?.publish();
      if (onCycle) await onCycle();
      const elapsed = process.cpuUsage(cpu);
      producerCpuMs += (elapsed.user + elapsed.system) / 1000;
      metrics.push(await measureCycle(input, i + 1, 'steady'));
      await peer?.flush();
      if (ACCEPT && label === 'B' && !NORMAL_WAVES) assert.equal(data.entries.filter(entry => entry['event.name'] === 'tool.call').length, 0, 'token 到达前提前提交波次');
    }
    steadyEntries = data.entries.length;
    if (label === 'B' && COMPLETE) {
      const file = (await filesFor(input))[0]!;
      await appendTranscript(file, [tokenCount(100, 200), taskComplete(TURN_ID_1)]);
      drained.push(await measureCycle(input, 1, 'drain'));
      drained.push(...await drain(input, 'drain', false));
      const calls = data.entries.filter(entry => entry['event.name'] === 'tool.call');
      const results = data.entries.filter(entry => entry['event.name'] === 'tool.result');
      assert.equal(calls.length, cycles * 10, 'B 工具调用缺失或提前提交');
      assert.equal(results.length, calls.length, 'B 工具结果不完整');
      const expected = compact('G'.repeat(OUTPUT_BYTES));
      for (let i = 0; i < calls.length; i++) {
        assert.equal(calls[i]!['gen_ai.tool.call.id'], `call-grow-${50 + i}`);
        assert.equal(results[i]!['gen_ai.tool.call.id'], calls[i]!['gen_ai.tool.call.id']);
        assert.deepEqual(results[i]!['gen_ai.tool.call.result'], expected, 'B 正文被截断或引用混用');
      }
      assert.equal(data.entries.filter(entry => entry['gen_ai.turn.end'] === true).length, 1);
    }
    if (ACCEPT && ['A', 'C', 'D', 'E'].includes(label)) assert.equal(metrics.reduce((sum, metric) => sum + metric.readBytes, 0), 0, `${label} 静止周期发生回读`);
    if (ACCEPT && label === 'A') {
      assert.equal(data.entries.filter(entry => entry['event.name'] === 'llm.response').length, 1, 'A owned 事件未产出');
      assert(data.entries.every(entry => entry['agent.codex.transcript_turn_id'] === OWNED_TURN_ID), 'A 重放了 ancestor');
    }
    if (ACCEPT && ['C', 'E'].includes(label)) {
      assert.equal(data.entries.length, 0, '启动 baseline 重放了历史');
      const file = (await filesFor(input)).sort().at(-1)!;
      const sid = label === 'C' ? SESSION_ID : `stress-e-session-0499`;
      await appendTranscript(file, [...(label === 'C' ? [sessionMeta(sid)] : []), turnContext('live-after-idle'), taskStarted('live-after-idle'),
        userMessage(), functionCall('live-call', 'shell', '{"cmd":"fresh"}'), functionOutput('live-call', 'fresh output'), tokenCount(100, 200), taskComplete('live-after-idle')]);
      drained.push(await measureCycle(input, 1, 'drain'));
      drained.push(...await drain(input, 'drain', false));
      assert.equal(data.entries.filter(entry => entry['event.name'] === 'tool.result').length, 1, '冷文件追加业务缺失');
      assert.equal(data.entries.filter(entry => entry['gen_ai.turn.end'] === true).length, 1);
      if (label === 'E') assert(JSON.stringify(data.entries).includes(createHash('sha256').update('E'.repeat(200_000)).digest('hex')), 'E hydrate 后缺 instructions');
    }
    if (ACCEPT && label === 'D') for (const file of await filesFor(input)) {
      const cp = checkpoint(input, file);
      assert.equal(cp.pendingTerminal.retryCount, 1, '退避期间增加 attempt');
      assert(cp.activeTurn && cp.pendingTerminal, 'pending 被丢弃');
    }
    uniqueInputBytes = (await measureFileStats(path.join(root, 'sessions'))).size;
    if (ACCEPT && label === 'B') assert((startupReadBytes + [...warmup, ...metrics, ...drained].reduce((sum, metric) => sum + metric.readBytes, 0)) / uniqueInputBytes <= 3, 'B 超过 3x 读量');
    assertEntries(input);
  } finally {
    delay.disable();
    peerResult = await peer?.stop();
    await input.stop();
    await fsp.rm(root, { recursive: true, force: true });
  }
  const totalWallMs = metrics.reduce((sum, metric) => sum + metric.wallMs, 0);
  const totalCpuUserMs = metrics.reduce((sum, metric) => sum + metric.cpuUserMs, 0);
  const totalCpuSystemMs = metrics.reduce((sum, metric) => sum + metric.cpuSystemMs, 0);
  const measuredReadBytes = metrics.reduce((sum, metric) => sum + metric.readBytes, 0);

  return {
    path: label,
    description,
    fileSize,
    fileCount,
    cycles,
    metrics,
    totalWallMs,
    totalCpuUserMs,
    totalCpuSystemMs,
    totalReadBytes: measuredReadBytes,
    startupReadBytes, startupCpuMs: startup.cpuMs, startupWallMs: startup.wallMs,
    warmup, drain: drained, producerCpuMs, uniqueInputBytes, entries: data.entries.length, steadyEntries,
    eventFacts: data.entries.map(({ observed_time_unix_nano: _clock, ...entry }) => createHash('sha256')
      .update(JSON.stringify(canonical(entry))).digest('hex')),
    peer: peerResult,
    eventLoopP95Ms: Number.isFinite(delay.percentile(95)) ? delay.percentile(95) / 1e6 : 0,
    avgWallMs: totalWallMs / cycles,
    avgCpuMs: (totalCpuUserMs + totalCpuSystemMs) / cycles,
    avgReadMiB: measuredReadBytes / cycles / (1024 * 1024),
    readAmplification: uniqueInputBytes > 0 ? measuredReadBytes / uniqueInputBytes : 0,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function printReport(results: ScenarioResult[]): void {
  const W = 92;
  const divider = '═'.repeat(W);
  const thinDiv = '─'.repeat(W);

  console.log('\n' + divider);
  console.log(
    '  Issue #720491 — Codex Transcript Read Amplification Stress Test Report',
  );
  console.log('  ' + new Date().toISOString());
  console.log(
    `  Platform: ${os.platform()}/${os.arch()}, Node ${process.version}`,
  );
  console.log(
    `  CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model ?? 'unknown'}`,
  );
  console.log(`  Cycles per scenario: ${TOTAL_CYCLES}`);
  console.log(divider);

  for (const r of results) {
    console.log(`\n┌─ Path ${r.path}: ${r.description}`);
    console.log(
      `│  Files: ${r.fileCount}, On-disk size (at setup): ${fmtBytes(r.fileSize)}`,
    );
    console.log(`│  Cycles: ${r.cycles}, entries: ${r.entries}`);
    console.log(`│  Startup: ${fmtBytes(r.startupReadBytes)}, warmup: ${fmtBytes(r.warmup.reduce((s, m) => s + m.readBytes, 0))}, drain: ${fmtBytes(r.drain.reduce((s, m) => s + m.readBytes, 0))}`);
    console.log(`│  Producer CPU: ${r.producerCpuMs.toFixed(1)} ms (excluded), event-loop p95: ${r.eventLoopP95Ms.toFixed(2)} ms`);
    console.log('│');
    console.log(`│  Total wall time:    ${r.totalWallMs.toFixed(1)} ms`);
    console.log(`│  Total CPU (user):   ${r.totalCpuUserMs.toFixed(1)} ms`);
    console.log(`│  Total CPU (system): ${r.totalCpuSystemMs.toFixed(1)} ms`);
    console.log(`│  Total I/O read:     ${fmtBytes(r.totalReadBytes)}`);
    console.log('│');
    console.log(`│  Avg wall / cycle:   ${r.avgWallMs.toFixed(2)} ms`);
    console.log(`│  Avg CPU / cycle:    ${r.avgCpuMs.toFixed(2)} ms`);
    console.log(
      `│  Avg read / cycle:   ${fmtBytes(r.totalReadBytes / r.cycles)}`,
    );
    console.log(
      `│  Read amplification: ${r.readAmplification.toFixed(1)}x (steady read / unique input including appends)`,
    );
    console.log('│');

    const show =
      r.metrics.length <= 12
        ? r.metrics
        : [...r.metrics.slice(0, 5), null, ...r.metrics.slice(-5)];
    console.log('│  cycle │ wall ms  │ cpu ms   │ read');
    console.log('│  ──────┼──────────┼──────────┼──────────────');
    for (const m of show) {
      if (!m) {
        console.log('│   ...  │   ...    │   ...    │  ...');
        continue;
      }
      console.log(
        `│  ${String(m.cycle).padStart(5)} │` +
          ` ${m.wallMs.toFixed(1).padStart(8)} │` +
          ` ${(m.cpuUserMs + m.cpuSystemMs).toFixed(1).padStart(8)} │` +
          `  ${fmtBytes(m.readBytes)}`,
      );
    }
    console.log('└' + '─'.repeat(62));
  }

  console.log('\n' + thinDiv);
  console.log('SUMMARY');
  console.log(thinDiv);
  console.log(
    'Path'.padEnd(6) +
      'Description'.padEnd(50) +
      'Avg CPU'.padStart(10) +
      'Avg Read'.padStart(12) +
      'Ampl.'.padStart(10),
  );
  console.log(thinDiv);
  for (const r of results) {
    console.log(
      `  ${r.path}`.padEnd(6) +
        r.description.slice(0, 48).padEnd(50) +
        `${r.avgCpuMs.toFixed(2)} ms`.padStart(10) +
        `${fmtBytes(r.totalReadBytes / r.cycles)}`.padStart(12) +
        `${r.readAmplification.toFixed(1)}x`.padStart(10),
    );
  }
  console.log(thinDiv);

  const totalCpu = results.reduce(
    (s, r) => s + r.totalCpuUserMs + r.totalCpuSystemMs,
    0,
  );
  const totalRead = results.reduce((s, r) => s + r.totalReadBytes, 0);
  console.log(
    `\nAll paths — Total CPU: ${totalCpu.toFixed(1)} ms, Total I/O read: ${fmtBytes(totalRead)}`,
  );
  console.log(divider + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `Read Amplification Stress Test — ${TOTAL_CYCLES} cycles per scenario`,
  );
  console.log(`Enabled paths: ${[...ENABLED_PATHS].join(', ')}\n`);

  const baseDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'read-amp-stress-'),
  );
  console.log(`Temp dir: ${baseDir}`);

  const scenarios: { label: string; description: string; setup: SetupFn }[] =
    [];

  if (ENABLED_PATHS.has('A'))
    scenarios.push({
      label: 'A',
      description: 'findTurnStartOffset stuck on >16 MiB record (fork)',
      setup: setupPathA,
    });
  if (ENABLED_PATHS.has('B'))
    scenarios.push({
      label: 'B',
      description: 'Large unterminated tail re-read (growing file)',
      setup: setupPathB,
    });
  if (ENABLED_PATHS.has('C'))
    scenarios.push({
      label: 'C',
      description: 'Missing session_meta full-file scan every cycle',
      setup: setupPathC,
    });
  if (ENABLED_PATHS.has('D'))
    scenarios.push({
      label: 'D',
      description: 'Pending terminal infinite retry (same range)',
      setup: setupPathD,
    });
  if (ENABLED_PATHS.has('E'))
    scenarios.push({
      label: 'E',
      description: 'Cache full → cold file header re-read every cycle',
      setup: setupPathE,
    });

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    console.log(
      `\n▶ Running Path ${scenario.label}: ${scenario.description}...`,
    );
    try {
      const result = await runScenario(
        scenario.label,
        scenario.description,
        scenario.setup,
        TOTAL_CYCLES,
        baseDir,
      );
      results.push(result);
      console.log(
        `  ✓ Done. Total read: ${fmtBytes(result.totalReadBytes)}, avg CPU/cycle: ${result.avgCpuMs.toFixed(2)} ms`,
      );
    } catch (err) {
      console.error(`  ✗ Path ${scenario.label} failed:`, err);
      process.exitCode = 1;
    }
  }

  printReport(results);
  const reportPath = argValue('--report', '');
  if (reportPath) await fsp.writeFile(path.resolve(reportPath), JSON.stringify({ node: process.version, sourceRoot,
    evidence: 'REAL_MEASURED', cpu: os.cpus()[0]?.model, runnerSha256: createHash('sha256').update(await fsp.readFile(new URL(import.meta.url))).digest('hex'),
    accept: ACCEPT, complete: COMPLETE, liveFork: LIVE_FORK, waves: NORMAL_WAVES, peer: PEER, outputBytes: OUTPUT_BYTES, results }, null, 2));
  await fsp.rm(baseDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
