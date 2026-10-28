import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import { ClientType, CollectionMethod, type AgentActivityEntry, type JsonValue } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, isDoubaoPresentationInspection, parseDoubaoLogLine, type DoubaoPendingTurn, type DoubaoLogEvent } from './doubao-work-log.js';
import { buildNativeToolEvents, type NativeGraph } from './doubao-work-native.js';
import { buildNativeExecutionEvents, isUniqueNativeToolOwner, type NativeExecution } from './doubao-work-execution.js';
import { enrichNativeToolEvents, nativeTaskContent, nativeToolObservations, type NativeContent } from './doubao-work-content.js';
import { nativeDemandFingerprint, nativeRoundSteps, type NativeAssistantRound, type NativeRoundReconstruction } from './doubao-work-rounds.js';
import { checkpointDraft } from './doubao-work-state.js';
import { DoubaoWorkBudget, DoubaoWorkDeferred } from './doubao-work-budget.js';
import { DoubaoWorkNativeReader } from './doubao-work-reader.js';

const FILE_PATTERN = /^saman(?:_frontend)?_\d{4}\.\d{4}\.\d+\.log$/;
const MAX_FILES = 128;
const READ_BYTES = 1024 * 1024;
const MAX_PENDING = 512;
const MAX_COMPLETED = 4096;
const MAX_TOOLS = 4096;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TTL_MS = 7 * PENDING_TTL_MS;
const EXECUTION_PARENT_GRACE_MS = 30_000;
const EXECUTION_PARENT_WRITE_GRACE_MS = 120_000;

interface FileCursor { identity: string; offset: number; anchor?: string; skippingLine?: boolean }
interface PendingTurn extends DoubaoPendingTurn { startObserved: boolean; terminal?: DoubaoLogEvent }
interface PendingTool { start?: DoubaoLogEvent; end?: DoubaoLogEvent; conflict?: boolean; updatedMs: number }
interface Checkpoint {
  schema: 1;
  sinceMs: number;
  files: Record<string, FileCursor>;
  pending: Record<string, PendingTurn>;
  pendingScanCursor?: string;
  completed: Record<string, number>;
  tools?: Record<string, PendingTool>;
  roots?: Record<string, PendingTurn & { terminal: DoubaoLogEvent }>;
  sandboxes?: Record<string, { actors: string[]; conflict?: boolean; updatedMs: number }>;
  nativeCompleted?: Record<string, number>;
  nativeScanCursor?: string;
  executionsCompleted?: Record<string, { digest: string; updatedMs: number }>;
  executionScanCursor?: string;
  executionFirstSeen?: Record<string, number>;
  nativeMutationActors?: Record<string, { callId: string; timeNano?: string; updatedMs: number }>;
}

export interface DoubaoWorkInputOptions extends InputOptions {
  logDir?: string; sessionsRoot?: string; snapshotRoot?: string;
  /** Native metadata has no watcher. Limit scans independently of log wakeups. */
  nativeScanIntervalMs?: number;
  /** Internal work limits; useful for deterministic incremental recovery tests. */
  workBudget?: { bytes?: number; milliseconds?: number; records?: number };
}

/** Read-only adapter for observed macOS and Windows client lifecycle logs. */
export class DoubaoWorkInput extends BaseInput {
  readonly id = 'doubao-work';
  readonly agentType = ClientType.DoubaoWork;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private readonly logDir: string | undefined;
  private readonly scope: string;
  private readonly sessionsRoot: string | undefined;
  private readonly userDataRoot: string | undefined;
  private readonly snapshotRoot: string | undefined;
  private watcher: FSWatcher | undefined;
  private wakeup: ReturnType<typeof setTimeout> | undefined;
  private warnedFileLimit = false;
  private readonly nativeScanIntervalMs: number;
  private nextNativeScanAt = 0;
  private nextCompactionAt = 0;
  private nextCacheDiagnosticsAt = 0;
  private normalizedCheckpoint = false;
  private executionScanCursor: string | undefined;
  private readonly executionDigests = new WeakMap<NativeExecution, string>();
  private readonly nativeReader: DoubaoWorkNativeReader;
  private readonly workLimits: DoubaoWorkInputOptions['workBudget'];
  private budget!: DoubaoWorkBudget;
  private readonly cycleGraphs = new Map<string, Promise<NativeGraph | undefined>>();
  private readonly reportedIoErrors = new Set<string>();
  private nativeDeferred = false;
  private baselineState: { state: Checkpoint; names: string[]; index: number } | undefined;
  private logSweep: { names: string[]; index: number; drained: boolean } | undefined;
  private finalizeLogWindow: string[] | undefined;
  private readonly reconstructionJobs = new Map<string, { version: string; conversation: string; bytes: number; updatedMs: number;
    steps: Generator<number, NativeRoundReconstruction | undefined>; graph: NativeGraph; executions?: NativeExecution[] }>();

  constructor(opts: DoubaoWorkInputOptions) {
    super(opts);
    this.logDir = opts.logDir ? path.resolve(opts.logDir) : DoubaoWorkInput.defaultLogDir();
    this.scope = doubaoDigest(this.logDir ?? 'unsupported-platform');
    this.sessionsRoot = opts.sessionsRoot;
    this.userDataRoot = this.logDir ? path.resolve(this.logDir, '../..') : undefined;
    this.snapshotRoot = opts.snapshotRoot ?? (this.logDir ? path.resolve(this.logDir, '../../coding/snapshot') : undefined);
    this.nativeScanIntervalMs = Math.max(0, opts.nativeScanIntervalMs ?? 10_000);
    this.workLimits = opts.workBudget;
    this.nativeReader = new DoubaoWorkNativeReader({ sessionsRoot: this.sessionsRoot, userDataRoot: this.userDataRoot,
      snapshotRoot: this.snapshotRoot, diagnostic: reason => this.logger.warn('Doubao Work bounded native collection degraded', { reason }) });
  }

