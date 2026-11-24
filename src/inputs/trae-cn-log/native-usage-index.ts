import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInflateRaw } from 'node:zlib';
import cbor from 'cbor';

type ReplyUsage = { reply: string; seq: number };
type ResponseStream = {
  request: string; headersAt?: string; owner: unknown; histories: Set<string>; tools: Set<string>; reports: Map<string, ReplyUsage>;
  todoStarts: Map<string, string>; committedAt?: string;
  initial: boolean; terminal?: boolean; continuation?: string; resultCount?: number; closed: boolean;
};
type Receipt = { session: string; turn: string; done: boolean; touched: number; streams: ResponseStream[]; active?: ResponseStream; ambiguousStreams?: boolean; calls: Set<string>; history: Map<string, string>; expected: Map<string, Set<number>> };
const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString('utf8') : '';
const id24 = /^[a-f0-9]{24}$/;
function nativeTimestamp(record: unknown): string | undefined {
  const parts = (record as { time?: number[] }).time;
  if (!Array.isArray(parts) || parts.length !== 9 || !parts.every(Number.isInteger)) return;
  const [year, day, hour, minute, second, ns, oh, om, os] = parts;
  const ms = Date.UTC(year, 0, day, hour - oh, minute - om, second - os);
  if (Number.isFinite(ms) && ns >= 0 && ns < 1e9) return String(BigInt(ms) * 1000000n + BigInt(ns));
}

class NativeStream {
  readonly receipts = new Map<string, Receipt>();
  readonly inflater = createInflateRaw();
  readonly decoder = new cbor.Decoder({ max_depth: 64 });
  visitor?: (record: unknown) => void;
  error?: Error;
  constructor(readonly identity: string, public offset: number) {
    this.inflater.on('error', error => { this.error = error; });
    this.decoder.on('error', error => { this.error = error; });
    this.inflater.on('data', chunk => { this.decoder.write(chunk); });
    this.decoder.on('data', record => this.visitor?.(record));
  }
  async feed(bytes: Buffer): Promise<void> {
    if (this.error) throw this.error;
    await new Promise<void>((resolve, reject) => {
      const failed = (e: Error) => { this.inflater.off('error', failed); reject(e); };
      this.inflater.once('error', failed);
      this.inflater.write(bytes, err => {
        this.inflater.off('error', failed);
        if (err || this.error) reject(err || this.error); else resolve();
      });
    });
    this.offset += bytes.length;
  }
  close() { this.inflater.destroy(); this.decoder.destroy(); }
}


// The native Hub contract records the sequence of each usage notification,
// including notifications whose numeric payload never reached the JSONL file.
export class NativeUsageIndex {
  private readonly streams = new Map<string, NativeStream>();
  private readonly root = path.join(process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
    : (process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME) || path.join(os.homedir(), '.config'), 'Trae CN', 'logs');

