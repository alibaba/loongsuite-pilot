import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import { ClientType, CollectionMethod, type AgentActivityEntry, type JsonValue } from '../../types/index.js';
import { buildDoubaoTaskEvents, doubaoDigest, isDoubaoPresentationInspection, parseDoubaoLogLine, type DoubaoPendingTurn, type DoubaoLogEvent } from './doubao-work-log.js';
import { buildNativeToolEvents, readNativeGraph, readNativeProfileGraph } from './doubao-work-native.js';
import { buildNativeExecutionEvents, isUniqueNativeToolOwner, readNativeExecutions } from './doubao-work-execution.js';
import { enrichNativeToolEvents, nativeTaskContent, nativeToolObservations } from './doubao-work-content.js';
import { reconstructNativeRounds } from './doubao-work-rounds.js';

const FILE_PATTERN = /^saman(?:_frontend)?_\d{4}\.\d{4}\.\d+\.log$/;
const MAX_FILES = 128;
const READ_BYTES = 1024 * 1024;
const CYCLE_BYTES = 8 * READ_BYTES;
const MAX_PENDING = 512;
const MAX_COMPLETED = 4096;
const MAX_TOOLS = 4096;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TTL_MS = 7 * PENDING_TTL_MS;
const EXECUTION_PARENT_GRACE_MS = 30_000;

interface FileCursor { identity: string; offset: number; anchor?: string; skippingLine?: boolean }
interface PendingTurn extends DoubaoPendingTurn { startObserved: boolean; terminal?: DoubaoLogEvent }
interface PendingTool { start?: DoubaoLogEvent; end?: DoubaoLogEvent; conflict?: boolean; updatedMs: number }
interface Checkpoint {
  schema: 1;
  sinceMs: number;
  files: Record<string, FileCursor>;
  pending: Record<string, PendingTurn>;
  completed: Record<string, number>;
  tools?: Record<string, PendingTool>;
  roots?: Record<string, PendingTurn & { terminal: DoubaoLogEvent }>;
  sandboxes?: Record<string, { actors: string[]; conflict?: boolean; updatedMs: number }>;
  nativeCompleted?: Record<string, number>;
  nativeScanCursor?: string;
  executionsCompleted?: Record<string, { digest: string; updatedMs: number }>;
  executionScanCursor?: string;
  executionFirstSeen?: Record<string, number>;
  nativeMutationActors?: Record<string, { callId: string; updatedMs: number }>;
}

export interface DoubaoWorkInputOptions extends InputOptions {
  logDir?: string; sessionsRoot?: string; snapshotRoot?: string;
  /** Native metadata has no watcher. Limit scans independently of log wakeups. */
  nativeScanIntervalMs?: number;
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

