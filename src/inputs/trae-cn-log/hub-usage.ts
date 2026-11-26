import { constants, promises as fs, watch, type FSWatcher } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../../types/index.js';

import type { NativeUsageIndex } from './native-usage-index.js';

type Usage = { input: number; output: number; cached?: number; reasoning?: number; cacheCreated?: number };
type TodoBody = { args: string; result: string };
type TodoReceipt = { plan: string; status?: 'success' | 'failure'; body?: TodoBody };
type Turn = {
  reply: string; session: string; trace: string; tools: Set<string>; reports: Map<number, Usage>;
  timings: Map<string, { start: number; first: number } | null>;
  todos: Map<string, TodoReceipt | null>;
  plans: Map<string, { seq: number; content: string; call?: string }>;
  lastSeq: number; contiguous: boolean; done: boolean; touched: number;
  model?: string; displayModel?: string; promptMaxTokens?: number;
};
type Cursor = { handle: FileHandle; offset: number; skipping: boolean; turn?: Turn };
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const HUB_PREFIX = 'agent.trae-cn.hub.';
const windowSize = 4 * 1024 * 1024;

// A confirmed commit includes one result per dispatched call. Its timestamp is
// the batch acknowledgement, not a measured tool execution end.
function todoEvents(entry: AgentActivityEntry, todo: {call: string; start: string; committedAt: string}, status?: TodoReceipt['status'], body?: TodoBody) {
  const key = [entry.trace_id, 'TodoWrite', todo.call].join('/');
  const digest = (suffix: string) => createHash('sha256').update(key + suffix).digest('hex');
  const base = {
    trace_id: entry.trace_id, span_id: digest('/span').slice(0, 16), parent_span_id: entry.parent_span_id,
    'gen_ai.turn.id': entry['gen_ai.turn.id'], 'gen_ai.step.id': entry['gen_ai.step.id'],
    'gen_ai.session.id': entry['gen_ai.session.id'], 'gen_ai.provider.name': entry['gen_ai.provider.name'],
    'gen_ai.agent.type': entry['gen_ai.agent.type'], 'gen_ai.agent.name': entry['gen_ai.agent.name'],
    'gen_ai.agent.id': entry['gen_ai.agent.id'], 'user.id': entry['user.id'],
    'gen_ai.span.kind': 'TOOL', 'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'TodoWrite', 'gen_ai.tool.call.id': todo.call,
    'agent.trae-cn.tool_timing_source': 'native_start_to_batch_commit',
  };
  return [
    { ...base, 'event.name': 'tool.call', 'event.id': digest('/call'), time_unix_nano: todo.start,
      ...(body ? { 'gen_ai.tool.call.arguments': JSON.parse(body.args) } : {}) },
    { ...base, 'event.name': 'tool.result', 'event.id': digest('/result'), time_unix_nano: todo.committedAt,
      ...(status ? { 'tool.result.status': status } : {}),
      ...(status === 'failure' ? { 'error.type': 'tool_use_failure' } : {}),
      ...(body ? { 'gen_ai.tool.call.result': JSON.parse(body.result) } : {}) },
  ] satisfies AgentActivityEntry[];
}

// The producer unlinks the cache at completion. Keep its descriptor through the
// final drain, and retain only IDs and numeric observations after parsing.
export class HubUsage {
  private readonly files = new Map<string, Cursor>();
  private readonly turns = new Map<string, Turn>();
  private watcher?: FSWatcher;
  private pending?: Promise<void>;
  private dirty = false;

