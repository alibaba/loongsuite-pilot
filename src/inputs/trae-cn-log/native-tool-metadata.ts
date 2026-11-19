import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { createHash } from 'node:crypto';
import cbor from 'cbor';
import type { StateStore } from '../../checkpoints/state-store.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { ClientType, type AgentActivityEntry } from '../../types/index.js';
import { fileIdentity } from '../../utils/file-identity.js';

type Delegation = { parent: string; call: string; start?: string; end?: string; child?: string };
type Turn = { session: string; turn: string; start: string; calls: string[]; delegations?: Delegation[] };
type Turns = Record<string, Turn>;
const spanId = (trace: string, id: string) => createHash('sha256').update(trace + '/' + id).digest('hex').slice(0, 16);
const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString('utf8') : '';
const hexId = /^[a-f0-9]{24}$/;

const commit = 'async subagent commit metadata';
const launch = 'starting SubAgent through commit_results';
const takeover = '[subagent→parent] detected parent takeover, returning stream';
const runId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function nativeMetadata(record: any, turns: Turns, entries: AgentActivityEntry[]): void {
  const fields = record?.fields;
  if (!fields) return;
  const message = text(fields.message);
  if (message !== 'context resolve applied to task request' && message !== 'tool execution started' &&
      message !== commit && message !== launch && message !== takeover &&
      message !== 'terminal Turn and Inbox transaction committed' && message !== 'chat: runner completed') return;
  const trace = text(fields.trace_id);
  if (!/^[a-f0-9]{32}$/.test(trace)) return;
  const date = record.time;
  if (!Array.isArray(date) || date.length !== 9 || !date.every(Number.isInteger)) return;
  const [year, day, hour, minute, second, nano, oh, om, os] = date;
  const ms = Date.UTC(year, 0, day, hour - oh, minute - om, second - os);
  if (!Number.isFinite(ms) || nano < 0 || nano >= 1e9) return;
  const time = String(BigInt(ms) * 1000000n + BigInt(nano));
  const turnId = text(fields.turn_id);
  if (message === 'context resolve applied to task request') {
    const session = text(fields.session_id);
    if (hexId.test(session) && hexId.test(turnId)) turns[trace] ??= { session, turn: turnId, start: time, calls: [] };
    return;
  }
  const turn = turns[trace];
  if (!turn) return;
  const root = spanId(trace, turn.turn);
  const base = {
    trace_id: trace, time_unix_nano: time, endTimeUnixNano: time,
    'gen_ai.session.id': turn.session, 'gen_ai.turn.id': turn.turn,
    'gen_ai.agent.type': ClientType.TraeCn, 'gen_ai.agent.name': 'trae-cn',
    'gen_ai.system': 'trae', 'agent.trae-cn.source': 'native_metadata',
  };
  if (message === commit) {
    const parent = text(fields.parent_agent_run_id);
    const call = text(fields.toolcall_id);
    if (text(fields.conversation_id) !== turn.session || text(fields.parent_turn_id) !== turn.turn ||
        text(fields.toolcall_name) !== 'Task' || text(fields.async_action) !== 'run_sub_agent' ||
        text(fields.phase) !== 'submit_subagent_initial_commit' || !runId.test(parent) ||
        !/^[\w.:-]{1,256}$/.test(call)) return;
    const delegations = turn.delegations ??= [];
    if (!delegations.some(d => d.call === call)) {
      const child = text(fields.subagent_agent_run_id);
      delegations.push({ parent, call, ...(runId.test(child) ? { child } : {}) });
    }
    return;
  }
  if (message === launch || message === takeover) {
    const returning = message === takeover;
    const parent = text(returning ? fields.new_agent_run_id : fields.agent_run_id);
    const call = text(returning ? fields.new_task_id : fields.toolcall_id);
    const delegation = turn.delegations?.find(d => d.parent === parent && d.call === call);
    if (!delegation) return;
    if (!returning) delegation.start ??= time;
    else if (delegation.start && runId.test(text(fields.source_agent_run_id))) {
      delegation.child = text(fields.source_agent_run_id);
      delegation.end ??= time;
    }
    return;
  }
  if (message === 'tool execution started') {
    const call = text(fields.toolcall_id), tool = text(fields.tool_name);
    if (!/^[\w.:-]{1,256}$/.test(call) || !/^[\w.-]{1,128}$/.test(tool) || turn.calls.includes(call)) return;
    turn.calls.push(call);
    const id = spanId(trace, call);
    entries.push(buildAgentActivityEntry({ ...base, 'event.id': id, 'event.name': 'tool.call', span_id: id,
      parent_span_id: root, startTimeUnixNano: time, 'gen_ai.span.kind': 'TOOL',
      'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': call, 'gen_ai.tool.name': tool }));
    return;
  }
  if (turn.turn !== turnId) return;
  const parents = new Set<string>();
  for (const delegation of turn.delegations ?? []) {
    if (!delegation.start) continue;
    const parentId = spanId(trace, 'agent-run/' + delegation.parent);
    if (!parents.has(parentId)) {
      parents.add(parentId);
      entries.push(buildAgentActivityEntry({ ...base, 'event.id': parentId, 'event.name': 'other',
        span_id: parentId, parent_span_id: root, startTimeUnixNano: turn.start,
        'gen_ai.span.kind': 'AGENT', 'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.invocation.id': delegation.parent }));
    }
    const id = spanId(trace, 'delegation/' + delegation.call);
    entries.push(buildAgentActivityEntry({ ...base, 'event.id': id, 'event.name': 'other',
      span_id: id, parent_span_id: parentId, startTimeUnixNano: delegation.start,
      endTimeUnixNano: delegation.end ?? delegation.start, 'gen_ai.span.kind': 'AGENT',
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'subagent', 'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.parent.invocation.id': delegation.parent, 'gen_ai.subagent.parent_tool_call.id': delegation.call,
      ...(delegation.child ? { 'gen_ai.agent.invocation.id': delegation.child } : {}) }));
  }
  delete turns[trace];
  entries.push(buildAgentActivityEntry({ ...base, 'event.id': root, 'event.name': 'other', span_id: root,
    startTimeUnixNano: turn.start, 'gen_ai.span.kind': 'ENTRY', 'gen_ai.turn.end': true,
    'gen_ai.operation.name': 'enter_ai_application_system' }));
}

