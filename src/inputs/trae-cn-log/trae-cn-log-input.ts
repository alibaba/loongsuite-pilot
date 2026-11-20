import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseSessionInput, type SessionInputOptions } from '../base/base-session-input.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { NativeToolMetadata } from './native-tool-metadata.js';
import { rendererLogRoot } from './renderer-metadata-input.js';
import { transformHookRecord } from '../base/hook-record-transform.js';

const DEFAULT_HOOK_LOG_DIR = '~/.loongsuite-pilot/logs/trae-cn/history';
const DEFAULT_FILE_PATTERN = 'trae-cn-*.jsonl';
type TraceReference = { trace: string; seen: number };
type TraceIndex = Record<string, TraceReference>;

export interface TraeCnLogInputOptions extends SessionInputOptions {
  auxLogDir?: string;
}

/** Read content-bearing hook records, retaining their span IDs and parent edges. */
export class TraeCnLogInput extends BaseSessionInput {
  readonly id = 'trae-cn-log';
  readonly agentType = ClientType.TraeCn;
  private readonly native = new NativeToolMetadata(this.stateStore);
  private readonly nativeRoot: string;
  private readonly waiting = new Map<string, number>();
  private calls: TraceIndex = {};
  private bindings: TraceIndex = {};
  // Persist only native response metadata until the Hook agent span is bound.
  private rounds: Record<string, { seen: number; events: AgentActivityEntry[] }> = {};
  private parents: Record<string, { seen: number; agent: string; root: string }> = {};
  private hasNative = false;

  constructor(opts?: Partial<TraeCnLogInputOptions> & { stateStore: SessionInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      sessionDir: opts?.sessionDir ?? resolveHome(DEFAULT_HOOK_LOG_DIR),
      filePattern: opts?.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
    this.nativeRoot = opts?.auxLogDir ?? rendererLogRoot();
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_HOOK_LOG_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_HOOK_LOG_DIR)];
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionDir);
    } catch {
      return [];
    }
    const prefix = this.filePattern.replace(/\*.*$/, '');
    const suffix = this.filePattern.replace(/^.*\*/, '');
    const filtered = names.filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
    return filtered.sort().map((n) => path.join(this.sessionDir, n));
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    _filePath: string,
  ): Promise<AgentActivityEntry | null> {
    return transformHookRecord(record, ClientType.TraeCn, 'trae-cn');
  }

  protected override async onStop(): Promise<void> {
    this.native.close();
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const key = this.id + ':trace-bindings';
    const state = this.stateStore.get(key).extra;
    const recent = <T extends { seen: number }>(index: Record<string, T> = {}) => Object.fromEntries(
      Object.entries(index).filter(([, value]) => Date.now() - value.seen < 86400_000));
    this.calls = recent(state?.calls as TraceIndex);
    this.bindings = recent(state?.bindings as TraceIndex);
    this.rounds = recent(state?.rounds as typeof this.rounds);
    this.parents = recent(state?.parents as typeof this.parents);
    const runs = await fs.readdir(this.nativeRoot, { withFileTypes: true }).catch(() => []);
    this.hasNative = false;
    for (const run of runs.filter(r => r.isDirectory() && /^\d{8}T\d{6}$/.test(r.name))) {
      const events: AgentActivityEntry[] = [];
      if (!await this.native.collect(path.join(this.nativeRoot, run.name), events, state?.initialized === true)) continue;
      this.hasNative = true;
      for (const e of events) {
        if (e.trace_id && e['gen_ai.response.id'] && e['gen_ai.span.kind'] === 'LLM') {
          const pending = this.rounds[e.trace_id] ??= { seen: Date.now(), events: [] };
          pending.events.push(e);
          pending.seen = Date.now();
        }
        const call = e['gen_ai.tool.call.id'];
        if (!call || !e.trace_id || !e['gen_ai.session.id']) continue;
        const id = e['gen_ai.session.id'] + '/' + call;
        const previous = this.calls[id];
        this.calls[id] = { trace: previous && previous.trace !== e.trace_id ? '' : e.trace_id, seen: Date.now() };
      }
    }
    const entries = await super.collect();
    for (const [trace, batch] of Object.entries(this.rounds)) {
      const parent = this.parents[trace];
      if (!parent) continue;
      for (const response of batch.events) {
        const history = response['gen_ai.response.id']!;
        const step = createHash('sha256').update(trace + '/history-step/' + history).digest('hex').slice(0, 16);
        entries.push({ ...response, 'event.id': step, 'event.name': 'other', 'gen_ai.operation.name': 'react',
          'gen_ai.span.kind': 'STEP', 'gen_ai.step.id': history, span_id: step, parent_span_id: parent.agent });
        entries.push({ ...response, 'gen_ai.step.id': history, parent_span_id: step });
      }
      delete this.rounds[trace];
    }
    this.stateStore.update(key, { extra: { initialized: true, calls: this.calls, bindings: this.bindings,
      rounds: this.rounds, parents: this.parents } });
    return entries;
  }

  protected override async prepareSessionBatch(entries: AgentActivityEntry[], file: string) {
    const groups = new Map<string, AgentActivityEntry[]>();
    for (const e of entries) {
      if (!e.trace_id) continue;
      const group = groups.get(e.trace_id) ?? [];
      group.push(e);
      groups.set(e.trace_id, group);
    }
    const now = Date.now();
    const since = this.waiting.get(file) ?? now;
    const chosen: TraceIndex = {};
    for (const [hookTrace, group] of groups) {
      const candidates = new Set<string>();
      for (const e of group) {
        const ref = this.calls[e['gen_ai.session.id'] + '/' + e['gen_ai.tool.call.id']];
        if (ref) candidates.add(ref.trace);
      }
      let trace: string | undefined = this.bindings[hookTrace]?.trace;
      // An older checkpoint may start midway through an already exported turn.
      const startsHere = group.some(e => e['gen_ai.span.kind'] === 'ENTRY');
      if (!trace && startsHere && this.hasNative) {
        if (candidates.size === 1) trace = candidates.values().next().value;
        if (!candidates.size && now - since < 60_000 && !group.some(e => e['event.name'] === 'llm.response')) {
          this.waiting.set(file, since);
          return null;
        }
      }
      chosen[hookTrace] = { trace: trace || hookTrace, seen: now };
    }
    this.waiting.delete(file);
    Object.assign(this.bindings, chosen);
    for (const e of entries) {
      if (!e.trace_id) continue;
      const hookTrace = e.trace_id;
      const trace = chosen[hookTrace].trace;
      e.trace_id = trace;
      if (this.hasNative && e['gen_ai.span.kind'] === 'AGENT' && e.span_id && e.parent_span_id) {
        this.parents[trace] = { seen: now, agent: e.span_id, root: e.parent_span_id };
      }
    }
    return entries.flatMap(e => {
      const parent = e.trace_id && this.parents[e.trace_id];
      if (!parent) return [e];
      if (e['gen_ai.span.kind'] === 'STEP') return [];
      if (e['gen_ai.span.kind'] === 'TOOL') {
        delete e['gen_ai.step.id'];
        e.parent_span_id = parent.agent;
      }
      if (e['gen_ai.span.kind'] === 'LLM') {
        // Hook messages describe the entire turn. Retain them on its agent.
        e.span_id = parent.agent;
        e.parent_span_id = parent.root;
        e['gen_ai.span.kind'] = 'AGENT';
        e['gen_ai.operation.name'] = 'invoke_agent';
        e['event.name'] = 'other';
        delete e['gen_ai.response.id'];
        delete e['gen_ai.step.id'];
      }
      return [e];
    });
  }
}
