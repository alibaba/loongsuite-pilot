import * as fs from 'node:fs/promises';
import path from 'node:path';
import { appendNativeContentRow, independentNativeString, type NativeAssignment, type NativeContent } from './doubao-work-content.js';
import { appendNativeGraphRow, type NativeEdge, type NativeGraph } from './doubao-work-native.js';
import { parseNativeExecution, type NativeExecution } from './doubao-work-execution.js';
import { DoubaoWorkBudget, DoubaoWorkDeferred } from './doubao-work-budget.js';
import { nativeDemandFingerprint } from './doubao-work-rounds.js';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CHUNK = 64 * 1024;
const WINDOW = 2 * 1024 * 1024;
const MAX_CALLS = 4096;

interface Stamp { identity: string; size: number; mtime: string; ctime: string }
interface Row { index: number; bytes: number; value: Record<string, any>; demand?: string }
interface ActorState {
  rows: Row[]; head: number; rowCount: number; bytes: number;
  content: NativeContent; contentInvalid: boolean; graphInvalid: boolean;
  callCount: number; callBytes: number;
  creationCalls: Set<string>; edges: Record<string, NativeEdge>;
  userDemands: Map<string, { indices: number[]; head: number }>;
}
interface Source {
  kind: 'trajectory' | 'assignment' | 'snapshot'; conversation: string; actor: string;
  stamp: Stamp; offset: number; committed: number; buffer: Buffer; ready: boolean;
  first: Buffer; tail: Buffer; version: number; createdAt: number; lastSeen: number; lastActive: number;
  state?: ActorState; chunks?: Buffer[]; execution?: NativeExecution;
  assignments?: NativeAssignment[]; firstAssignment?: NativeAssignment;
  assignmentBytes?: number;
  firstAssignmentBytes?: number;
  currentAssignment?: { timeMs: number; chunks: string[]; bytes: number; overflow: boolean };
  parseFailure?: Error;
}
export interface NativeReaderOptions {
  sessionsRoot?: string; userDataRoot?: string; snapshotRoot?: string;
  maxCacheBytes?: number; maxFiles?: number; ttlMs?: number;
  diagnostic?: (reason: string) => void;
}
export interface NativeReaderStats {
  bodyReadBytes: number; parsedRows: number; cacheHits: number; resets: number;
  evictions: number; retainedBytes: number; files: number;
}

/** Raw native content is private, bounded memory, never checkpoint payload.
 * A restart rebuilds it cooperatively; durable log progress and deterministic
 * completion IDs still own recovery. Stat times only invalidate caches.
 */
export class DoubaoWorkNativeReader {
  private readonly files = new Map<string, Source>();
  private readonly graphs = new Map<string, { version: string; graph: NativeGraph | undefined }>();
  private active = new Set<string>();
  private sequence = 0;
  private readonly reported = new Set<string>();
  private readonly counters = { bodyReadBytes: 0, parsedRows: 0, cacheHits: 0, resets: 0, evictions: 0 };

  constructor(private readonly options: NativeReaderOptions) {}

  beginCycle(active: Set<string>): void {
    this.active = active;
    const cutoff = Date.now() - (this.options.ttlMs ?? 15 * 60_000);
    for (const [key, source] of this.files) if (!active.has(source.conversation) && Math.max(source.lastActive, source.createdAt) < cutoff) this.evict(key);
    this.bound();
  }

  clear(): void { this.files.clear(); this.graphs.clear(); }

  stats(): NativeReaderStats {
    return { ...this.counters, retainedBytes: this.retainedBytes(), files: this.files.size };
  }