// A live AALG file is a raw DEFLATE stream of concatenated CBOR maps. Keep its
// dictionary and incomplete record in memory. On restart replay the compressed
// prefix through the decoder, suppressing events through the saved byte cursor.
class NativeStream {
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

export class NativeToolMetadata {
  private readonly streams = new Map<string, NativeStream>();
  constructor(private readonly store: StateStore) {}
  close() {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
  }

  async collect(run: string, entries: AgentActivityEntry[], initialized: boolean): Promise<boolean> {
    const dir = path.join(run, 'Modular');
    const names = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    let supported = false;
    for (const name of names.filter(n => /^ai_agent-\d+-\d{4}-\d\d-\d\d\.alaudalog$/.test(n)).sort()) {
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size < 178) continue;
      const key = 'trae-cn-log:native:' + file;
      const state = this.store.get(key);
      const identity = fileIdentity(stat);
      const same = state.extra?.identity === identity && (state.lastOffset ?? 0) <= stat.size;
      if (same && state.lastOffset === stat.size) { supported = true; continue; }
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(178);
        if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length ||
            header.toString('ascii', 0, 4) !== 'AalG' || header.toString('ascii', 8, 12) !== 'Atab' ||
            header.readUInt32LE(16) !== 152 || header.toString('ascii', 152, 156) !== 'AALG' ||
            header.readUInt32LE(156) !== 65536) continue;
        const start = 172 + header.readUInt32LE(168);
        if (start > stat.size || start > 1024) continue;
        supported = true;
        if (!initialized && !same) {
          this.store.update(key, { lastOffset: stat.size, extra: { identity } });
          continue;
        }
        const committed = same ? state.lastOffset ?? start : start;
        let stream = this.streams.get(file);
        if (!stream || stream.identity !== identity || stream.offset > committed) {
          stream?.close();
          stream = new NativeStream(identity, start);
          this.streams.set(file, stream);
        }
        const turnKey = 'trae-cn-log:native-turns:' + run;
        const turns: Turns = structuredClone(this.store.get(turnKey).extra?.turns ?? {}) as Turns;
        const batch: AgentActivityEntry[] = [];
        const buffer = Buffer.allocUnsafe(256 * 1024);
        while (stream.offset < stat.size) {
          const replay = stream.offset < committed;
          const end = replay ? committed : stat.size;
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - stream.offset), stream.offset);
          if (!bytesRead) break;
          stream.visitor = replay ? undefined : record => {
            nativeMetadata(record, turns, batch);
          };
          await stream.feed(buffer.subarray(0, bytesRead));
        }
        stream.visitor = undefined;
        this.store.update(turnKey, { extra: { turns } });
        this.store.update(key, { lastOffset: stream.offset, extra: { identity } });
        entries.push(...batch);
      } catch (err) {
        this.streams.get(file)?.close();
        this.streams.delete(file);
        throw err;
      } finally { await handle.close(); }
    }
    return supported;
  }
}