  private visit(file: string, stream: NativeStream, record: unknown) {
    const f = (record as { fields?: Record<string, unknown> })?.fields;
    if (!f) return;
    const trace = text(f.trace_id), message = text(f.message);
    if (!/^[a-f0-9]{32}$/.test(trace)) return;
    if (message === 'context resolve applied to task request') {
      const session = text(f.session_id), turn = text(f.turn_id);
      if (id24.test(session) && id24.test(turn) && !stream.receipts.has(trace)) {
        stream.receipts.set(trace, { session, turn, expected: new Map(), streams: [], calls: new Set(), history: new Map(), done: false, touched: Date.now() });
      }
      return;
    }
    let r = stream.receipts.get(trace);
    if (!r) {
      // Rotation starts a new compressed file without repeating the task
      // context. Only resume an identified task in the same TRAE log session.
      for (const [otherFile, other] of this.streams) {
        if (path.dirname(otherFile) !== path.dirname(file)) continue;
        const candidate = other.receipts.get(trace);
        if (!candidate) continue;
        if (r) return;
        r = candidate;
      }
    }
    if (!r) return;
    const owner = (record as { span?: unknown }).span;
    if (message === 'cloud stream response headers' &&
        /\/api\/agent\/v3\/(?:create_agent_task|commit_toolcall_result)$/.test(text(f.url))) {
      const request = text(f.resp_logid);
      if (r.active) r.ambiguousStreams = true;
      r.active = undefined;
      if (owner == null || !request || request.length > 128) r.ambiguousStreams = true;
      else {
        const initial = text(f.url).endsWith('/create_agent_task');
        const previous = r.streams.at(-1);
        const continuation = !initial && previous?.closed && !previous.terminal && previous.owner === owner
          ? previous.request : undefined;
        r.active = { owner, request, headersAt: nativeTimestamp(record), initial, continuation, histories: new Set(), tools: new Set(), todoStarts: new Map(), reports: new Map(), closed: false };
        r.streams.push(r.active);
      }
    }
    if (f.has_async_child === true || f.has_foreground === true) r.ambiguousStreams = true;
    const active = r.active?.owner === owner ? r.active : undefined;
    if (active) {
      if (message === 'streaming ToolCall dispatch' && f.require_local_execution === true && text(f.toolcall_id)) {
        active.tools.add(text(f.toolcall_id));
      }
      if (message === 'tool execution started' && text(f.tool_name) === 'TodoWrite') {
        const id = text(f.toolcall_id), at = nativeTimestamp(record);
        if (active.tools.has(id) && at) active.todoStarts.set(id, at);
      }
      if (message === 'routing CommitReady' && f.has_async_child === false && f.has_foreground === false &&
          typeof f.parent_result_count === 'number') active.resultCount = f.parent_result_count;
      if (message === 'commit_results' || message === 'resolving explicit Cloud task completion as terminal') {
        active.terminal = message === 'resolving explicit Cloud task completion as terminal';
        active.closed = message === 'commit_results'
          ? text(f.conversation_id) === r.session && active.resultCount === active.tools.size && f.result_count === active.tools.size
          : active.tools.size === 0;
        if (active.closed && !active.terminal) active.committedAt = nativeTimestamp(record);
        r.active = undefined;
      }
    }
    if (message === 'tool execution started') {
      const id = text(f.toolcall_id);
      if (id && id.length <= 256) r.calls.add(id);
    }
    if (message === 'recording history entry' && text(f.history_source) === 'Server' && text(f.source) === 'llm_default') {
      const id = text(f.history_id);
      if (id24.test(id)) active?.histories.add(id);
      const at = nativeTimestamp(record);
      if (id24.test(id) && at && !r.history.has(id)) r.history.set(id, at);
    }
    if (message === '[Hub] task event contract' && text(f.event_type) === 'token_usage' &&
        text(f.conversation_id) === r.session && id24.test(text(f.task_id)) &&
        typeof f.event_seq === 'number' && Number.isSafeInteger(f.event_seq) && f.event_seq >= 0) {
      const reply = text(f.task_id);
      const seqs = r.expected.get(reply) ?? new Set<number>();
      active?.reports.set(reply + "/" + f.event_seq, { reply, seq: f.event_seq });
      seqs.add(f.event_seq);
      r.expected.set(reply, seqs);
    } else if (message === 'chat: runner completed' && text(f.turn_id) === r.turn) {
      r.done = true;
    }
  }

  responses(session: string, calls: Set<string>) {
    if (!calls.size) return;
    const matches = [...this.streams.values()].flatMap(s => [...s.receipts.values()])
      .filter(r => r.session === session && [...calls].some(id => r.calls.has(id)));
    if (matches.length !== 1 || !matches[0].done || !matches[0].history.size) return;
    const receipt = matches[0];
    const exactTurn = [...calls].every(call => receipt.calls.has(call)) && receipt.expected.size <= 1;
    return [...receipt.history].map(([id, at]) => {
      const owners = receipt.streams.filter(s => s.histories.has(id));
      const s = owners[0];
      if (receipt.ambiguousStreams || owners.length !== 1 || !s.closed ||
          receipt.streams.filter(other => other.request === s.request).length !== 1) return { id, at };
      const toolIds = [...s.tools].filter(call => receipt.calls.has(call) &&
        receipt.streams.every(other => other === s || !other.tools.has(call)));
      const uniqueReports = [...s.reports].filter(([key]) => receipt.streams.every(other => other === s || !other.reports.has(key)));
      const shared = s.histories.size > 1;
      const usage = !shared && uniqueReports.length === 1 && s.reports.size === 1 ? uniqueReports[0][1] : undefined;
      const committedAt = s.committedAt;
      const todos = [...s.todoStarts].flatMap(([call, start]) =>
        exactTurn && committedAt && toolIds.includes(call) && BigInt(start) <= BigInt(committedAt)
          ? [{ call, start, committedAt }] : []);
      return { id, at, ...(todos.length ? { todos } : {}), request: s.request, toolIds,
        ...(!shared && s.headersAt && BigInt(s.headersAt) < BigInt(at) ? { headersAt: s.headersAt } : {}),
        ...(shared ? { shared: true, streamReports: uniqueReports.map(([, usage]) => usage) } : {}),
        ...(s.initial && s === receipt.streams[0] ? { initial: true } : {}),
        ...(s.terminal && s === receipt.streams.at(-1) ? { terminal: true } : {}),
        ...(s.continuation ? { continuation: s.continuation } : {}), ...(usage ? { reply: usage.reply, seq: usage.seq } : {}) };
    });
  }