  async graph(conversation: string, budget: DoubaoWorkBudget): Promise<NativeGraph | undefined> {
    if (!ID.test(conversation)) return undefined;
    this.active.add(conversation);
    const sessions = await this.sessions(conversation);
    if (!sessions) return undefined;
    const folder = path.join(sessions, conversation, 'agents'), allowed = await fs.realpath(folder);
    const canonicalSessions = await fs.realpath(sessions);
    if (!allowed.startsWith(canonicalSessions + path.sep)) throw new Error('Unsafe native conversation directory');
    const actors = (await fs.readdir(folder, { withFileTypes: true })).filter(x => x.isDirectory() && !x.isSymbolicLink() && ID.test(x.name));
    if (actors.length > 64) { this.diagnostic('agent_capacity'); return undefined; }
    const mains = actors.filter(x => /^m_[a-zA-Z0-9]+$/.test(x.name));
    if (mains.length !== 1) return undefined;
    const main = mains[0].name, sources: Source[] = [], assignments: Source[] = [];
    for (const actor of actors) {
      const system = path.join(folder, actor.name, 'system');
      try {
        assignments.push(await this.load(path.join(system, 'assignment.md'), allowed, 'assignment', conversation, actor.name, main, budget));
      } catch (error) { if (!missing(error)) throw error; }
      try {
        sources.push(await this.load(path.join(system, 'trajectory.jsonl'), allowed, 'trajectory', conversation, actor.name, main, budget));
      } catch (error) { if (!missing(error)) throw error; }
    }
    if (!sources.some(x => x.actor === main)) return undefined;
    const version = [...sources, ...assignments].map(x => x.version).join(',');
    const cached = this.graphs.get(conversation);
    if (cached?.version === version) return cached.graph;
    const graph: NativeGraph = { main, edges: {}, content: { calls: {}, assignments: {}, lastAnswers: {}, transcripts: {}, transcriptOffsets: {}, sourceVersions: {}, sourceBytes: {} } };
    const indexedActors = new Map(sources.map(source => [source.actor, source.state!]));
    graph.content!.findUserRows = (actor, key) => {
      const values = indexedActors.get(actor)?.userDemands.get(key);
      return values ? values.indices.slice(values.head) : [];
    };
    let calls = 0, contentUnavailable = false;
    for (const source of sources) {
      const state = source.state!;
      if (state.graphInvalid) { this.diagnostic('invalid_native_record'); return undefined; }
      if (state.contentInvalid) contentUnavailable = true;
      for (const [id, edge] of Object.entries(state.edges)) {
        if (graph.edges[id] && JSON.stringify(graph.edges[id]) !== JSON.stringify(edge)) return undefined;
        graph.edges[id] = edge;
      }
      for (const [id, call] of Object.entries(state.content.calls)) {
        if (graph.content!.calls[id]) contentUnavailable = true;
        if (++calls > MAX_CALLS) { this.diagnostic('call_index_capacity'); contentUnavailable = true; }
        else graph.content!.calls[id] = call;
      }
      graph.content!.transcripts![source.actor] = state.rows.slice(state.head).map(row => row.value);
      graph.content!.transcriptOffsets![source.actor] = state.rows[state.head]?.index ?? state.rowCount;
      graph.content!.sourceVersions![source.actor] = String(source.version);
      graph.content!.sourceBytes![source.actor] = state.bytes * 3 + state.callBytes + (state.rows.length - state.head) * 256;
      if (state.content.lastAnswers[source.actor]) graph.content!.lastAnswers[source.actor] = state.content.lastAnswers[source.actor];
    }
    for (const source of assignments) {
      graph.content!.assignments[source.actor] = this.assignmentValues(source);
      graph.content!.sourceVersions![source.actor] += ':' + source.version;
    }
    if (contentUnavailable) { this.diagnostic('content_index_unavailable'); delete graph.content; }
    this.graphs.set(conversation, { version, graph });
    this.bound(conversation);
    return graph;
  }