  constructor(private readonly root: string, private readonly captureContent = false) {}

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
            cursor.turn = { reply, session: meta.session_id, trace: meta.trace_id, tools: new Set(), reports: new Map(), plans: new Map(), todos: new Map(), timings: new Map(),
              lastSeq: row.seq - 1, contiguous: row.seq === 0 || row.seq === 1, done: false, touched: Date.now() };
            // model_info is optional per cache producer version; only bounded
            // strings/counts are kept so a malformed payload cannot poison the turn.
            const modelInfo = meta.model_info;
            if (modelInfo && typeof modelInfo === 'object') {
              if (typeof modelInfo.model_name === 'string' && modelInfo.model_name.length > 0 && modelInfo.model_name.length <= 128) {
                cursor.turn.model = modelInfo.model_name;
              }
              if (typeof modelInfo.display_model_name === 'string' && modelInfo.display_model_name.length > 0 && modelInfo.display_model_name.length <= 128) {
                cursor.turn.displayModel = modelInfo.display_model_name;
              }
              if (count(modelInfo.prompt_max_tokens) && modelInfo.prompt_max_tokens > 0) {
                cursor.turn.promptMaxTokens = modelInfo.prompt_max_tokens;
              }
            }
            this.turns.set(reply, cursor.turn);
          }
          const turn = cursor.turn;
          if (!turn) continue;
          turn.touched = Date.now();
          if (!count(row.seq) || row.seq !== turn.lastSeq + 1) turn.contiguous = false;
          turn.lastSeq = row.seq;
          if (!['done', 'plan_item', 'token_usage', 'timing_events'].includes(row.type)) continue;
          const d = JSON.parse(row.data);
          if (d.reply_to_message_id !== reply) { turn.contiguous = false; continue; }
          if (row.type === 'timing_events' && typeof d.logid === 'string' && d.logid.length > 0 && d.logid.length <= 128) {
            const start = d.data?.rs_17_before_request_llm;
            const first = d.data?.rs_18_llm_response_first_token;
            if (count(start) && start > 0 && count(first) && first >= start) {
              const prior = turn.timings.get(d.logid);
              if (prior === undefined) turn.timings.set(d.logid, { start, first });
              else if (prior && (prior.start !== start || prior.first !== first)) turn.timings.set(d.logid, null);
            }
          }
          if (row.type === 'done') turn.done = true;
          if (row.type === 'plan_item') {
            const id = d.tool_call_info?.meta?.llm_toolcall_id;
            const call = typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : undefined;
            if (call) turn.tools.add(call);
            const info = d.tool_call_info;
            if (call && typeof d.id === 'string' && info?.name === 'TodoWrite' &&
                info.result?.status && (turn.todos.has(call) || turn.todos.size < 256)) {
              const status = info.result.status === 'success' ? 'success' :
                info.result.status === 'error' || info.result.status === 'failure' ? 'failure' : undefined;
              const prior = turn.todos.get(call);
              let body: TodoBody | undefined;
              if (this.captureContent && info.params) {
                const args = JSON.stringify(info.params);
                const result = JSON.stringify(info.result.data ?? info.result);
                if (args.length + result.length <= 64000) body = { args, result };
              }
              if (prior === undefined) turn.todos.set(call, { plan: d.id, status, body });
              else if (prior && (prior.plan !== d.id || (prior.status && status && prior.status !== status) ||
                  (prior.body && body && prior.body.args !== body.args))) turn.todos.set(call, null);
              else if (prior) {
                prior.status ??= status;
                prior.body ??= body;
              }
            }
            // The client replaces a plan item's reasoning on updates. A single
            // snapshot may precede dispatch, and later snapshots may omit text.
            if (this.captureContent && typeof d.id === 'string' && d.id.length <= 128 && count(row.seq)) {
              const previous = turn.plans.get(d.id);
              if ((!previous || row.seq > previous.seq) && (previous || turn.plans.size < 256)) {
                const content = typeof d.reasoning_content === 'string'
                  ? d.reasoning_content.slice(0, 32000) : previous?.content;
                if (content !== undefined) turn.plans.set(d.id, { seq: row.seq, content, call: call ?? previous?.call });
              }
            }
          }
          if (row.type === 'token_usage') {
            if (!count(d.prompt_tokens) || !count(d.completion_tokens) || !count(row.seq) ||
                d.prompt_tokens + d.completion_tokens !== d.total_tokens) { turn.contiguous = false; continue; }
            const cached = d.cache_read_input_tokens ?? d.prompt_tokens_details?.cached_tokens;
            turn.reports.set(row.seq, { input: d.prompt_tokens, output: d.completion_tokens,
              reasoning: count(d.reasoning_tokens) && d.reasoning_tokens <= d.completion_tokens ? d.reasoning_tokens : undefined,
              cacheCreated: count(d.cache_creation_input_tokens) && d.cache_creation_input_tokens <= d.prompt_tokens ? d.cache_creation_input_tokens : undefined,
              cached: count(cached) && cached <= d.prompt_tokens ? cached : undefined });
          }
        } catch { if (cursor.turn) cursor.turn.contiguous = false; }
      }
    }
  }

  enrich(entry: AgentActivityEntry, native?: Pick<NativeUsageIndex, 'complete' | 'responses' | 'expectedSeqs'> & Partial<Pick<NativeUsageIndex, 'ownsTool'>>) {
    if (entry['event.name'] !== 'llm.response') return;
    const ids = new Set<string>();
    const toolCallIds = entry['agent.trae-cn.tool_call_ids'];
    delete entry['agent.trae-cn.tool_call_ids'];
    if (Array.isArray(toolCallIds)) for (const id of toolCallIds) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 256) ids.add(id);
    }
    // Existing spool records can still use message parts for the same join.
    const messages = entry['gen_ai.output.messages'];
    if (Array.isArray(messages)) for (const msg of messages) {
      if (msg && typeof msg === 'object' && 'parts' in msg && Array.isArray(msg.parts)) {
        for (const p of msg.parts) if (p && typeof p === 'object' && 'type' in p && p.type === 'tool_call' && typeof p.id === 'string') ids.add(p.id);
      }
    }
    const matches = [...this.turns.values()].filter(t => t.session === entry['gen_ai.session.id'] &&
      ([...ids].some(id => t.tools.has(id)) || native?.ownsTool?.(t.trace, t.session, t.reply, ids)));
    const turn = matches.length === 1 ? matches[0] : undefined;
    const evidence = native?.responses(entry['gen_ai.session.id'], ids, turn);
    const rounds = evidence?.rounds;

    // Backfill the model identity from the cache. The hook payload has no
    // model field, so this is the only source that reflects what actually
    // served the turn. A precise turn match wins; otherwise fall back to the
    // session only when every observed turn in that session agrees.
    const hookModel = entry['gen_ai.request.model'];
    if (typeof hookModel !== 'string' || hookModel.length === 0 || hookModel === 'unknown') {
      const apply = (t: Turn) => {
        if (t.model) entry['gen_ai.request.model'] = t.model;
        if (t.displayModel) entry[HUB_PREFIX + 'display_model'] ??= t.displayModel;
        if (t.promptMaxTokens) entry[HUB_PREFIX + 'prompt_max_tokens'] ??= t.promptMaxTokens;
      };
      if (turn) apply(turn);
      else {
        const models = new Set<string>();
        for (const t of this.turns.values()) {
          if (t.session === entry['gen_ai.session.id'] && t.model) models.add(t.model);
        }
        if (models.size === 1) {
          const observed = [...this.turns.values()].find(t => t.session === entry['gen_ai.session.id'] && t.model)!;
          apply(observed);
        }
      }
    }
    const recovered: AgentActivityEntry[] = [];
    const recoveredCalls = [];
    for (const round of rounds ?? []) {
      if (!('todos' in round) || !round.todos || !entry.trace_id || !entry.parent_span_id) continue;
      for (const todo of round.todos) {
        if (ids.has(todo.call)) continue;
        ids.add(todo.call);
        const receipt = evidence?.matchesHubOwner ? turn?.todos.get(todo.call) : undefined;
        const body = Array.isArray(messages) ? receipt?.body : undefined;
        recovered.push(...todoEvents(entry, todo, receipt?.status, body));
        if (this.captureContent && Array.isArray(messages)) {
          recoveredCalls.push({ type: 'tool_call', name: 'TodoWrite', id: todo.call,
            ...(body ? { arguments: JSON.parse(body.args) } : {}) });
        }
      }
    }
    if (Array.isArray(messages) && recoveredCalls.length) {
      const finalAnswer = messages.findIndex(message => message && typeof message === 'object' &&
        !Array.isArray(message) && message.role === 'assistant' && Array.isArray(message.parts) &&
        message.parts.some(part => part && typeof part === 'object' && !Array.isArray(part) && part.type === 'text'));
      messages.splice(finalAnswer < 0 ? messages.length : finalAnswer, 0, { role: 'assistant', parts: recoveredCalls });
    }
    if (rounds) entry['loongsuite.trae_cn.model_responses'] = rounds;
    if (!turn || evidence?.matchesHubOwner === false) {
      // No cache turn was ever observed for this response. Because a cache
      // file lives for the whole turn, a resident watcher would have drained
      // it; absence therefore means the producer never created one (route
      // not bound to the EventCache), not that collection missed it.
      entry[HUB_PREFIX + 'usage_source'] ??= 'unavailable';
      return recovered;
    }
    if (this.captureContent && Array.isArray(messages)) {
      const parts = [...turn.plans].filter(([, plan]) => plan.content).map(([id, plan]) => ({
        type: 'reasoning', content: plan.content, plan_item_id: id,
        ...(plan.call && ids.has(plan.call) ? { tool_call_id: plan.call } : {}),
      }));
      if (parts.length) entry['gen_ai.output.messages'] = [{ role: 'assistant', parts }, ...messages];
    }
    if (rounds) entry['loongsuite.trae_cn.model_responses'] = rounds.map(round => {
      // Later requests can repeat the initial timing pair under another logid.
      const firstTiming = 'initial' in round && round.initial && round.request ? turn.timings.get(round.request) : undefined;
      const timed = firstTiming ? { ...round, requestStartMs: firstTiming.start, firstTokenMs: firstTiming.first } : round;
      if ('streamReports' in round && round.streamReports) {
        const reports = round.streamReports.filter(r => r.reply === turn.reply && turn.reports.has(r.seq));
        return { ...timed, streamReceived: reports.length,
          streamExpected: round.streamReports.length,
          streamTokens: reports.reduce((total, r) => {
            const usage = turn.reports.get(r.seq)!;
            return total + usage.input + usage.output;
          }, 0) };
      }
      const report = 'reply' in round && round.reply === turn.reply && round.seq !== undefined ? turn.reports.get(round.seq) : undefined;
      return report ? { ...timed, input: report.input, output: report.output,
        ...(report.cached !== undefined ? { cached: report.cached } : {}),
        ...(report.reasoning !== undefined ? { reasoning: report.reasoning } : {}),
        ...(report.cacheCreated !== undefined ? { cacheCreated: report.cacheCreated } : {}) } : timed;
    });
    let input = 0, output = 0, cached = 0, allCached = true;
    for (const r of turn.reports.values()) {
      input += r.input; output += r.output;
      if (r.cached === undefined) allCached = false;
      else cached += r.cached;
    }
    const prefix = HUB_PREFIX;
    entry[prefix + 'trace_id'] = turn.trace;
    entry[prefix + 'usage_event_seqs'] = [...turn.reports.keys()].join(',');
    const expected = native?.expectedSeqs(turn.trace, turn.session, turn.reply);
    entry[prefix + 'usage_received'] = turn.reports.size;
    // A matched cache turn that carries no token_usage rows means the producer
    // wrote one but never reported counters — distinct from no file at all.
    entry[prefix + 'usage_source'] ??= turn.reports.size ? 'hub' : 'hub_empty';
    if (expected) {
      entry[prefix + 'usage_expected'] = expected.size;
      entry[prefix + 'missing_usage_seqs'] = [...expected].filter(seq => !turn.reports.has(seq)).join(',');
    }
    const complete = expected ? native!.complete(turn.trace, turn.session, turn.reply, turn.reports) : (turn.contiguous && turn.done) || native?.complete(turn.trace, turn.session, turn.reply, turn.reports) === true;
    entry[prefix + 'complete'] = complete;
    if (!turn.reports.size) return recovered;
    entry[prefix + 'total_tokens_observed'] = input + output;
    entry[prefix + 'input_tokens_observed'] = input;
    entry[prefix + 'output_tokens_observed'] = output;
    if (allCached) {
      entry[prefix + 'cached_tokens_observed'] = cached;
      if (input > 0) entry[prefix + 'cache_hit_ratio_observed'] = cached / input;
    }
    if (!complete || !turn.reports.size) return recovered;
    // Hook fields can arrive independently. Combine sources only when the
    // counters they both report describe the same usage.
    const reports = [...turn.reports.values()];
    const counts = {
      'gen_ai.usage.input_tokens': input,
      'gen_ai.usage.output_tokens': output,
      'gen_ai.usage.total_tokens': input + output,
      ...(allCached ? { 'gen_ai.usage.cache_read.input_tokens': cached } : {}),
      ...(reports.every(r => r.reasoning !== undefined) ? {
        'gen_ai.usage.reasoning_tokens': reports.reduce((n, r) => n + r.reasoning!, 0),
      } : {}),
      ...(reports.every(r => r.cacheCreated !== undefined) ? {
        'gen_ai.usage.cache_creation.input_tokens': reports.reduce((n, r) => n + r.cacheCreated!, 0),
      } : {}),
    };
    if (Object.entries(counts).some(([key, value]) => entry[key] != null && entry[key] !== value)) return recovered;
    for (const [key, value] of Object.entries(counts)) entry[key] ??= value;
    return recovered;
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