  ownsTool(trace: string, session: string, reply: string, calls: Set<string>): boolean {
    const callIds = [...calls];
    const receipts = [...this.streams.values()].flatMap(stream => [...stream.receipts])
      .filter(([, receipt]) => receipt.session === session && callIds.some(id => receipt.calls.has(id)));
    if (receipts.length !== 1) return false;
    const [[owningTrace, receipt]] = receipts;
    if (owningTrace !== trace || !receipt.done || !receipt.expected.has(reply)) return false;
    if (receipt.expected.size === 1) return true;
    if (receipt.ambiguousStreams) return false;

    // Multiple replies can share a native trace. Correlate the dispatch and
    // the reply's usage on the same verified stream before enriching a turn.
    const owners = receipt.streams.filter(stream =>
      callIds.some(id => receipt.calls.has(id) && stream.tools.has(id)));
    if (owners.length !== 1 || !owners[0].closed) return false;
    const replies = new Set([...owners[0].reports.values()].map(report => report.reply));
    return replies.size === 1 && replies.has(reply);
  }

  expectedSeqs(trace: string, session: string, reply: string) {
    const receipts = [...this.streams.values()].map(stream => stream.receipts.get(trace))
      .filter(r => r?.done && r.session === session && r.expected.has(reply));
    if (receipts.length === 1) return receipts[0]?.expected.get(reply);
  }

  complete(trace: string, session: string, reply: string, seqs: Map<number, unknown>) {
    for (const stream of this.streams.values()) {
      const r = stream.receipts.get(trace);
      const expected = r?.expected.get(reply);
      if (r?.done && r.session === session && r.expected.size === 1 && expected?.size === seqs.size &&
          [...expected].every(seq => seqs.has(seq))) return true;
    }
    return false;
  }

  async refresh() {
    const cutoff = Date.now() - 3600_000;
    const active = new Set<string>();
    for (const dir of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() || !/^\d{8}T\d{6}$/.test(dir.name)) continue;
      const folder = path.join(this.root, dir.name, 'Modular');
      const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
      const files = await Promise.all(entries.filter(item =>
        item.isFile() && /^ai_agent-\d+-\d{4}-\d\d-\d\d\.alaudalog$/.test(item.name)).map(async item => {
        const file = path.join(folder, item.name);
        return { file, stat: await fs.lstat(file).catch(() => undefined) };
      }));
      // Read the older segment before the continuation when starting cold.
      for (const { file, stat } of files.sort((a, b) => (a.stat?.birthtimeMs ?? 0) - (b.stat?.birthtimeMs ?? 0) ||
          a.file.localeCompare(b.file, 'en', { numeric: true }))) {
        if (!stat?.isFile() || stat.mtimeMs < cutoff || stat.size < 178) continue;
        active.add(file);
        let stream = this.streams.get(file);
        const identity = stat.dev + '/' + stat.ino;
        if (stream?.identity === identity && stream.offset === stat.size) continue;
        const handle = await fs.open(file, 'r').catch(() => undefined);
        if (!handle) continue;
        try {
          if (!stream || stream.identity !== identity || stream.offset > stat.size) {
            stream?.close();
            this.streams.delete(file);
            const header = Buffer.alloc(178);
            if ((await handle.read(header, 0, 178, 0)).bytesRead !== 178 ||
                header.toString('ascii', 0, 4) !== 'AalG' || header.toString('ascii', 152, 156) !== 'AALG') continue;
            const start = 172 + header.readUInt32LE(168);
            if (start > stat.size || start > 1024) continue;
            stream = new NativeStream(identity, start);
            this.streams.set(file, stream);
            const current = stream;
            stream.visitor = record => this.visit(file, current, record);
          }
          const buffer = Buffer.allocUnsafe(256 * 1024);
          while (stream.offset < stat.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(stat.size - stream.offset, buffer.length), stream.offset);
            if (!bytesRead) break;
            await stream.feed(buffer.subarray(0, bytesRead));
          }
          for (const [key, receipt] of stream.receipts) if (receipt.touched < cutoff) stream.receipts.delete(key);
        } catch {
          stream?.close();
          this.streams.delete(file);
        } finally { await handle.close(); }
      }
    }
    for (const [file, stream] of this.streams) if (!active.has(file)) { stream.close(); this.streams.delete(file); }
  }

  close() {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
  }
}