  async executions(conversation: string, budget: DoubaoWorkBudget): Promise<NativeExecution[]> {
    if (!this.options.snapshotRoot || !/^\d{1,30}$/.test(conversation)) return [];
    const allowed = await fs.realpath(this.options.snapshotRoot);
    const accounts = (await fs.readdir(allowed, { withFileTypes: true })).filter(x => x.isDirectory() && !x.isSymbolicLink() && /^\d{1,30}$/.test(x.name));
    if (accounts.length > 8) { this.diagnostic('snapshot_account_capacity'); throw new Error('Native execution account limit exceeded'); }
    const result = new Map<string, NativeExecution>(); let files = 0;
    for (const account of accounts) {
      const folder = path.join(allowed, account.name, conversation);
      let entries;
      try { await safeDirectory(folder, allowed); entries = await fs.readdir(folder, { withFileTypes: true }); }
      catch (error) { if (missing(error)) continue; throw error; }
      const executions = entries.filter(x => x.isDirectory() && !x.isSymbolicLink() && UUID.test(x.name));
      if (executions.length > 128) { this.diagnostic('execution_capacity'); throw new Error('Native execution count limit exceeded'); }
      if (entries.some(x => x.isSymbolicLink())) throw new Error('Unsafe native execution directory');
      for (const execution of executions) {
        const dir = path.join(folder, execution.name); await safeDirectory(dir, allowed);
        const records = await fs.readdir(dir, { withFileTypes: true });
        if (records.length > 64) { this.diagnostic('snapshot_record_capacity'); throw new Error('Native execution record limit exceeded'); }
        if (records.some(x => x.isSymbolicLink())) throw new Error('Unsafe native execution record');
        for (const record of records) {
          if (!record.isFile() || !record.name.endsWith('.json') || !ID.test(record.name.slice(0, -5))) continue;
          if (++files > 128) { this.diagnostic('snapshot_file_capacity'); throw new Error('Native execution file limit exceeded'); }
          const source = await this.load(path.join(dir, record.name), allowed, 'snapshot', conversation, record.name.slice(0, -5), '', budget);
          const value = source.execution;
          if (!value) continue;
          if (value.executionKey !== execution.name || value.conversationId !== conversation || value.agentId + '.json' !== record.name) throw new Error('Native execution path identity mismatch');
          const prior = result.get(value.executionKey);
          if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw new Error('Conflicting native execution identity');
          result.set(value.executionKey, value);
        }
      }
    }
    this.bound(conversation);
    return [...result.values()];
  }

