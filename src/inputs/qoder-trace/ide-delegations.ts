import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { queryReadonly } from '../../utils/node-sqlite.js';
import { resolveAllQoderDbPaths, isIdeaDbPath, parseTokenInfo, parseModelKey, parseRecordModelKey } from './sqlite-token-reader.js';
import { buildLlmBoundaries, buildEventsFromBoundaries } from '../../../assets/hooks/qoder-hook-processor.mjs';

type RecordData = Record<string, any>;
export const QODER_NATIVE_SOURCE = Symbol.for('loongsuite.qoder.native-source');
const MAX_WORK = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 256;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
const nano = (at: number) => String(BigInt(Math.trunc(at)) * 1_000_000n);

interface Work {
  id: string; session: string; turn: string; call: string; trace: string; span: string;
  file: string; cwd?: string; at: number; done?: boolean; invoke?: boolean; result?: boolean;
  peer?: string; request?: string;
  search?: { nextIndex: number };
  actor?: string;
  incoming?: Record<string, string>;
}
export interface IdeMessage {
  id: string; role: string; gmt_create: number; tool_call_id?: string;
  token_info?: string; model_info?: string; record_extra?: string;
}
export interface IdeDelegation {
  session: string; request: string; messages: IdeMessage[];
  tokens: Array<{ messageId?: string; gmtCreate: number; model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
}

/** Only native relationship/usage metadata is queried. Encrypted bodies stay untouched. */
export async function readIdeDelegation(session: string, call: string, search = { nextIndex: 0 }): Promise<IdeDelegation | null> {
  const paths = resolveAllQoderDbPaths().filter(file => !isIdeaDbPath(file)).sort();
  const start = Number.isSafeInteger(search.nextIndex) && search.nextIndex >= 0 ? search.nextIndex : 0;
  for (let i = 0; i < Math.min(paths.length, 4); i++) {
    const index = (start + i) % paths.length; const file = paths[index]!;
    search.nextIndex = (index + 1) % paths.length;
    try {
      const matches = await queryReadonly<{ session_id: string; request_id: string }>(file,
        `SELECT session_id,request_id FROM chat_record WHERE parent_session_id=? AND parent_tool_call_id=? LIMIT 2`, [session, call]);
      if (!matches.length) continue;
      if (matches.length !== 1 || !id(matches[0]!.session_id) || matches[0]!.session_id === session || !id(matches[0]!.request_id)) return null;
      const peer = matches[0]!;
      const messages = await queryReadonly<IdeMessage>(file,
        `SELECT cm.id,cm.role,cm.gmt_create,cm.token_info,cm.model_info,cr.extra AS record_extra,
         CASE WHEN json_valid(cm.tool_result) THEN json_extract(cm.tool_result,'$.toolCallId') END AS tool_call_id
         FROM chat_message cm JOIN chat_record cr ON cr.request_id=cm.request_id
         WHERE cm.session_id=? AND cm.request_id=? ORDER BY cm.rowid LIMIT 257`, [peer.session_id, peer.request_id]);
      if (!messages.length || messages.length > MAX_MESSAGES || messages.some(row => !id(row.id) || !Number.isFinite(Number(row.gmt_create)))) return null;
      const tokens = messages.flatMap(row => {
        if (row.role !== 'assistant' || !row.token_info || row.token_info.length > 16384) return [];
        const usage = parseTokenInfo(row.token_info);
        return usage ? [{ messageId: row.id, gmtCreate: Number(row.gmt_create),
          model: parseModelKey(row.model_info) ?? parseRecordModelKey(row.record_extra),
          inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, cacheReadTokens: usage.cachedTokens }] : [];
      });
      return { session: peer.session_id, request: peer.request_id, messages, tokens };
    } catch { /* Schema absent, transient DB failures and older IDEs remain retryable. */ }
  }
  return null;
}

/** IDE sessions are siblings, not CLI sidechains. Correlation is per native request. */
export class QoderIdeDelegations {
  private retry = new Map<string, number>();
  private cursor = 0;
  constructor(private readonly resolve = readIdeDelegation,
    private readonly warn: (reason: string) => void = () => {}) {}