  constructor(opts: DoubaoWorkInputOptions) {
    super(opts);
    this.logDir = opts.logDir ? path.resolve(opts.logDir) : DoubaoWorkInput.defaultLogDir();
    this.scope = doubaoDigest(this.logDir ?? 'unsupported-platform');
    this.sessionsRoot = opts.sessionsRoot;
    this.userDataRoot = this.logDir ? path.resolve(this.logDir, '../..') : undefined;
    this.snapshotRoot = opts.snapshotRoot ?? (this.logDir ? path.resolve(this.logDir, '../../coding/snapshot') : undefined);
    this.nativeScanIntervalMs = Math.max(0, opts.nativeScanIntervalMs ?? 10_000);
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
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    if (!this.logDir) return [];
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
      const initial: Checkpoint = { schema: 1, sinceMs: Date.now(), files: {}, pending: {}, completed: {} };
      for (const name of names) {
        try {
          const stat = await fs.stat(path.join(this.logDir, name));
          // Fingerprint the cursor boundary to detect in-place truncate-and-regrow.
          const handle = await fs.open(path.join(this.logDir, name), 'r');
          try {
            initial.files[name] = { identity: fileIdentity(stat), offset: stat.size, anchor: await boundaryAnchor(handle, stat.size, this.getInputRuntimeAccumulator()) };
          } finally { await handle.close(); }
        } catch { return []; } // Do not commit an incomplete initial baseline.
      }
      this.setState({ extra: { doubaoWork: initial } });
      return [];
    }
    const next: Checkpoint = JSON.parse(JSON.stringify(saved));
    next.tools ??= {};
    // An older collector may have checkpointed this helper before upgrade.
    // Apply the same source distinction to restored receipt/settlement facts.
    for (const [key, pair] of Object.entries(next.tools)) {
      if ([pair.start?.tool, pair.end?.tool].some(tool => tool && isDoubaoPresentationInspection(tool.name, tool.id))) delete next.tools[key];
    }
    next.roots ??= {};
    next.sandboxes ??= {};
    next.nativeCompleted ??= {};
    next.executionsCompleted ??= {};
    next.executionFirstSeen ??= {};
    next.nativeMutationActors ??= {};
    const entries: AgentActivityEntry[] = [];
    const events: DoubaoLogEvent[] = [];
    let remainingBytes = CYCLE_BYTES;
    let drained = true;
    for (const name of names) {
      if (remainingBytes <= 0) { drained = false; break; }
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(path.join(this.logDir, name), 'r');
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const identity = fileIdentity(stat);
        const prior = next.files[name] ?? Object.values(next.files).find(cursor => cursor.identity === identity);
        const cursor: FileCursor = prior?.identity === identity && prior.offset <= stat.size
          ? { ...prior } : { identity, offset: 0 };
        if (cursor.anchor && cursor.anchor !== await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator())) {
          cursor.offset = 0;
          cursor.skippingLine = false;
        }
        const unread = stat.size - cursor.offset;
        this.getInputRuntimeAccumulator()?.observeBacklog(unread);
        if (unread > 0) {
          const requested = Math.min(READ_BYTES, remainingBytes, unread);
          const buffer = Buffer.allocUnsafe(requested);
          const started = performance.now();
          const { bytesRead } = await handle.read(buffer, 0, requested, cursor.offset);
          this.getInputRuntimeAccumulator()?.observeRead(bytesRead, requested, performance.now() - started);
          remainingBytes -= bytesRead;
          if (bytesRead < unread) drained = false;
          const chunk = buffer.subarray(0, bytesRead);
          let from = 0;
          let records = 0;
          let parsed = 0;
          const fileEvents: DoubaoLogEvent[] = [];
          let maxLineBytes = 0;
          while (from < chunk.length) {
            const newline = chunk.indexOf(10, from);
            if (newline < 0) break; // A normal trailing half-line keeps its old offset.
            const end = newline + 1;
            records++;
            maxLineBytes = Math.max(maxLineBytes, end - from);
            if (!cursor.skippingLine) {
              const event = parseDoubaoLogLine(chunk.subarray(from, newline).toString('utf8'), name);
              if (event) {
                parsed++;
                fileEvents.push(event);
              }
            }
            cursor.skippingLine = false;
            from = end;
          }
          // An oversized line is skipped through its newline without unbounded buffering.
          if (from === 0 && bytesRead === READ_BYTES) {
            from = bytesRead;
            cursor.skippingLine = true;
            this.logger.warn('Doubao Work oversized log line skipped');
          }
          cursor.offset += from;
          const after = await handle.stat();
          if (fileIdentity(after) !== identity || after.size < cursor.offset) { drained = false; continue; }
          cursor.anchor = await boundaryAnchor(handle, cursor.offset, this.getInputRuntimeAccumulator());
          events.push(...fileEvents);
          this.getInputRuntimeAccumulator()?.observeCommittedBatch({
            bytes: from, records, parseSuccessRecords: parsed, parseFailedRecords: 0, maxRecordBytes: maxLineBytes,
          });
        }
        next.files[name] = cursor;
      } catch {
        drained = false;
        // Failed stat/read is not deletion. Do not mutate this file's committed cursor.
        this.logger.warn('Doubao Work log read unavailable; preserving file checkpoint');
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    events.sort((a, b) => BigInt(a.timeNano) < BigInt(b.timeNano) ? -1 : BigInt(a.timeNano) > BigInt(b.timeNano) ? 1 : 0);
    for (const event of events) this.consume(next, event);
    // Consume the whole source window first, including rotated/out-of-order tool
    // records. A partial scan must not finalize requests ahead of unread tools.
    if (drained) {
      let completed = 0;
      for (const [key, pending] of Object.entries(next.pending)) {
        if (completed++ >= 4) break;
        await this.complete(next, key, pending, entries);
      }
      if (performance.now() >= this.nextNativeScanAt) {
        this.nextNativeScanAt = performance.now() + this.nativeScanIntervalMs;
        await this.completeNative(next, entries);
        await this.completeNativeExecutions(next, entries);
      }
    }
    // Confirmed absence or the explicit capacity window may evict a cursor;
    // transient stat/read errors for selected files still preserve their state.
    const selected = new Set(names);
    for (const name of Object.keys(next.files)) if (!selected.has(name)) delete next.files[name];
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
    this.setState({ extra: { doubaoWork: next } });
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
          state.nativeMutationActors![actorKey] = { callId: start.tool.id, updatedMs: Date.now() };
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
          const graph = await this.readConversationGraph(conversationId, true);
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
            const reconstruction = reconstructNativeRounds(graph.content, graph.main, pending.queryMs,
              pending.terminal.timeNano, pairs.map(pair => pair.start.tool!.id));
            if (reconstruction) complete[0]['agent.doubao_work.assistant_rounds'] = reconstruction as unknown as JsonValue;
          }
        } catch {
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
    let graph: Awaited<ReturnType<typeof readNativeGraph>>;
    let considered = 0;
    const pendingTools = Object.entries(state.tools ?? {});
    const after = pendingTools.findIndex(([key]) => key === state.nativeScanCursor);
    const ordered = after < 0 ? pendingTools : [...pendingTools.slice(after + 1), ...pendingTools.slice(0, after + 1)];
    for (const [key, tool] of ordered) {
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
        try { graph = await this.readConversationGraph(root.conversationId, true); }
        catch { this.logger.warn('Doubao Work native graph temporarily unavailable; preserving child tools'); }
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
    const after = conversations.indexOf(state.executionScanCursor ?? '');
    const conversationId = conversations[(after + 1) % conversations.length];
    state.executionScanCursor = conversationId;
    let executions, graph;
    try {
      // One conversation per cycle, with independent byte/file limits on each
      // native source. No cursor, mtime or polling time becomes a span boundary.
      executions = await readNativeExecutions(this.snapshotRoot, conversationId);
      if (!executions.length) return;
      graph = await this.readConversationGraph(conversationId, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('Doubao Work native execution metadata unavailable; preserving checkpoint');
      return;
    }
    if (!graph) return;
    for (const execution of executions) {
      if (execution.startedAtMs < state.sinceMs) continue;
      const matched = roots.filter(root => root.conversationId === execution.conversationId && root.localMessageId === execution.queryMessageId);
      if (matched.length !== 1) continue;
      const root = matched[0], box = state.sandboxes?.[execution.sandboxId];
      // Independent native actors and the root request must agree on the same
      // sandbox. Never correlate by wall-clock proximity or directory mtime.
      if (!box || box.conflict || !box.actors.includes(root.turnId) || !box.actors.includes(execution.agentId)
        || box.actors.filter(actor => !/^[mos]_[a-zA-Z0-9]+$/.test(actor)).length !== 1) continue;
      const digest = doubaoDigest(JSON.stringify(execution)), prior = state.executionsCompleted![execution.executionKey];
      if (prior) {
        if (prior.digest !== digest) this.logger.warn('Doubao Work completed native execution changed; not exporting a conflicting span');
        continue;
      }
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
      const observations = nativeToolObservations(pairs.map(([, tool]) => ({ start: tool.start!, end: tool.end! })), graph.content);
      const io = nativeTaskContent(graph.content, execution.agentId, root.queryMs,
        (BigInt(execution.endedAtMs) * 1_000_000n).toString(), pairs.map(([, tool]) => tool.start!.tool!.id));
      for (const event of events) {
        delete event['gen_ai.turn.id'];
        delete event['gen_ai.agent.scope'];
      }
      events[0]['agent.doubao_work.tool_observations'] = observations;
      const reconstruction = reconstructNativeRounds(graph.content, execution.agentId, root.queryMs,
        (BigInt(execution.endedAtMs) * 1_000_000n).toString(), pairs.map(([, tool]) => tool.start!.tool!.id), 'local_execution_fragment');
      if (reconstruction) events[0]['agent.doubao_work.assistant_rounds'] = reconstruction as unknown as JsonValue;
      if (io.input !== undefined) events[0]['agent.doubao_work.task_input'] = io.input;
      if (io.output !== undefined) events[0]['agent.doubao_work.task_output'] = io.output;
      if (io.input !== undefined) events[0]['gen_ai.input.messages_delta'] = [{ role: 'user', parts: [{ type: 'text', content: io.input }] }];
      if (io.output !== undefined) events[1]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: io.output }] }];
      const firstSeen = state.executionFirstSeen![execution.executionKey] ??= Date.now();
      const parentId = graph.edges[execution.agentId]?.parent;
      if (parentId !== graph.main && events[0]['loongsuite.doubao_work.parent_resolution'] === 'root_request_ancestor') {
        const hasParentRecord = eligible.some(candidate => candidate.agentId === parentId && candidate.queryMessageId === execution.queryMessageId
          && candidate.conversationId === execution.conversationId && candidate.sandboxId === execution.sandboxId);
        const parentMutation = state.nativeMutationActors![JSON.stringify([execution.sandboxId, parentId])];
        // A successful native Write/Edit means the parent may release much
        // later than its children. Wait within the existing 24h/4096 checkpoint
        // bounds, rather than committing an irreversible fallback at 30s.
        // Without such evidence the short grace still allows a late snapshot;
        // an existing but ambiguous/non-enclosing parent is never guessed.
        if ((!hasParentRecord && parentMutation) || Date.now() - firstSeen < EXECUTION_PARENT_GRACE_MS) continue;
      }
      entries.push(...events);
      for (const [toolKey] of pairs) delete state.tools![toolKey];
      state.executionsCompleted![execution.executionKey] = { digest, updatedMs: Date.now() };
      delete state.executionFirstSeen![execution.executionKey];
    }
  }

  private readConversationGraph(conversationId: string, captureContent = false): Promise<Awaited<ReturnType<typeof readNativeGraph>>> {
    return this.sessionsRoot
      ? readNativeGraph(this.sessionsRoot, conversationId, captureContent)
      : readNativeProfileGraph(this.userDataRoot!, conversationId, captureContent);
  }
}

function fileIdentity(stat: { dev: number; ino: number }): string { return `${stat.dev}:${stat.ino}`; }

async function boundaryAnchor(
  handle: Awaited<ReturnType<typeof fs.open>>, offset: number, runtime: InputRuntimeAccumulator | null,
): Promise<string> {
  const length = Math.min(64, offset);
  const buffer = Buffer.alloc(length);
  const started = performance.now();
  const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
  runtime?.observeRead(bytesRead, length, performance.now() - started);
  if (bytesRead !== length) throw new Error('Doubao Work cursor boundary changed during read');
  return doubaoDigest(buffer.toString('hex'));
}

function compact<T>(items: Record<string, T>, max: number, ttl: number, time: (value: T) => number): number {
  const before = Object.keys(items).length;
  const cutoff = Date.now() - ttl;
  for (const [key, value] of Object.entries(items)) if (time(value) < cutoff) delete items[key];
  const oldest = Object.keys(items).sort((a, b) => time(items[a]) - time(items[b]));
  for (const key of oldest.slice(0, Math.max(0, oldest.length - max))) delete items[key];
  return before - Object.keys(items).length;
}