  private async sessions(conversation: string): Promise<string | undefined> {
    if (this.options.sessionsRoot) return this.options.sessionsRoot;
    if (!this.options.userDataRoot) return undefined;
    const root = await fs.realpath(this.options.userDataRoot);
    const profiles = (await fs.readdir(root, { withFileTypes: true })).filter(x => x.name === 'Default' || /^Profile \d+$/.test(x.name));
    if (profiles.length > 16 || profiles.some(x => !x.isDirectory() || x.isSymbolicLink())) return undefined;
    const matches: string[] = [];
    for (const profile of profiles) {
      const sessions = path.join(root, profile.name, '.doubaowork/agent_mode/workspace/.sessions');
      try { await safeDirectory(path.join(sessions, conversation), root); matches.push(sessions); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async load(file: string, allowed: string, kind: Source['kind'], conversation: string, actor: string, main: string, budget: DoubaoWorkBudget): Promise<Source> {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !(await fs.realpath(file)).startsWith(allowed + path.sep)) throw new Error('Unsafe native source');
    const stamp = stampOf(stat);
    if (kind === 'snapshot' && stamp.size > WINDOW) { this.diagnostic('snapshot_byte_capacity'); throw new Error('Native execution read limit exceeded'); }
    let source = this.files.get(file);
    if (source?.parseFailure && sameStamp(source.stamp, stamp)) throw source.parseFailure;
    if (source && sameStamp(source.stamp, stamp) && source.ready) {
      source.lastSeen = Date.now(); if (this.active.has(conversation)) source.lastActive = Date.now();
      this.counters.cacheHits++; return source;
    }
    if (budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
    const handle = await fs.open(file, 'r');
    try {
      if (!sameStamp(stampOf(await handle.stat({ bigint: true })), stamp)) throw new DoubaoWorkDeferred('source_changed');
      if (source && !sameStamp(source.stamp, stamp)) {
        const append = !source.parseFailure && kind !== 'snapshot' && source.stamp.identity === stamp.identity && stamp.size > source.stamp.size
          && await this.anchorsMatch(source, handle, budget);
        if (!append) { this.counters.resets++; this.graphs.delete(conversation); source = undefined; }
      }
      if (!source) {
        source = { kind, conversation, actor, stamp, offset: 0, committed: 0, buffer: Buffer.alloc(0), ready: false,
          first: Buffer.alloc(0), tail: Buffer.alloc(0), version: ++this.sequence, createdAt: Date.now(), lastSeen: Date.now(), lastActive: this.active.has(conversation) ? Date.now() : 0 };
        if (kind === 'trajectory') source.state = { rows: [], head: 0, rowCount: 0, bytes: 0, content: { calls: {}, assignments: {}, lastAnswers: {} }, contentInvalid: false, graphInvalid: false, callCount: 0, callBytes: 0, creationCalls: new Set(), edges: {}, userDemands: new Map() };
        if (kind === 'snapshot') source.chunks = [];
        if (kind === 'assignment') { source.assignments = []; source.assignmentBytes = 0; }
        this.files.set(file, source);
      }
      source.stamp = stamp; source.lastSeen = Date.now(); source.ready = false;
      if (this.active.has(conversation)) source.lastActive = Date.now();
      while (true) {
        if (kind !== 'snapshot') await this.lines(source, main, budget);
        if (source.offset >= stamp.size) break;
        if (budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, stamp.size - source.offset, budget.remainingBytes));
        const bytes = await budget.read(handle, buffer, buffer.length, source.offset);
        if (!bytes) throw new DoubaoWorkDeferred('source_changed');
        this.counters.bodyReadBytes += bytes;
        const chunk = buffer.subarray(0, bytes);
        if (source.first.length < 64) source.first = Buffer.concat([source.first, chunk.subarray(0, 64 - source.first.length)]);
        source.tail = Buffer.from(Buffer.concat([source.tail, chunk]).subarray(-64));
        source.offset += bytes; source.version = ++this.sequence; this.graphs.delete(conversation);
        if (kind === 'snapshot') source.chunks!.push(chunk);
        else source.buffer = Buffer.concat([source.buffer, chunk]);
        this.bound(conversation);
      }
      if (!sameStamp(stampOf(await handle.stat({ bigint: true })), stamp)) throw new DoubaoWorkDeferred('source_changed');
      if (kind === 'snapshot') {
        source.execution = parseNativeExecution(JSON.parse(Buffer.concat(source.chunks!).toString('utf8')));
        source.chunks = []; budget.parsed(stamp.size); this.counters.parsedRows++;
      } else if (kind === 'trajectory' && source.buffer.length) throw new DoubaoWorkDeferred('partial_line');
      source.ready = true;
      return source;
    } catch (error) {
      if (source && error instanceof SyntaxError) { source.parseFailure = error; this.diagnostic('invalid_native_json'); }
      throw error;
    } finally { await handle.close(); }
  }

  private async anchorsMatch(source: Source, handle: fs.FileHandle, budget: DoubaoWorkBudget): Promise<boolean> {
    for (const [expected, position] of [[source.first, 0], [source.tail, source.offset - source.tail.length]] as const) {
      if (!expected.length) continue;
      const actual = Buffer.alloc(expected.length), count = await budget.read(handle, actual, actual.length, position);
      if (count !== expected.length || !actual.equals(expected)) return false;
    }
    return true;
  }

  private async lines(source: Source, main: string, budget: DoubaoWorkBudget): Promise<void> {
    let from = 0;
    try {
      while (from < source.buffer.length) {
        const newline = source.buffer.indexOf(10, from);
        if (newline < 0) {
          if (source.buffer.length - from > WINDOW) { this.diagnostic('record_byte_capacity'); throw new Error('Native record limit exceeded'); }
          break;
        }
        if (budget.exhausted) throw new DoubaoWorkDeferred('cycle_budget');
        const bytes = newline + 1 - from;
        if (bytes > WINDOW) { this.diagnostic('record_byte_capacity'); throw new Error('Native record limit exceeded'); }
        const line = source.buffer.subarray(from, newline).toString('utf8');
        if (source.kind === 'trajectory') {
          if (line) this.row(source, main, JSON.parse(line), bytes);
        } else this.assignmentLine(source, line + '\n');
        from = newline + 1; source.committed += bytes;
        budget.parsed(bytes); this.counters.parsedRows++;
        await budget.yieldIfNeeded();
      }
    } finally { if (from) source.buffer = Buffer.from(source.buffer.subarray(from)); }
  }

  private row(source: Source, main: string, row: Record<string, any>, bytes: number): void {
    const state = source.state!, index = state.rowCount++;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { state.graphInvalid = true; return; }
    if (!state.graphInvalid && !appendNativeGraphRow(main, source.actor, row, state.creationCalls, state.edges)) state.graphInvalid = true;
    if (state.creationCalls.size > MAX_CALLS || Object.keys(state.edges).length > 64) state.graphInvalid = true;
    const ids: string[] = row.role === 'assistant' && Array.isArray(row.tool_calls)
      ? row.tool_calls.map((call: { id: string }) => call?.id) : typeof row.tool_call_id === 'string' ? [row.tool_call_id] : [];
    const before = ids.reduce((n, id) => n + callBytes(state.content.calls[id]), 0);
    if (!state.contentInvalid && !appendNativeContentRow(state.content, source.actor, row, index, state.head > 0 || (state.rows[0]?.index ?? 0) > 0)) state.contentInvalid = true;
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) state.callCount += row.tool_calls.length;
    state.callBytes += ids.reduce((n, id) => n + callBytes(state.content.calls[id]), 0) - before;
    const demand = row.role === 'user' && typeof row.content === 'string' && row.content.length <= 64 * 1024 ? nativeDemandFingerprint(row.content) : undefined;
    if (demand) {
      let values = state.userDemands.get(demand);
      if (!values) { values = { indices: [], head: 0 }; state.userDemands.set(demand, values); }
      values.indices.push(index);
    }
    state.rows.push({ index, bytes, value: row, demand }); state.bytes += bytes;
    if (state.bytes > WINDOW) this.diagnostic('content_window');
    while (state.bytes > WINDOW && state.rows.length - state.head > 1) this.trim(state);
    if (state.callCount > MAX_CALLS) {
      const calls = Object.keys(state.content.calls);
      // Keep recent content separately from the durable create-agent index.
      const cutoff = state.content.calls[calls[Math.max(0, calls.length - Math.floor(MAX_CALLS * .75))]]?.recordIndex ?? index;
      while (state.rows[state.head]?.index < cutoff) this.trim(state);
      for (const id of calls) if (state.content.calls[id]?.recordIndex < cutoff) {
        state.callBytes -= callBytes(state.content.calls[id]); delete state.content.calls[id]; state.callCount--;
      }
      this.diagnostic('content_window');
    }
    if (state.head > 1024 && state.head * 2 > state.rows.length) { state.rows = state.rows.slice(state.head); state.head = 0; }
  }

  private trim(state: ActorState): void {
    const row = state.rows[state.head]; if (!row) return;
    state.rows[state.head++] = { index: row.index, bytes: 0, value: {} };
    state.bytes -= row.bytes;
    if (row.demand) {
      const values = state.userDemands.get(row.demand)!;
      values.head++;
      if (values.head === values.indices.length) state.userDemands.delete(row.demand);
      else if (values.head > 1024 && values.head * 2 > values.indices.length) { values.indices = values.indices.slice(values.head); values.head = 0; }
    }
    for (const call of Array.isArray(row.value.tool_calls) ? row.value.tool_calls : []) {
      const content = state.content.calls[call.id];
      if (!content || content.recordIndex !== row.index) continue;
      state.callBytes -= callBytes(content);
      if (content.resultIndex !== undefined) { delete state.content.calls[call.id]; state.callCount--; }
      else { delete content.arguments; delete content.result; state.callBytes += callBytes(content); }
    }
    const completed = row.value.role === 'tool' ? state.content.calls[row.value.tool_call_id] : undefined;
    if (completed?.resultIndex === row.index && completed.recordIndex < (state.rows[state.head]?.index ?? state.rowCount)) {
      state.callBytes -= callBytes(completed); delete state.content.calls[row.value.tool_call_id]; state.callCount--;
    }
  }

  private assignmentLine(source: Source, line: string): void {
    const header = /^## \[([^\]\r\n]+)\] 需求\r?\n$/.exec(line);
    if (header) {
      const previous = this.currentAssignment(source);
      if (previous) {
        if (!source.firstAssignment) { source.firstAssignment = previous; source.firstAssignmentBytes = Buffer.byteLength(previous.text) * 2 + 64; }
        source.assignments!.push(previous);
        source.assignmentBytes! += Buffer.byteLength(previous.text) * 2 + 64;
        if (source.assignments!.length > 512) { source.assignmentBytes! -= Buffer.byteLength(source.assignments!.shift()!.text) * 2 + 64; this.diagnostic('assignment_window'); }
      }
      source.currentAssignment = { timeMs: Date.parse(header[1]), chunks: [], bytes: 0, overflow: false };
    } else if (source.currentAssignment) {
      const current = source.currentAssignment; current.bytes += Buffer.byteLength(line);
      if (current.bytes > WINDOW) { current.overflow = true; current.chunks = []; }
      else current.chunks.push(line);
    }
  }

  private currentAssignment(source: Source, tail = ''): NativeAssignment | undefined {
    const current = source.currentAssignment;
    if (!current || current.overflow || !Number.isSafeInteger(current.timeMs)) return undefined;
    const text = (current.chunks.join('') + tail).trim();
    return text && Buffer.byteLength(text) <= 64 * 1024 ? { timeMs: current.timeMs, text: independentNativeString(text) } : undefined;
  }

  private assignmentValues(source: Source): NativeAssignment[] {
    const values = [...source.assignments!], current = this.currentAssignment(source, source.buffer.toString('utf8'));
    if (source.firstAssignment && !values.includes(source.firstAssignment)) values.unshift(source.firstAssignment);
    if (current) values.push(current);
    return values;
  }

  private retainedBytes(): number {
    let bytes = 0;
    for (const source of this.files.values()) {
      const state = source.state;
      bytes += source.buffer.length + (source.chunks?.reduce((n, b) => n + b.length, 0) ?? 0) + 512;
      if (state) {
        bytes += state.bytes * 3 + (state.rows.length - state.head) * 256;
        bytes += state.callBytes;
      }
      bytes += (source.currentAssignment?.overflow ? 0 : source.currentAssignment?.bytes ?? 0) * 2;
      bytes += source.assignmentBytes ?? 0;
      bytes += source.firstAssignmentBytes ?? 0;
    }
    return bytes;
  }

  private bound(protectedConversation?: string): void {
    const limit = this.options.maxCacheBytes ?? 64 * 1024 * 1024, maxFiles = this.options.maxFiles ?? 512;
    if (this.files.size <= maxFiles && this.retainedBytes() <= limit) return;
    const ordered = [...this.files].filter(([, x]) => x.conversation !== protectedConversation)
      .sort(([, a], [, b]) => Number(this.active.has(a.conversation)) - Number(this.active.has(b.conversation)) || a.lastActive - b.lastActive || a.createdAt - b.createdAt);
    for (const [key] of ordered) {
      this.evict(key);
      if (this.files.size <= maxFiles && this.retainedBytes() <= limit) return;
    }
    if (this.files.size > maxFiles || this.retainedBytes() > limit) {
      for (const [key, source] of this.files) if (source.conversation === protectedConversation) this.evict(key);
      this.diagnostic('cache_capacity'); throw new Error('Doubao native cache capacity exceeded');
    }
  }

  private evict(key: string): void {
    const source = this.files.get(key); if (!source) return;
    this.files.delete(key); this.graphs.delete(source.conversation); this.counters.evictions++;
  }

  private diagnostic(reason: string): void {
    if (this.reported.has(reason)) return;
    this.reported.add(reason); this.options.diagnostic?.(reason);
  }
}

function callBytes(call: NativeContent['calls'][string] | undefined): number {
  return call ? (Buffer.byteLength(call.arguments ?? '') + Buffer.byteLength(call.result ?? '')) * 2 + 256 : 0;
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
async function safeDirectory(folder: string, allowed: string): Promise<void> {
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !(await fs.realpath(folder)).startsWith(allowed + path.sep)) throw new Error('Unsafe native directory');
}
function stampOf(stat: { dev: bigint; ino: bigint; birthtimeNs: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): Stamp {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Unsafe native file size');
  return { identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, size, mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
}
function sameStamp(a: Stamp, b: Stamp): boolean { return a.identity === b.identity && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime; }