  static defaultLogDir(): string | undefined {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.win32.join(homedir(), 'AppData', 'Local');
      return path.win32.join(local, 'DoubaoWork', 'User Data', 'sdk_storage', 'log');
    }
    return process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support', 'DoubaoWork', 'sdk_storage', 'log')
      : undefined;
  }

  static getWatchPaths(logDir = DoubaoWorkInput.defaultLogDir()): string[] {
    return logDir ? [logDir] : [];
  }

  static async checkAvailability(logDir = DoubaoWorkInput.defaultLogDir()): Promise<boolean> {
    if (!logDir) return false;
    try {
      return (await fs.readdir(logDir, { withFileTypes: true }))
        .some(entry => entry.isFile() && FILE_PATTERN.test(entry.name));
    } catch { return false; }
  }

  protected override async onStart(): Promise<void> {
    if (!this.logDir) return;
    try {
      this.watcher = watch(this.logDir, { persistent: false }, (_event, name) => {
        if (name && !FILE_PATTERN.test(name.toString())) return;
        if (this.wakeup) return;
        this.wakeup = setTimeout(() => {
          this.wakeup = undefined;
          this.requestCollection();
        }, 1000);
        this.wakeup.unref();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.logger.warn('Doubao Work file watcher unavailable; using bounded polling');
      });
    } catch {
      this.logger.warn('Doubao Work file watcher unavailable; using bounded polling');
    }
  }

  protected override async onStop(): Promise<void> {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.wakeup) clearTimeout(this.wakeup);
    this.wakeup = undefined;
    this.nativeReader.clear(); this.cycleGraphs.clear();
    this.reconstructionJobs.clear();
    this.logSweep = undefined; this.finalizeLogWindow = undefined;
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (!this.logDir) return [];
    this.budget = new DoubaoWorkBudget(this.getInputRuntimeAccumulator(), this.workLimits);
    this.cycleGraphs.clear(); this.nativeDeferred = false;
    for (const [key, job] of this.reconstructionJobs) if (Date.now() - job.updatedMs > 60_000) this.reconstructionJobs.delete(key);
    let allNames: string[];
    try {
      allNames = (await fs.readdir(this.logDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name)).map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    } catch {
      this.logger.warn('Doubao Work log directory unavailable; preserving checkpoint');
      return [];
    }
    const names = allNames.slice(-MAX_FILES);
    if (allNames.length > MAX_FILES && !this.warnedFileLimit) {
      this.warnedFileLimit = true;
      this.logger.warn('Doubao Work source file limit reached; only newest files are read', { limit: MAX_FILES });
    }
    const saved = this.getState().extra?.doubaoWork as Checkpoint | undefined;
    if (saved && saved.schema !== 1) {
      this.logger.warn('Unsupported Doubao Work checkpoint schema; preserving state');
      return [];
    }
    // Baseline all existing files once. New rotations are subsequently read from byte zero.
    if (!saved) {
      this.baselineState ??= { state: { schema: 1, sinceMs: Date.now(), files: {}, pending: {}, completed: {} }, names, index: 0 };
      const baseline = this.baselineState, initial = baseline.state;
      for (; baseline.index < baseline.names.length; baseline.index++) {
        const name = baseline.names[baseline.index];
        try {
          if (this.budget.exhausted) { this.defer(new DoubaoWorkDeferred('cycle_budget')); return []; }
          const stat = await fs.stat(path.join(this.logDir, name));
          // Fingerprint the cursor boundary to detect in-place truncate-and-regrow.
          const handle = await fs.open(path.join(this.logDir, name), 'r');
          try {
            initial.files[name] = { identity: fileIdentity(stat), offset: stat.size, anchor: await boundaryAnchor(handle, stat.size, this.getInputRuntimeAccumulator(), this.budget) };
          } finally { await handle.close(); }
        } catch (error) {
          if (!this.defer(error)) this.baselineState = undefined;
          return []; // Do not commit an incomplete initial baseline.
        }
      }
      this.setState({ extra: { doubaoWork: initial } });
      this.baselineState = undefined;
      return [];
    }
    const draft = checkpointDraft(saved), next = draft.value;
    next.tools ??= {};
    // An older collector may have checkpointed this helper before upgrade.
    // Apply the same source distinction to restored receipt/settlement facts.
    if (!this.normalizedCheckpoint) {
      for (const [key, pair] of Object.entries(next.tools)) {
        if ([pair.start?.tool, pair.end?.tool].some(tool => tool && isDoubaoPresentationInspection(tool.name, tool.id))) delete next.tools[key];
      }
    }
    next.roots ??= {};
    next.sandboxes ??= {};
    next.nativeCompleted ??= {};
    next.executionsCompleted ??= {};
    next.executionFirstSeen ??= {};
    next.nativeMutationActors ??= {};
    const active = new Set(Object.values(next.pending).flatMap(p => {
      const conversation = p.conversationId ?? p.terminal?.conversationId;
      return conversation ? [conversation] : [];
    }));
    for (const job of this.reconstructionJobs.values()) active.add(job.conversation);
    const boxes = new Set(Object.values(next.tools).flatMap(tool => tool.start?.tool ? [tool.start.tool.sandboxId] : []));
    for (const id of boxes) {
      const roots = next.sandboxes[id]?.actors.filter(actor => !/^[mos]_[a-zA-Z0-9]+$/.test(actor));
      const root = roots?.length === 1 ? next.roots[roots[0]] : undefined;
      if (root?.conversationId) active.add(root.conversationId);
    }
    this.nativeReader.beginCycle(active);
    const entries: AgentActivityEntry[] = [];
    const events: DoubaoLogEvent[] = [];
    const finalizationCycle = this.finalizeLogWindow?.length === names.length
      && this.finalizeLogWindow.every((name, index) => name === names[index]);
    this.finalizeLogWindow = undefined;
    const sweep = this.logSweep ??= { names, index: 0, drained: true };
    let drained = finalizationCycle || sweep.drained;
    let moreLogWork = false;
    if (!finalizationCycle) for (; sweep.index < sweep.names.length; sweep.index++) {
      if (this.budget.exhausted) break;
      const name = sweep.names[sweep.index];
      if (!names.includes(name)) { drained = false; continue; }
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(path.join(this.logDir, name), 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const identity = fileIdentity(stat);
        const prior = next.files[name] ?? Object.values(next.files).find(cursor => cursor.identity === identity);
        const cursor: FileCursor = prior?.identity === identity && prior.offset <= stat.size
          ? { ...prior } : { identity, offset: 0 };
        if (cursor.anchor && cursor.anchor !== await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator(), this.budget)) {
          cursor.offset = 0;
          cursor.skippingLine = false;
        }
        const unread = stat.size - cursor.offset;
        this.getInputRuntimeAccumulator()?.observeBacklog(unread);
        if (unread > 0) {
          const requested = Math.min(READ_BYTES, this.budget.remainingBytes - 64, unread);
          if (requested <= 0) throw new DoubaoWorkDeferred('cycle_budget');
          const buffer = Buffer.allocUnsafe(requested);
          const bytesRead = await this.budget.read(handle, buffer, requested, cursor.offset);
          if (bytesRead < unread) { drained = false; moreLogWork = true; }
          const chunk = buffer.subarray(0, bytesRead);
          let from = 0;
          let records = 0;
          let parsed = 0;
          const fileEvents: DoubaoLogEvent[] = [];
          let maxLineBytes = 0;
          while (from < chunk.length) {
            if (this.budget.exhausted && from > 0) { drained = false; break; }
            const newline = chunk.indexOf(10, from);
            if (newline < 0) break; // A normal trailing half-line keeps its old offset.
            const end = newline + 1;
            records++;
            maxLineBytes = Math.max(maxLineBytes, end - from);
            let recognized = false;
            if (!cursor.skippingLine) {
              const event = parseDoubaoLogLine(chunk.subarray(from, newline).toString('utf8'), name);
              if (event) {
                parsed++;
                recognized = true;
                fileEvents.push(event);
              }
            }
            // Unrelated log text is byte/time bounded, without spending the
            // decoded-record allowance needed by native JSON and round work.
            this.budget.record(recognized ? 1 : 0, 1);
            cursor.skippingLine = false;
            from = end;
            await this.budget.yieldIfNeeded();
          }
          // An oversized line is skipped through its newline without unbounded buffering.
          if (from === 0 && bytesRead === READ_BYTES && chunk.indexOf(10) < 0) {
            from = bytesRead;
            cursor.skippingLine = true;
            this.logger.warn('Doubao Work oversized log line skipped');
          }
          cursor.offset += from;
          const after = await handle.stat();
          if (fileIdentity(after) !== identity || after.size < cursor.offset) { drained = false; continue; }
          cursor.anchor = await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator(), this.budget, true);
          if (cursor.offset < stat.size) drained = false;
          if (from > 0 && this.budget.exhausted && cursor.offset < stat.size) moreLogWork = true;
          events.push(...fileEvents);
          this.getInputRuntimeAccumulator()?.observeCommittedBatch({
            bytes: from, records, parseSuccessRecords: parsed, parseFailedRecords: 0, maxRecordBytes: maxLineBytes,
          });
        }
        if (!sameCursor(next.files[name], cursor)) next.files[name] = cursor;
      } catch (error) {
        if (error instanceof DoubaoWorkDeferred && error.reason === 'cycle_budget') {
          // Retry this exact file with a fresh budget. Advancing here could
          // repeatedly strand it at the end of every metadata time slice.
          this.defer(error); moreLogWork = true; break;
        }
        drained = false;
        // Failed stat/read is not deletion. Do not mutate this file's committed cursor.
        if (!this.defer(error)) this.logger.warn('Doubao Work log read unavailable; preserving file checkpoint');
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    if (!finalizationCycle) {
      if (sweep.index < sweep.names.length) {
        sweep.drained = drained; drained = false; moreLogWork = true;
      } else {
        // New rotations join the next sweep before any request is finalized.
        drained &&= names.length === sweep.names.length && names.every((name, index) => name === sweep.names[index]);
        this.logSweep = undefined;
      }
    }
    if (moreLogWork) this.defer(new DoubaoWorkDeferred('source_backlog'));
    events.sort((a, b) => BigInt(a.timeNano) < BigInt(b.timeNano) ? -1 : BigInt(a.timeNano) > BigInt(b.timeNano) ? 1 : 0);
    for (const event of events) this.consume(next, event);
    // Consume the whole source window first, including rotated/out-of-order tool
    // records. A partial scan must not finalize requests ahead of unread tools.
    if (drained) {
      if ([...this.reconstructionJobs.keys()].some(key => key.startsWith('execution:'))) await this.completeNativeExecutions(next, entries);
      const pending = Object.entries(next.pending);
      const after = pending.findIndex(([key]) => key === next.pendingScanCursor);
      const rotated = after < 0 ? pending : [...pending.slice(after + 1), ...pending.slice(0, after + 1)];
      const ordered = [...rotated.filter(([key]) => this.reconstructionJobs.has(`request:${key}`)),
        ...rotated.filter(([key]) => !this.reconstructionJobs.has(`request:${key}`))];
      let attempts = 0;
      for (const [key, pending] of ordered) {
        if (this.budget.exhausted) { this.defer(new DoubaoWorkDeferred('cycle_budget')); break; }
        if (!pending.startObserved || !pending.terminal) continue;
        if (attempts++ >= 4) break;
        // Invalid terminal metadata or a temporarily unavailable trajectory
        // must not repeatedly occupy every completion slot after restart.
        next.pendingScanCursor = key;
        await this.complete(next, key, pending, entries);
      }
      if (!this.budget.exhausted && performance.now() >= this.nextNativeScanAt) {
        this.nextNativeScanAt = performance.now() + this.nativeScanIntervalMs;
        await this.completeNative(next, entries);
        await this.completeNativeExecutions(next, entries);
        if (this.nativeDeferred) this.nextNativeScanAt = 0;
      }
    }
    // A full source window can itself consume the cycle. Give its completion
    // work a fresh budget next cycle rather than re-statting the same 128 files
    // first forever. Source cursors and pending evidence are already durable;
    // this scheduling state is memory-only and reconstructed after restart.
    if (drained && this.budget.exhausted) this.finalizeLogWindow = names;
    // Confirmed absence or the explicit capacity window may evict a cursor;
    // transient stat/read errors for selected files still preserve their state.
    const selected = new Set(names);
    for (const name of Object.keys(next.files)) if (!selected.has(name)) delete next.files[name];
    if (events.length || entries.length || Date.now() >= this.nextCompactionAt) {
      this.nextCompactionAt = Date.now() + 60_000;
      const dropped = compact(next.pending, MAX_PENDING, PENDING_TTL_MS, item => item.updatedMs);
      if (dropped) this.logger.warn('Doubao Work incomplete requests expired or exceeded capacity; no trace inferred', { requests: dropped });
      compact(next.completed, MAX_COMPLETED, COMPLETED_TTL_MS, item => item);
      const droppedTools = compact(next.tools!, MAX_TOOLS, PENDING_TTL_MS, item => item.updatedMs);
      if (droppedTools) this.logger.warn('Doubao Work unmatched local tools expired or exceeded capacity', { tools: droppedTools });
      compact(next.roots, MAX_PENDING, PENDING_TTL_MS, item => item.updatedMs);
      compact(next.sandboxes, MAX_PENDING, PENDING_TTL_MS, item => item.updatedMs);
      compact(next.nativeCompleted, MAX_COMPLETED, COMPLETED_TTL_MS, item => item);
      compact(next.executionsCompleted, MAX_COMPLETED, COMPLETED_TTL_MS, item => item.updatedMs);
      compact(next.executionFirstSeen, MAX_COMPLETED, PENDING_TTL_MS, item => item);
      compact(next.nativeMutationActors, MAX_TOOLS, PENDING_TTL_MS, item => item.updatedMs);
    }
    const committed = draft.finish();
    if (committed !== saved) this.setState({ extra: { doubaoWork: committed } });
    this.normalizedCheckpoint = true;
    if (committed !== saved || this.nativeDeferred || Date.now() >= this.nextCacheDiagnosticsAt) {
      this.nextCacheDiagnosticsAt = Date.now() + 60_000;
      this.logger.debug('Doubao Work native cache statistics', { ...this.nativeReader.stats() });
    }
    return entries;
  }

  private consume(
    state: Checkpoint, event: DoubaoLogEvent,
  ): void {
    if (event.firstOutput) {
      // Native task UUID is the join key. Ambiguous/replayed tasks are never
      // joined by time proximity, directory order, answer text or polling time.
      const matches = Object.values(state.pending).filter(p => p.turnId === event.turnId && p.startObserved
        && p.queryMs >= state.sinceMs && BigInt(p.queryMs) * 1_000_000n <= BigInt(event.timeNano));
      if (matches.length !== 1) return;
      const pending = matches[0];
      if (pending.firstOutput && JSON.stringify(pending.firstOutput.firstOutput) !== JSON.stringify(event.firstOutput)) pending.firstOutputConflict = true;
      pending.firstOutput ??= event;
      return;
    }
    if (event.command) {
      if (BigInt(event.timeNano) < BigInt(state.sinceMs) * 1_000_000n) return;
      const box = state.sandboxes![event.command.sandboxId] ?? { actors: [], updatedMs: Date.now() };
      if (!box.actors.includes(event.command.agentId)) {
        if (box.actors.length >= 64) box.conflict = true;
        else box.actors.push(event.command.agentId);
      }
      box.updatedMs = Date.now();
      state.sandboxes![event.command.sandboxId] = box;
      return;
    }
    if (event.tool) {
      if (BigInt(event.timeNano) < BigInt(state.sinceMs) * 1_000_000n) return;
      const key = JSON.stringify([event.tool.sandboxId, event.tool.id]);
      const tool = state.tools![key] ?? { updatedMs: Date.now() };
      const side = event.tool.phase === 'received' ? 'start' : 'end';
      const prior = tool[side];
      if (prior && (prior.turnId !== event.turnId || prior.tool?.name !== event.tool.name || prior.tool?.status !== event.tool.status)) tool.conflict = true;
      // Re-delivery does not move the original observed boundary.
      tool[side] ??= event;
      tool.updatedMs = Date.now();
      state.tools![key] = tool;
      const start = tool.start, end = tool.end;
      if (start?.turnId && start.tool && end?.tool) {
        const actorKey = JSON.stringify([start.tool.sandboxId, start.turnId]);
        if (tool.conflict && state.nativeMutationActors![actorKey]?.callId === start.tool.id) delete state.nativeMutationActors![actorKey];
        if (!tool.conflict && /^[os]_[a-zA-Z0-9]+$/.test(start.turnId)
          && ['Write', 'Edit'].includes(start.tool.name) && start.tool.name === end.tool.name
          && start.tool.id === end.tool.id && start.tool.sandboxId === end.tool.sandboxId
          && start.tool.phase === 'received' && end.tool.phase === 'settled' && end.tool.status === 'success'
          && BigInt(end.timeNano) > BigInt(start.timeNano)) {
          // The native writer persists mutation-bearing executions only when
          // they release. Retain this content-free witness after tool emission
          // so child snapshots can wait for a long-running real parent.
          state.nativeMutationActors![actorKey] = { callId: start.tool.id, timeNano: end.timeNano, updatedMs: Date.now() };
        }
      }
      return;
    }
    if (event.name === 'general_agent_message_id_mapping') {
      if (!event.localMessageId || !event.conversationId) return;
      for (const pending of Object.values(state.pending)) {
        if (pending.localMessageId !== event.localMessageId) continue;
        pending.conversationId = event.conversationId;
      }
      return;
    }
    if (!event.turnId || event.queryMs === undefined || event.queryMs < Math.max(state.sinceMs, Date.now() - COMPLETED_TTL_MS)) return;
    const key = `${event.turnId}:${event.queryMs}`;
    if (state.completed[key] !== undefined) return;
    let pending = state.pending[key];
    if (event.name === 'on_message_session_end') {
      pending = state.pending[key] = {
        ...pending, turnId: event.turnId, queryMs: event.queryMs,
        startObserved: pending?.startObserved ?? false,
        terminal: event, updatedMs: Date.now(),
      };
    } else {
      pending = state.pending[key] = {
        ...pending,
        turnId: event.turnId, queryMs: event.queryMs,
        conversationId: event.conversationId ?? pending?.conversationId,
        localMessageId: event.localMessageId ?? pending?.localMessageId,
        startObserved: pending?.startObserved === true || event.name === 'on_message_session_start' || event.name === 'on_message_sending_start',
        updatedMs: Date.now(),
      };
    }
    if (event.selectedSkills !== undefined) pending.selectedSkills = event.selectedSkills;
    if (event.selectedPartners !== undefined) pending.selectedPartners = event.selectedPartners;
  }

  private async complete(state: Checkpoint, key: string, pending: PendingTurn, entries: AgentActivityEntry[]): Promise<void> {
    if (pending.startObserved && pending.terminal) {
      const matched = Object.entries(state.tools ?? {}).filter(([, tool]) => tool.start?.turnId === pending.turnId);
      const pairs = matched.flatMap(([, tool]) => !tool.conflict && tool.start && tool.end ? [{ start: tool.start, end: tool.end }] : []);
      let complete = buildDoubaoTaskEvents(this.scope, pending, pending.terminal, Date.now(), pairs);
      if (complete.length === 0) return;
      const conversationId = pending.terminal.conversationId ?? pending.conversationId;
      if (conversationId) {
        try {
          const graph = await this.readConversationGraph(conversationId, true, `request:${key}`);
          if (graph) {
            complete = enrichNativeToolEvents(complete.map(event => ({ ...event, 'gen_ai.agent.id': graph.main })), graph.content);
            const io = nativeTaskContent(graph.content, graph.main, pending.queryMs, pending.terminal.timeNano,
              pairs.map(pair => pair.start.tool!.id));
            // The client may persist its final trajectory row shortly after
            // the real terminal log. Wait only in the telemetry pipeline,
            // preserving the original source boundary and a bounded fallback.
            if (io.input !== undefined && io.output === undefined && Date.now() - pending.updatedMs < 2_000) return;
            if (io.input !== undefined) complete[0]['gen_ai.input.messages_delta'] = [{ role: 'user', parts: [{ type: 'text', content: io.input }] }];
            if (io.output !== undefined) complete[complete.length - 1]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: io.output }] }];
            const reconstruction = await this.reconstruct(`request:${key}`, conversationId, graph.content, graph.main, pending.queryMs,
              pending.terminal.timeNano, pairs.map(pair => pair.start.tool!.id), 'client_request', graph);
            if (reconstruction) complete[0]['agent.doubao_work.assistant_rounds'] = reconstruction as unknown as JsonValue;
          }
        } catch (error) {
          if (this.defer(error)) return;
          this.logger.warn('Doubao Work native content unavailable; emitting only confirmed request metadata');
        }
      }
      const omitted = matched.length - complete.filter(entry => entry['event.name'] === 'tool.call').length;
      if (omitted) this.logger.warn('Doubao Work local tools lack a complete unambiguous in-request boundary; omitted', { tools: omitted });
      entries.push(...complete);
      // Keep the actual root boundary for late child observations. The sandbox
      // producer supplies request identity; native graph files supply ancestry.
      const priorRoot = state.roots![pending.turnId];
      if (!priorRoot || priorRoot.queryMs === pending.queryMs) state.roots![pending.turnId] = {
        ...pending, conversationId: pending.terminal.conversationId ?? pending.conversationId, terminal: pending.terminal,
      };
      delete state.pending[key];
      state.completed[key] = Date.now();
      const exportedCalls = new Set(complete.filter(event => event['event.name'] === 'tool.call').map(event => event['gen_ai.tool.call.id']));
      for (const [toolKey, tool] of matched) if (tool.start?.tool && exportedCalls.has(tool.start.tool.id)) delete state.tools![toolKey];
    }
  }

  private async completeNative(state: Checkpoint, entries: AgentActivityEntry[]): Promise<void> {
    if (!this.sessionsRoot && !this.userDataRoot) return;
    let scannedConversation: string | undefined;
    let graph: NativeGraph | undefined;
    let considered = 0;
    const pendingTools = Object.entries(state.tools ?? {});
    const after = pendingTools.findIndex(([key]) => key === state.nativeScanCursor);
    const ordered = after < 0 ? pendingTools : [...pendingTools.slice(after + 1), ...pendingTools.slice(0, after + 1)];
    for (const [key, tool] of ordered) {
      if (this.budget.exhausted) { this.defer(new DoubaoWorkDeferred('cycle_budget')); break; }
      if (++considered > MAX_TOOLS) break;
      if (state.nativeCompleted![key] !== undefined) continue;
      if (tool.conflict || !tool.start?.tool || !tool.end?.tool || !tool.start.turnId) continue;
      const sandbox = state.sandboxes![tool.start.tool.sandboxId];
      if (!sandbox || sandbox.conflict || !sandbox.actors.includes(tool.start.turnId)) continue;
      const rootActors = sandbox.actors.filter(actor => !/^[mos]_[a-zA-Z0-9]+$/.test(actor));
      if (rootActors.length !== 1) continue;
      const root = state.roots![rootActors[0]];
      if (!root || !root.conversationId || root.turnId === tool.start.turnId) continue;
      // At most one bounded native conversation scan per collection cycle.
      if (scannedConversation && scannedConversation !== root.conversationId) continue;
      if (!scannedConversation) {
        scannedConversation = root.conversationId;
        state.nativeScanCursor = key;
        try { graph = await this.readConversationGraph(root.conversationId, true, undefined, true); }
        catch (error) { if (!this.defer(error)) this.logger.warn('Doubao Work native graph temporarily unavailable; preserving child tools'); }
      }
      if (!graph) continue;
      const visited = new Set<string>();
      let actor = tool.start.turnId;
      while (actor !== graph.main && graph.edges[actor] && sandbox.actors.includes(actor) && !visited.has(actor)) {
        visited.add(actor); actor = graph.edges[actor].parent;
      }
      if (actor !== graph.main) continue;
      const fragment = buildNativeToolEvents(this.scope, root, graph, { start: tool.start, end: tool.end }, Date.now());
      if (!fragment.length) continue;
      const observations = enrichNativeToolEvents(fragment.filter(entry => entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result')
        .map(entry => ({ ...entry, 'loongsuite.doubao_work.root_turn_id': root.turnId,
          'loongsuite.doubao_work.trace_role': 'log_only' })), graph.content);
      for (const event of observations) {
        delete event.parent_span_id;
      }
      entries.push(...observations);
      state.nativeCompleted![key] = Date.now();
    }
  }

  private async completeNativeExecutions(state: Checkpoint, entries: AgentActivityEntry[]): Promise<void> {
    if ((!this.sessionsRoot && !this.userDataRoot) || !this.snapshotRoot) return;
    const roots = Object.values(state.roots ?? {}).filter(root => root.conversationId && root.localMessageId);
    const conversations = [...new Set(roots.map(root => root.conversationId!))].sort();
    if (!conversations.length) return;
    const after = conversations.indexOf(this.executionScanCursor ?? state.executionScanCursor ?? '');
    const resumed = [...this.reconstructionJobs].find(([key, job]) => key.startsWith('execution:') && conversations.includes(job.conversation));
    const conversationId = resumed?.[1].conversation ?? conversations[(after + 1) % conversations.length];
    // Scheduling alone is not source progress. Keep idle rotation in memory;
    // persist it together with actual execution/wait changes below.
    this.executionScanCursor = conversationId;
    let executions, graph;
    try {
      // One conversation per cycle, with independent byte/file limits on each
      // native source. No cursor, mtime or polling time becomes a span boundary.
      executions = resumed?.[1].executions ?? await this.nativeReader.executions(conversationId, this.budget);
      if (!executions.length) return;
      for (const execution of executions) {
        const prior = state.executionsCompleted![execution.executionKey];
        if (prior && prior.digest !== this.executionDigest(execution)) this.logger.warn('Doubao Work completed native execution changed; not exporting a conflicting span');
      }
      const unfinished = executions.some(execution => execution.agentType !== 'main_agent' && execution.startedAtMs >= state.sinceMs
        && !state.executionsCompleted![execution.executionKey]);
      if (!unfinished) return;
      // A newly released execution may have persisted its trajectory after
      // an earlier root read in this same cycle. Revalidate stamps, reusing
      // decoded rows when unchanged and parsing only a newly appended tail.
      graph = resumed?.[1].graph ?? await this.readConversationGraph(conversationId, true, undefined, true);
    } catch (error) {
      if (!this.defer(error) && (error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('Doubao Work native execution metadata unavailable; preserving checkpoint');
      return;
    }
    if (!graph) return;
    for (const execution of executions) {
      if (resumed && resumed[0] !== `execution:${execution.executionKey}`) continue;
      if (this.budget.exhausted) { this.defer(new DoubaoWorkDeferred('cycle_budget')); break; }
      if (execution.startedAtMs < state.sinceMs) continue;
      const matched = roots.filter(root => root.conversationId === execution.conversationId && root.localMessageId === execution.queryMessageId);
      if (matched.length !== 1) continue;
      const root = matched[0], box = state.sandboxes?.[execution.sandboxId];
      // Independent native actors and the root request must agree on the same
      // sandbox. Never correlate by wall-clock proximity or directory mtime.
      if (!box || box.conflict || !box.actors.includes(root.turnId) || !box.actors.includes(execution.agentId)
        || box.actors.filter(actor => !/^[mos]_[a-zA-Z0-9]+$/.test(actor)).length !== 1) continue;
      const digest = this.executionDigest(execution), prior = state.executionsCompleted![execution.executionKey];
      if (prior) continue;
      const eligible = executions.filter(candidate => candidate.startedAtMs >= state.sinceMs && box.actors.includes(candidate.agentId));
      const pairs = Object.entries(state.tools ?? {}).filter(([, tool]) => !tool.conflict && tool.start?.turnId === execution.agentId
        && tool.start.tool?.sandboxId === execution.sandboxId && tool.end?.tool
        && BigInt(tool.start.timeNano) >= BigInt(execution.startedAtMs) * 1_000_000n
        && BigInt(tool.end.timeNano) <= BigInt(execution.endedAtMs) * 1_000_000n
        // Reconnects can produce overlapping resource lifetimes for one actor.
        // A tool must have exactly one native owner, not be copied into both.
        && isUniqueNativeToolOwner(execution, eligible, tool.start!.timeNano, tool.end!.timeNano));
      const events = buildNativeExecutionEvents(this.scope, root, graph, execution, eligible, Date.now());
      if (!events.length) continue;
      const firstSeen = state.executionFirstSeen![execution.executionKey] ??= Date.now();
      state.executionScanCursor = conversationId;
      const parentId = graph.edges[execution.agentId]?.parent;
      const background = BigInt(execution.endedAtMs) * 1_000_000n > BigInt(root.terminal.timeNano);
      if (!background && parentId !== graph.main && events[0]['loongsuite.doubao_work.parent_resolution'] === 'root_request_ancestor') {
        const hasParentRecord = eligible.some(candidate => candidate.agentId === parentId && candidate.queryMessageId === execution.queryMessageId
          && candidate.conversationId === execution.conversationId && candidate.sandboxId === execution.sandboxId);
        const parentMutation = state.nativeMutationActors![JSON.stringify([execution.sandboxId, parentId])];
        const currentWrite = typeof parentMutation?.timeNano === 'string' && /^\d{19}$/.test(parentMutation.timeNano)
          && BigInt(parentMutation.timeNano) >= BigInt(root.queryMs) * 1_000_000n
          && BigInt(parentMutation.timeNano) <= BigInt(root.terminal.timeNano);
        const grace = !hasParentRecord && currentWrite ? EXECUTION_PARENT_WRITE_GRACE_MS : EXECUTION_PARENT_GRACE_MS;
        if (Date.now() - firstSeen < grace) continue;
      }
      const observations = nativeToolObservations(pairs.map(([, tool]) => ({ start: tool.start!, end: tool.end! })), graph.content);
      const io = nativeTaskContent(graph.content, execution.agentId, root.queryMs,
        (BigInt(execution.endedAtMs) * 1_000_000n).toString(), pairs.map(([, tool]) => tool.start!.tool!.id));
      for (const event of events) {
        delete event['gen_ai.turn.id'];
        delete event['gen_ai.agent.scope'];
      }
      events[0]['agent.doubao_work.tool_observations'] = observations;
      let reconstruction;
      try {
        reconstruction = await this.reconstruct(`execution:${execution.executionKey}`, conversationId, graph.content, execution.agentId, root.queryMs,
          (BigInt(execution.endedAtMs) * 1_000_000n).toString(), pairs.map(([, tool]) => tool.start!.tool!.id), 'local_execution_fragment', graph, executions);
      } catch (error) { if (this.defer(error)) break; throw error; }
      if (reconstruction) events[0]['agent.doubao_work.assistant_rounds'] = reconstruction as unknown as JsonValue;
      if (io.input !== undefined) events[0]['agent.doubao_work.task_input'] = io.input;
      if (io.output !== undefined) events[0]['agent.doubao_work.task_output'] = io.output;
      if (io.input !== undefined) events[0]['gen_ai.input.messages_delta'] = [{ role: 'user', parts: [{ type: 'text', content: io.input }] }];
      if (io.output !== undefined) events[1]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: io.output }] }];
      entries.push(...events);
      for (const [toolKey] of pairs) delete state.tools![toolKey];
      state.executionsCompleted![execution.executionKey] = { digest, updatedMs: Date.now() };
      delete state.executionFirstSeen![execution.executionKey];
    }
  }

  private readConversationGraph(conversationId: string, _captureContent = false, jobKey?: string, revalidate = false): Promise<NativeGraph | undefined> {
    const resumed = jobKey && this.reconstructionJobs.get(jobKey);
    if (resumed) return Promise.resolve(resumed.graph);
    let graph = revalidate ? undefined : this.cycleGraphs.get(conversationId);
    if (!graph) { graph = this.nativeReader.graph(conversationId, this.budget); this.cycleGraphs.set(conversationId, graph); }
    return graph;
  }

  private executionDigest(execution: NativeExecution): string {
    let digest = this.executionDigests.get(execution);
    if (!digest) { digest = doubaoDigest(JSON.stringify(execution)); this.executionDigests.set(execution, digest); }
    return digest;
  }

  private async reconstruct(key: string, conversation: string, content: NativeContent | undefined, actor: string,
    queryMs: number, endNano: string, callIds: string[], scope: NativeAssistantRound['scope'], graph: NativeGraph, executions?: NativeExecution[]): Promise<NativeRoundReconstruction | undefined> {
    if (!content) { this.reconstructionJobs.delete(key); return undefined; }
    const version = JSON.stringify([content.sourceVersions?.[actor], actor, queryMs, endNano, callIds, scope]);
    let job = this.reconstructionJobs.get(key);
    if (job && job.version !== version) { this.reconstructionJobs.delete(key); throw new DoubaoWorkDeferred('source_refresh'); }
    if (!job) {
      const assignments = content.assignments[actor] ?? [];
      const bytes = (content.sourceBytes?.[actor] ?? 0) + assignments.reduce((n, value) => n + Buffer.byteLength(value.text) * 2, 0) + 512 * 1024;
      if (bytes > 32 * 1024 * 1024) { this.logger.warn('Doubao Work reconstruction content exceeds bounded cache', { reason: 'round_cache_capacity' }); return undefined; }
      if (this.reconstructionJobs.size >= 4 || [...this.reconstructionJobs.values()].reduce((n, value) => n + value.bytes, bytes) > 32 * 1024 * 1024) throw new DoubaoWorkDeferred('round_queue');
      const scoped: NativeContent = { calls: Object.fromEntries(Object.entries(content.calls).filter(([, value]) => value.actor === actor).map(([id, value]) => [id, { ...value }])),
        assignments: { [actor]: assignments }, lastAnswers: { [actor]: content.lastAnswers[actor] }, transcripts: { [actor]: content.transcripts?.[actor] ?? [] },
        transcriptOffsets: { [actor]: content.transcriptOffsets?.[actor] ?? 0 },
        ...(content.sourceVersions?.[actor] === undefined ? {} : { sourceVersions: { [actor]: content.sourceVersions[actor] } }),
        sourceBytes: { [actor]: content.sourceBytes?.[actor] ?? 0 } };
      const current = assignments.filter(value => value.timeMs >= queryMs && value.timeMs <= Number(BigInt(endNano) / 1_000_000n));
      if (content.findUserRows && current.length === 1) {
        const fingerprint = nativeDemandFingerprint(current[0].text), indices = content.findUserRows(actor, fingerprint);
        scoped.findUserRows = (who, key) => who === actor && key === fingerprint ? indices : undefined;
      }
      job = { version, conversation, bytes, updatedMs: Date.now(), steps: nativeRoundSteps(scoped, actor, queryMs, endNano, callIds, scope),
        graph: { main: graph.main, edges: { ...graph.edges }, content: scoped }, executions: executions?.map(value => ({ ...value })) };
      this.reconstructionJobs.set(key, job);
    }
    job.updatedMs = Date.now();
    while (!this.budget.exhausted) {
      const next = job.steps.next();
      if (next.done) { this.reconstructionJobs.delete(key); return next.value; }
      this.budget.record(next.value); await this.budget.yieldIfNeeded();
    }
    throw new DoubaoWorkDeferred('cycle_budget');
  }

  private defer(error: unknown): boolean {
    if (!(error instanceof DoubaoWorkDeferred)) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!code || !['EACCES', 'EPERM', 'EIO', 'EBUSY', 'ESTALE', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)) return false;
      if (!this.reportedIoErrors.has(code)) {
        this.reportedIoErrors.add(code);
        this.logger.warn('Doubao Work source I/O unavailable; preserving pending work', { code, reason: 'native_io_retry' });
      }
      error = new DoubaoWorkDeferred('native_io_retry');
    }
    const deferred = error as DoubaoWorkDeferred;
    this.nativeDeferred = true;
    this.logger.debug('Doubao Work telemetry work deferred', { reason: deferred.reason });
    if (['cycle_budget', 'round_queue', 'source_refresh', 'source_backlog'].includes(deferred.reason) && !this.wakeup) {
      this.wakeup = setTimeout(() => { this.wakeup = undefined; this.requestCollection(); }, 1000);
      this.wakeup.unref();
    }
    return true;
  }
}