  async collect(input: RecordData[], saved: unknown): Promise<{ records: RecordData[]; state: Record<string, Work>; changed: boolean }> {
    const now = Date.now();
    const state: Record<string, Work> = {};
    if (saved && typeof saved === 'object') for (const [key, value] of Object.entries(saved).slice(-MAX_WORK)) {
      const work = value as Work;
      if (work?.id === key && /^[0-9a-f]{32}$/.test(key) && id(work.session) && id(work.call)
        && typeof work.turn === 'string' && work.turn.length > 0
        && /^[0-9a-f]{32}$/.test(work.trace) && !/^0+$/.test(work.trace)
        && /^[0-9a-f]{16}$/.test(work.span) && !/^0+$/.test(work.span)
        && typeof work.file === 'string' && path.isAbsolute(work.file)
        && Number.isFinite(work.at) && now - work.at < MAX_AGE) state[key] = { ...work, ...(work.search ? { search: { ...work.search } } : {}) };
    }
    const before = JSON.stringify(saved ?? {});
    const emitted: RecordData[] = [];
    const available = [...input];
    let bytes = 0;
    const read = async (file: string): Promise<RecordData[]> => {
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES - bytes) throw new Error('IDE transcript byte budget');
        bytes += stat.size;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) throw new Error('IDE transcript truncated');
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('IDE transcript changed');
        const data = buffer.toString('utf8');
        if (data && !data.endsWith('\n')) throw new Error('IDE partial transcript');
        return data.split('\n').filter(Boolean).map(line => JSON.parse(line));
      } finally { await handle.close(); }
    };
    const register = (records: RecordData[]) => {
      for (const record of records) {
        if (record['event.name'] !== 'tool.call' || record['gen_ai.agent.type'] !== 'qoder' || record['gen_ai.tool.name'] !== 'Agent') continue;
        const file = (record as any)[QODER_NATIVE_SOURCE];
        const session = record['gen_ai.session.id']; const turn = record['gen_ai.turn.id']; const call = record['gen_ai.tool.call.id'];
        if (!id(session) || !id(call) || typeof turn !== 'string' || typeof file !== 'string'
          || path.basename(path.dirname(file)) !== 'transcript' || path.basename(file) !== `${session}.jsonl`
          || !/^[0-9a-f]{32}$/.test(record.trace_id ?? '')) continue;
        const key = hash(['qoder-ide-delegation', session, turn, call]).slice(0, 32);
        if (!state[key]) {
          if (Object.keys(state).length >= MAX_WORK) {
            const finished = Object.values(state).find(work => work.done && work.result);
            if (!finished) { this.warn('ide-delegation-capacity'); continue; }
            delete state[finished.id];
          }
          state[key] = { id: key, session, turn, call, trace: record.trace_id,
            span: hash(['qoder-tool', session, turn, call]).slice(0, 16), file,
            cwd: record['agent.qoder.cwd'], at: now,
            ...(typeof record['user.id'] === 'string' ? { actor: record['user.id'] } : {}),
            incoming: Object.fromEntries(['gen_ai.agent.scope', 'gen_ai.agent.name', 'gen_ai.agent.parent.id',
              'gen_ai.agent.parent.invocation.id', 'gen_ai.subagent.parent_tool_call.id', 'agent.qoder.parent_turn_id', 'parent_span_id']
              .filter(key => typeof record[key] === 'string' && record[key].length <= 512).map(key => [key, record[key]])),
          };
        }
      }
    };
    register(input);
    let handled = 0;
    const keys = Object.keys(state);
    const start = keys.length ? this.cursor % keys.length : 0;
    const queue = [...keys.slice(start), ...keys.slice(0, start)];
    for (let index = 0; index < queue.length && handled < 8; index++) {
      const work = state[queue[index]!]!;
      const current = available.filter(record => record['gen_ai.session.id'] === work.session
        && record['gen_ai.turn.id'] === work.turn && record['gen_ai.tool.call.id'] === work.call);
      if (!current.length && (this.retry.get(work.id) ?? 0) > now) continue;
      if (work.done && work.result) continue;
      handled++;
      this.cursor = (keys.indexOf(work.id) + 1) % Math.max(1, keys.length);
      try {
        let call = current.find(record => record['event.name'] === 'tool.call');
        let result = current.find(record => record['event.name'] === 'tool.result');
        if (!call || (!result && !work.done)) {
          const parent = await read(work.file);
          for (const row of parent) for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
            if (!call && block.type === 'tool_use' && block.name === 'Agent' && block.id === work.call) call = {
              'gen_ai.tool.call.arguments': block.input, 'gen_ai.tool.name': 'Agent', time_unix_nano: nano(Date.parse(row.timestamp)),
            };
            if (!result && block.type === 'tool_result' && block.tool_use_id === work.call) result = {
              'gen_ai.tool.call.result': block.content, 'tool.result.status': block.is_error ? 'error' : 'success',
              time_unix_nano: nano(Date.parse(row.timestamp)),
            };
          }
        }
        if (!call) { this.warn('ide-delegation-parent-unavailable'); continue; }
        const peer = await this.resolve(work.session, work.call, work.search ??= { nextIndex: 0 });
        // An IDE path/Agent nickname alone is not a relationship. In particular,
        // do not enable this adapter for JetBrains or missing native evidence.
        if (!peer || peer.session === work.session) continue;
        work.peer = peer.session; work.request = peer.request;
        const identity = { 'gen_ai.agent.id': work.session, 'gen_ai.agent.invocation.id': work.id,
          ...(work.peer ? { 'gen_ai.agent.peer.id': work.peer } : {}),
          ...(call['gen_ai.tool.call.arguments']?.subagent_type ? { 'gen_ai.agent.peer.name': call['gen_ai.tool.call.arguments'].subagent_type } : {}) };
        for (const record of current) Object.assign(record, identity, { span_id: work.span });
        const base = { ...work.incoming, ...(work.actor ? { 'user.id': work.actor } : {}), ...call, ...identity, 'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': work.session, 'gen_ai.turn.id': work.turn, trace_id: work.trace,
          'gen_ai.tool.call.id': work.call, 'gen_ai.tool.name': 'Agent',
          ...(work.cwd ? { 'agent.qoder.cwd': work.cwd } : {}) };
        const audit = (name: string, source: RecordData): RecordData => {
          const event: RecordData = { ...base, ...source, ...identity, 'event.name': name, 'event.id': hash([work.id, name]) };
          for (const key of ['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.turn.start', 'gen_ai.turn.end', 'span_id']) delete event[key];
          return event;
        };
        if (!work.invoke) {
          const event = audit('gen_ai.agent.invoke', {});
          const prompt = call['gen_ai.tool.call.arguments']?.prompt;
          if (typeof prompt === 'string') event['gen_ai.input.messages'] = [{ role: 'user', parts: [{ type: 'text', content: prompt }] }];
          emitted.push(event); work.invoke = true;
        }
        // IDE 1.37 returns foreground Agent results as tool_result text. Never
        // treat run_in_background/async receipts as delivered Agent results.
        const delivered = result && call['gen_ai.tool.call.arguments']?.run_in_background !== true
          && call['gen_ai.tool.call.arguments']?.async !== true;
        if (delivered && result && !work.result) {
          const event = audit('gen_ai.agent.result', result);
          const body = result['gen_ai.tool.call.result'];
          if (typeof body === 'string') event['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: body }] }];
          emitted.push(event); work.result = true;
        }
        if (!peer || work.done || !delivered) continue;
        const childPath = path.join(path.dirname(work.file), `${peer.session}.jsonl`);
        const directory = await fs.realpath(path.dirname(work.file));
        if (path.dirname(await fs.realpath(childPath)) !== directory) throw new Error('IDE child path escapes transcript directory');
        const native = await read(childPath);
        const records = this.buildChild(work, peer, native, call, base, result);
        if (!records) continue;
        emitted.push(...records); available.push(...records); work.done = true;
        const oldKeys = new Set(Object.keys(state)); register(records);
        queue.push(...Object.keys(state).filter(key => !oldKeys.has(key)));
      } catch { this.warn('ide-delegation-source-pending'); }
      finally {
        this.retry.set(work.id, now + 5000);
        if (this.retry.size > MAX_WORK) this.retry.delete(this.retry.keys().next().value!);
      }
    }
    return { records: emitted, state, changed: JSON.stringify(state) !== before };
  }

  private buildChild(work: Work, peer: IdeDelegation, native: RecordData[], call: RecordData, base: RecordData, result?: RecordData): RecordData[] | null {
    const tools = new Map<string, { call?: RecordData; result?: RecordData }>();
    for (const row of native) {
      if (row.sessionId !== peer.session) return null;
      for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
        const key = block.type === 'tool_use' ? block.id : block.type === 'tool_result' ? block.tool_use_id : null;
        if (!key) continue;
        const value = tools.get(key) ?? {};
        const field = block.type === 'tool_use' ? 'call' : 'result';
        if (value[field]) return null;
        value[field] = { ...row, message: { role: row.message.role, content: [block] } };
        tools.set(key, value);
      }
    }
    const users = peer.messages.filter(row => row.role === 'user');
    const assistants = peer.messages.filter(row => row.role === 'assistant');
    if (users.length !== 1 || !assistants.length || peer.messages.at(-1)?.role !== 'assistant'
      || assistants.some(row => !peer.tokens.some(token => token.messageId === row.id))) return null;
    const prompt = call['gen_ai.tool.call.arguments']?.prompt;
    if (typeof prompt !== 'string' || !prompt) return null;
    const rows: RecordData[] = [{ type: 'user', sessionId: peer.session, uuid: users[0]!.id,
      timestamp: new Date(Number(users[0]!.gmt_create)).toISOString(), message: { role: 'user', content: prompt } }];
    for (let i = 0; i < assistants.length; i++) {
      const message = assistants[i]!; const next = assistants[i + 1];
      // The native request's message ordering owns the model/tool grouping.
      // Exact toolCallId values connect that inventory to transcript bodies.
      const start = peer.messages.indexOf(message) + 1;
      const end = next ? peer.messages.indexOf(next) : peer.messages.length;
      const associated = peer.messages.slice(start, end).filter(row => row.role === 'tool');
      if (associated.some(row => !row.tool_call_id || !tools.get(row.tool_call_id)?.call || !tools.get(row.tool_call_id)?.result)) return null;
      const usage = peer.tokens.find(row => row.messageId === message.id)!;
      const content = associated.flatMap(row => tools.get(row.tool_call_id!)!.call!.message.content);
      rows.push({ type: 'assistant', sessionId: peer.session, uuid: message.id,
        timestamp: new Date(Number(message.gmt_create)).toISOString(), message: { id: message.id, role: 'assistant', model: usage.model,
          content, ...(content.length ? { stop_reason: 'tool_use' } : {}), usage: {
            input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens,
          } } });
      for (const row of associated) rows.push(tools.get(row.tool_call_id!)!.result!);
    }
    const turn = hash(['qoder-ide-request', peer.session, peer.request]);
    const records = buildEventsFromBoundaries(buildLlmBoundaries([], rows), rows, rows, turn, peer.session, 'qoder', {
      userId: base['user.id'], userIdentity: { name: base['user.name'], email: base['user.email'] },
      resourceAttributes: base.resourceAttributes ?? {},
    }, work.cwd);
    // IDE child transcripts omit text-only responses. Their native SQLite
    // assistant IDs/usage still prove the calls. For a successful foreground
    // Agent, the delivered tool result is its final assistant reply. Do not
    // reuse it for intermediate calls, failures or asynchronous receipts.
    const requests = records.filter(record => record['event.name'] === 'llm.request');
    if (requests.length !== assistants.length) return null;
    for (let i = 0; i < assistants.length; i++) {
      const message = assistants[i]!;
      if (records.some(record => record['event.name'] === 'llm.response' && record['gen_ai.response.id'] === message.id)) continue;
      const request = requests[i]!; const usage = peer.tokens.find(row => row.messageId === message.id)!;
      records.splice(records.indexOf(request) + 1, 0, { ...request, 'event.name': 'llm.response',
        'gen_ai.response.id': message.id, ...(usage.model ? { 'gen_ai.response.model': usage.model } : {}),
        'gen_ai.usage.input_tokens': usage.inputTokens, 'gen_ai.usage.output_tokens': usage.outputTokens,
        'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens,
        time_unix_nano: nano(Number(message.gmt_create)), 'agent.source': 'qoder-ide-sqlite-metadata' });
      const response = records[records.indexOf(request) + 1]!;
      delete response['gen_ai.input.messages_delta'];
      const delivered = result?.['gen_ai.tool.call.result'];
      if (i === assistants.length - 1 && result?.['tool.result.status'] === 'success'
        && typeof delivered === 'string' && delivered.length) {
        response['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: delivered }] }];
        response['agent.source'] = 'qoder-ide-agent-result';
      }
    }
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      Object.assign(record, { 'event.id': hash([turn, i, record['event.name'], record['gen_ai.tool.call.id']]),
        trace_id: work.trace, parent_span_id: work.span, 'gen_ai.agent.type': 'qoder',
        'gen_ai.agent.id': peer.session, 'gen_ai.agent.scope': 'subagent', 'gen_ai.agent.parent.id': work.session,
        'agent.qoder.subagent_id': peer.session,
        'gen_ai.agent.parent.invocation.id': work.id, 'gen_ai.subagent.parent_tool_call.id': work.call,
        'agent.qoder.parent_turn_id': work.turn, 'gen_ai.request.id': peer.request, 'agent.request_id': peer.request,
      });
      if (call['gen_ai.tool.call.arguments']?.subagent_type) record['gen_ai.agent.name'] = call['gen_ai.tool.call.arguments'].subagent_type;
      if (record['gen_ai.request.model'] === 'unknown') delete record['gen_ai.request.model'];
      if (record['gen_ai.response.model'] === 'unknown') delete record['gen_ai.response.model'];
      Object.defineProperty(record, QODER_NATIVE_SOURCE, { value: path.join(path.dirname(work.file), `${peer.session}.jsonl`) });
    }
    if (records.length) { records[0]!['gen_ai.turn.start'] = true; records.at(-1)!['gen_ai.turn.end'] = true; }
    return records;
  }
}
