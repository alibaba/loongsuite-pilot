import { constants, promises as fs, watch, type FSWatcher } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../../types/index.js';

import type { NativeUsageIndex } from './native-usage-index.js';

type Usage = { input: number; output: number; cached?: number };
type Turn = {
  reply: string; session: string; trace: string; tools: Set<string>; reports: Map<number, Usage>;
  lastSeq: number; contiguous: boolean; done: boolean; touched: number;
};
type Cursor = { handle: FileHandle; offset: number; skipping: boolean; turn?: Turn };
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const windowSize = 4 * 1024 * 1024;

// The producer unlinks the cache at completion. Keep its descriptor through the
// final drain, and retain only IDs and numeric observations after parsing.
export class HubUsage {
  private readonly files = new Map<string, Cursor>();
  private readonly turns = new Map<string, Turn>();
  private watcher?: FSWatcher;
  private pending?: Promise<void>;
  private dirty = false;

  constructor(private readonly root: string) {}

  async refresh() {
    if (!this.watcher) {
      try {
        this.watcher = watch(this.root, { recursive: true, persistent: false }, () => {
          void this.refresh().catch(() => {});
        });
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
      } catch { /* Optional cache. Retry on the next collection. */ }
    }
    this.dirty = true;
    this.pending ??= (async () => {
      do { this.dirty = false; await this.scan(); } while (this.dirty);
    })().finally(() => { this.pending = undefined; });
    await this.pending;
  }

  private async scan() {
    const seen = new Set<string>();
    for (const dir of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      const parent = path.join(this.root, dir.name);
      for (const entry of await fs.readdir(parent, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isFile() || !/^[a-f0-9]{24}\.jsonl$/.test(entry.name)) continue;
        const file = path.join(parent, entry.name);
        seen.add(file);
        if (this.files.has(file)) continue;
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
        if (handle) this.files.set(file, { handle, offset: 0, skipping: false });
      }
    }
    for (const [file, cursor] of this.files) {
      try {
        const stat = await cursor.handle.stat();
        if (stat.isFile()) await this.drain(cursor, stat.size, path.basename(file, '.jsonl'));
      } catch { if (cursor.turn) cursor.turn.contiguous = false; }
      if (!seen.has(file)) {
        await cursor.handle.close();
        this.files.delete(file);
      }
    }
    for (const [reply, turn] of this.turns) {
      if (Date.now() - turn.touched > 3600_000) this.turns.delete(reply);
    }
  }

