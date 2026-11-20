import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import { readBoundedLineTail } from '../base/bounded-line-tail.js';

import type { AgentActivityEntry } from '../../types/index.js';

const id24 = /^[0-9a-f]{24}$/;
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.:-]{1,256}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

type Tool = { name: string; run: string; start: number; end: number };
type Model = { model: string; start: number; first: number };
class HubTurn {
  readonly tools = new Map<string, Tool>();
  readonly models = new Map<string, Model>();
  readonly usage = new Map<string, { input: number; output: number; cached?: number }>();
  touched = Date.now();
  constructor(readonly trace: string, readonly turn: string, readonly session: string) {}
}

// TRAE removes these JSONL files on completion. Keep only typed metadata in
// memory, including after unlink until the native terminal record is consumed.
export class HubMetadata {
  private files = new Map<string, { ino: number; offset: number; skip: boolean; bound?: HubTurn }>();
  private turns = new Map<string, HubTurn>();
  private watcher?: FSWatcher;
  constructor(readonly root: string) {}

  watchChanges(onChange: () => void) {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, onChange);
      this.watcher.on('error', () => this.close());
    } catch { /* The cache directory may not exist yet. */ }
  }

  close() {
    this.watcher?.close();
    this.watcher = undefined;
  }

  enrichUsage(e: AgentActivityEntry) {
    const turn = this.get(e.trace_id!, e['gen_ai.turn.id']!, e['gen_ai.session.id']);
    const usage = turn?.usage.get(e['agent.trae-cn.reply_id'] + '/' + e['agent.trae-cn.event_seq']);
    e['agent.trae-cn.usage_payload_present'] = !!usage;
    if (usage) {
      e['gen_ai.usage.input_tokens'] = usage.input;
      e['gen_ai.usage.output_tokens'] = usage.output;
      e['gen_ai.usage.total_tokens'] = usage.input + usage.output;
      if (usage.cached !== undefined) e['gen_ai.usage.cache_read.input_tokens'] = usage.cached;
    }
  }

  get(trace: string, turn: string, session: string) {
    const found = this.turns.get(trace);
    return found?.turn === turn && found.session === session ? found : undefined;
  }

  async scan() {
    const seen = new Set<string>();
    const dirs = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs.filter(d => d.isDirectory())) {
      const parent = path.join(this.root, dir.name);
      const names = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
      for (const item of names) {
        if (!item.isFile() || !/^[a-f0-9]{24}\.jsonl$/.test(item.name)) continue;
        const file = path.join(parent, item.name);
        seen.add(file);
        const stat = await fs.lstat(file).catch(() => undefined);
        if (!stat?.isFile()) continue;
        let state = this.files.get(file);
        if (!state || state.ino !== stat.ino || state.offset > stat.size) {
          state = { ino: stat.ino, offset: 0, skip: false };
          this.files.set(file, state);
        }
        if (state.offset === stat.size) continue;
        const tail = await readBoundedLineTail(file, stat, state.offset, state.skip, null);
        if (!tail) continue;
        state.offset = tail.offset;
        state.skip = tail.skippingLine;
        const reply = item.name.slice(0, -6);
        for (const line of tail.text.split('\n')) {
          if (!line) continue;
          let row, data;
          try {
            row = JSON.parse(line);
            if (!['metadata', 'timing_events', 'plan_item', 'token_usage'].includes(row.type)) continue;
            data = JSON.parse(row.data);
          } catch { continue; }
          if (data?.reply_to_message_id !== reply) continue;
          if (row.type === 'metadata') {
            if (typeof data.trace_id !== 'string' || !/^[a-f0-9]{32}$/.test(data.trace_id) ||
                !id24.test(data.turn_id) || !id24.test(data.session_id)) continue;
            const bound = this.turns.get(data.trace_id) ?? new HubTurn(data.trace_id, data.turn_id, data.session_id);
            if (bound.turn !== data.turn_id || bound.session !== data.session_id) continue;
            this.turns.set(bound.trace, bound);
            state.bound = bound;
          }
          const bound = state.bound;
          if (!bound) continue;
          bound.touched = Date.now();
          if (row.type === 'plan_item') {
            const tool = data.tool_call_info, call = tool?.meta?.llm_toolcall_id;
            const start = data.timing?.tool_call_started_at_ms, end = data.timing?.tool_call_finished_at_ms;
            if (identifier(call) && identifier(tool.name) && identifier(data.agent_run_id) &&
                timestamp(start) && timestamp(end) && end >= start) {
              bound.tools.set(call, { name: tool.name, run: data.agent_run_id, start, end });
            }
          } else if (row.type === 'token_usage') {
            const input = data.prompt_tokens, output = data.completion_tokens;
            if (Number.isSafeInteger(row.seq) && row.seq >= 0 && Number.isSafeInteger(input) && input >= 0 &&
                Number.isSafeInteger(output) && output >= 0 && input + output === data.total_tokens) {
              const cached = data.cache_read_input_tokens;
              bound.usage.set(reply + '/' + row.seq, { input, output,
                ...(Number.isSafeInteger(cached) && cached >= 0 && cached <= input ? { cached } : {}) });
            }
          } else if (row.type === 'timing_events') {
            const start = data.data?.rs_17_before_request_llm, first = data.data?.rs_18_llm_response_first_token;
            if (identifier(data.logid) && identifier(data.model_name) && timestamp(start) && timestamp(first) && first >= start) {
              bound.models.set(data.logid, { model: data.model_name, start, first });
            }
          }
        }
      }
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    for (const [trace, turn] of this.turns) if (Date.now() - turn.touched > 3600_000) this.turns.delete(trace);
  }
}
