import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createInflateRaw } from 'node:zlib';
import cbor from 'cbor';

type Receipt = { session: string; turn: string; done: boolean; touched: number; calls: Set<string>; history: Map<string, string>; expected: Map<string, Set<number>> };
const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString('utf8') : '';
const id24 = /^[a-f0-9]{24}$/;
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

  private visit(stream: NativeStream, record: unknown) {
    const f = (record as { fields?: Record<string, unknown> })?.fields;
    if (!f) return;
    const trace = text(f.trace_id), message = text(f.message);
    if (!/^[a-f0-9]{32}$/.test(trace)) return;
    if (message === 'context resolve applied to task request') {
      const session = text(f.session_id), turn = text(f.turn_id);
      if (id24.test(session) && id24.test(turn) && !stream.receipts.has(trace)) {
        stream.receipts.set(trace, { session, turn, expected: new Map(), calls: new Set(), history: new Map(), done: false, touched: Date.now() });
      }
      return;
    }
    const r = stream.receipts.get(trace);
    if (!r) return;
    if (message === 'tool execution started') {
      const id = text(f.toolcall_id);
      if (id && id.length <= 256) r.calls.add(id);
    }
    if (message === 'recording history entry' && text(f.history_source) === 'Server' && text(f.source) === 'llm_default') {
      const id = text(f.history_id);
      const parts = (record as { time?: number[] }).time;
      if (id24.test(id) && !r.history.has(id) && Array.isArray(parts) && parts.length === 9 && parts.every(Number.isInteger)) {
        const [year, day, hour, minute, second, ns, oh, om, os] = parts;
        const ms = Date.UTC(year, 0, day, hour - oh, minute - om, second - os);
        if (Number.isFinite(ms) && ns >= 0 && ns < 1e9) r.history.set(id, String(BigInt(ms) * 1000000n + BigInt(ns)));
      }
    }
    if (message === '[Hub] task event contract' && text(f.event_type) === 'token_usage' &&
        text(f.conversation_id) === r.session && id24.test(text(f.task_id)) &&
        typeof f.event_seq === 'number' && Number.isSafeInteger(f.event_seq) && f.event_seq >= 0) {
      const reply = text(f.task_id);
      const seqs = r.expected.get(reply) ?? new Set<number>();
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
    return [...matches[0].history].map(([id, at]) => ({ id, at }));
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
      for (const item of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
        if (!item.isFile() || !/^ai_agent-\d+-\d{4}-\d\d-\d\d\.alaudalog$/.test(item.name)) continue;
        const file = path.join(folder, item.name);
        const stat = await fs.lstat(file).catch(() => undefined);
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
            stream.visitor = record => this.visit(current, record);
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