function fileIdentity(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}`; }

function sameCursor(a: FileCursor | undefined, b: FileCursor): boolean {
  return a?.identity === b.identity && a.offset === b.offset && a.anchor === b.anchor && a.skippingLine === b.skippingLine;
}

async function boundaryAnchor(
  handle: Awaited<ReturnType<typeof fs.open>>, offset: number, runtime: InputRuntimeAccumulator | null, budget?: DoubaoWorkBudget, finishing = false,
): Promise<string> {
  const length = Math.min(64, offset);
  if (!length) return doubaoDigest('');
  const buffer = Buffer.alloc(length);
  const started = performance.now();
  const bytesRead = budget ? await budget.read(handle, buffer, length, offset - length, finishing)
    : (await handle.read(buffer, 0, length, offset - length)).bytesRead;
  if (!budget) runtime?.observeRead(bytesRead, length, performance.now() - started);
  if (bytesRead !== length) throw new Error('Doubao Work cursor boundary changed during read');
  return doubaoDigest(buffer.toString('hex'));
}

function compact<T>(items: Record<string, T>, max: number, ttl: number, time: (value: T) => number): number {
  const before = Object.keys(items).length;
  const cutoff = Date.now() - ttl;
  for (const [key, value] of Object.entries(items)) if (time(value) < cutoff) delete items[key];
  const keys = Object.keys(items);
  if (keys.length > max) {
    const oldest = keys.sort((a, b) => time(items[a]) - time(items[b]));
    for (const key of oldest.slice(0, oldest.length - max)) delete items[key];
  }
  return before - Object.keys(items).length;
}