  private async drain(cursor: Cursor, size: number, reply: string) {
    while (cursor.offset < size) {
      const buffer = Buffer.allocUnsafe(Math.min(size - cursor.offset, windowSize));
      const { bytesRead } = await cursor.handle.read(buffer, 0, buffer.length, cursor.offset);
      if (!bytesRead) break;
      const data = buffer.subarray(0, bytesRead);
      const end = data.lastIndexOf(10) + 1;
      if (!end) {
        if (bytesRead === windowSize) {
          cursor.offset += bytesRead;
          cursor.skipping = true;
          if (cursor.turn) cursor.turn.contiguous = false;
          continue;
        }
        break;
      }
      const start = cursor.skipping ? data.indexOf(10) + 1 : 0;
      cursor.skipping = false;
      cursor.offset += end;
      for (const line of data.toString('utf8', start, end).split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (!cursor.turn && row.type === 'metadata') {
            const meta = JSON.parse(row.data);
            if (meta.reply_to_message_id !== reply || !/^[0-9a-f]{24}$/.test(meta.session_id) ||
                !/^[0-9a-f]{32}$/.test(meta.trace_id)) continue;
            cursor.turn = { reply, session: meta.session_id, trace: meta.trace_id, tools: new Set(), reports: new Map(),
              lastSeq: row.seq - 1, contiguous: row.seq === 0 || row.seq === 1, done: false, touched: Date.now() };
            this.turns.set(reply, cursor.turn);
          }
          const turn = cursor.turn;
          if (!turn) continue;
          turn.touched = Date.now();
          if (!count(row.seq) || row.seq !== turn.lastSeq + 1) turn.contiguous = false;
          turn.lastSeq = row.seq;
          if (!['done', 'plan_item', 'token_usage'].includes(row.type)) continue;
          const d = JSON.parse(row.data);
          if (d.reply_to_message_id !== reply) { turn.contiguous = false; continue; }
          if (row.type === 'done') turn.done = true;
          if (row.type === 'plan_item') {
            const id = d.tool_call_info?.meta?.llm_toolcall_id;
            if (typeof id === 'string' && id.length <= 256) turn.tools.add(id);
          }
          if (row.type === 'token_usage') {
            if (!count(d.prompt_tokens) || !count(d.completion_tokens) || !count(row.seq) ||
                d.prompt_tokens + d.completion_tokens !== d.total_tokens) { turn.contiguous = false; continue; }
            turn.reports.set(row.seq, { input: d.prompt_tokens, output: d.completion_tokens,
              cached: count(d.cache_read_input_tokens) && d.cache_read_input_tokens <= d.prompt_tokens
                ? d.cache_read_input_tokens : undefined });
          }
        } catch { if (cursor.turn) cursor.turn.contiguous = false; }
      }
    }
  }

  enrich(entry: AgentActivityEntry, native?: Pick<NativeUsageIndex, 'complete' | 'responses' | 'expectedSeqs'>) {
    if (entry['event.name'] !== 'llm.response') return;
    const ids = new Set<string>();
    const messages = entry['gen_ai.output.messages'];
    if (Array.isArray(messages)) for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'parts' in msg && Array.isArray(msg.parts)) {
        for (const p of msg.parts) if (p && typeof p === 'object' && 'type' in p && p.type === 'tool_call' && typeof p.id === 'string') ids.add(p.id);
      }
    }
    const rounds = native?.responses(entry['gen_ai.session.id'], ids);
    if (rounds) entry['loongsuite.trae_cn.model_responses'] = rounds;
    const matches = [...this.turns.values()].filter(t => t.session === entry['gen_ai.session.id'] &&
      [...ids].some(id => t.tools.has(id)));
    if (matches.length !== 1) return;
    const turn = matches[0];
    if (rounds) entry['loongsuite.trae_cn.model_responses'] = rounds.map(round => {
      if ('streamReports' in round && round.streamReports) {
        const reports = round.streamReports.filter(r => r.reply === turn.reply && turn.reports.has(r.seq));
        return { ...round, streamReceived: reports.length,
          streamExpected: round.streamReports.length,
          streamTokens: reports.reduce((total, r) => {
            const usage = turn.reports.get(r.seq)!;
            return total + usage.input + usage.output;
          }, 0) };
      }
      const report = 'reply' in round && round.reply === turn.reply && round.seq !== undefined ? turn.reports.get(round.seq) : undefined;
      return report ? { ...round, input: report.input, output: report.output,
        ...(report.cached !== undefined ? { cached: report.cached } : {}) } : round;
    });
    let input = 0, output = 0, cached = 0, allCached = true;
    for (const r of turn.reports.values()) {
      input += r.input; output += r.output;
      if (r.cached === undefined) allCached = false;
      else cached += r.cached;
    }
    const prefix = 'agent.trae-cn.hub.';
    entry[prefix + 'total_tokens_observed'] = input + output;
    entry[prefix + 'trace_id'] = turn.trace;
    entry[prefix + 'usage_event_seqs'] = [...turn.reports.keys()].join(',');
    const expected = native?.expectedSeqs(turn.trace, turn.session, turn.reply);
    entry[prefix + 'usage_received'] = turn.reports.size;
    if (expected) {
      entry[prefix + 'usage_expected'] = expected.size;
      entry[prefix + 'missing_usage_seqs'] = [...expected].filter(seq => !turn.reports.has(seq)).join(',');
    }
    const complete = expected ? native!.complete(turn.trace, turn.session, turn.reply, turn.reports) : (turn.contiguous && turn.done) || native?.complete(turn.trace, turn.session, turn.reply, turn.reports) === true;
    entry[prefix + 'complete'] = complete;
    entry[prefix + 'input_tokens_observed'] = input;
    entry[prefix + 'output_tokens_observed'] = output;
    if (allCached) {
      entry[prefix + 'cached_tokens_observed'] = cached;
      if (input > 0) entry[prefix + 'cache_hit_ratio_observed'] = cached / input;
    }
    if (!complete || !turn.reports.size) return;
    // Hook fields can arrive independently. Combine sources only when the
    // counters they both report describe the same usage.
    const counts = {
      'gen_ai.usage.input_tokens': input,
      'gen_ai.usage.output_tokens': output,
      'gen_ai.usage.total_tokens': input + output,
      ...(allCached ? { 'gen_ai.usage.cache_read.input_tokens': cached } : {}),
    };
    if (Object.entries(counts).some(([key, value]) => entry[key] != null && entry[key] !== value)) return;
    for (const [key, value] of Object.entries(counts)) entry[key] ??= value;
  }

  async close() {
    this.watcher?.close();
    await this.pending;
    await Promise.all([...this.files.values()].map(c => c.handle.close()));
    this.files.clear();
    this.turns.clear();
    this.watcher = undefined;
  }
}
