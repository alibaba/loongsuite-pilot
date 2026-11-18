import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadDatabaseSync, type DatabaseSyncInstance } from '../../utils/node-sqlite.js';
import { resolveAllQoderDbPaths, isIdeaDbPath, parseTokenInfo, parseModelKey, parseRecordModelKey } from './sqlite-token-reader.js';
import { buildLlmBoundaries, buildEventsFromBoundaries } from '../../../assets/hooks/qoder-hook-processor.mjs';
import { NativeToolRowReader, type NativeToolCursor } from './native-tool-rows.js';

type RecordData = Record<string, any>;
export const QODER_NATIVE_SOURCE = Symbol.for('loongsuite.qoder.native-source');
const MAX_WORK = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const MESSAGE_PAGE_SIZE = 32;
const MAX_MESSAGES = 4096;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const INLINE_TOOL_METADATA_BYTES = 256 * 1024;
const MAX_TOOL_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_METADATA_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
const nano = (at: number) => String(BigInt(Math.trunc(at)) * 1_000_000n);

interface Work {
  id: string; session: string; turn: string; call: string; trace: string; span: string;
  file: string; cwd?: string; at: number; done?: boolean; invoke?: boolean; result?: boolean;
  peer?: string; request?: string;
  diagnostic?: string;
  search?: { nextIndex: number };
  actor?: string;
  incoming?: Record<string, string>;
  parentScan?: NativeToolCursor;
  childScan?: NativeToolCursor;
}
export interface IdeMessage {
  id: string; role: string; gmt_create: number; tool_call_id?: string;
  token_info?: string; model_info?: string; record_extra?: string;
}
export interface IdeDelegation {
  session: string; request: string; messages: IdeMessage[];
  tokens: Array<{ messageId?: string; gmtCreate: number; model?: string; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
  /** A known relationship may be emitted even when its message inventory is deferred. */
  complete?: boolean;
  diagnostic?: 'message-limit' | 'metadata-byte-limit' | 'tool-metadata-byte-limit' | 'tool-metadata-total-byte-limit'
    | 'invalid-metadata' | 'metadata-query-failed';
}

/** Only native relationship/usage metadata is queried. Encrypted bodies stay untouched. */
export async function readIdeDelegation(session: string, call: string, search = { nextIndex: 0 }): Promise<IdeDelegation | null> {
  const paths = resolveAllQoderDbPaths().filter(file => !isIdeaDbPath(file)).sort();
  const start = Number.isSafeInteger(search.nextIndex) && search.nextIndex >= 0 ? search.nextIndex : 0;
  const Database = loadDatabaseSync();
  if (!Database) return null;
  for (let i = 0; i < Math.min(paths.length, 4); i++) {
    const index = (start + i) % paths.length; const file = paths[index]!;
    search.nextIndex = (index + 1) % paths.length;
    let db: DatabaseSyncInstance | undefined;
    let found: { session_id: string; request_id: string; record_extra?: string } | undefined;
    const deferred = (diagnostic?: IdeDelegation['diagnostic']): IdeDelegation => ({ session: found!.session_id,
      request: found!.request_id, messages: [], tokens: [], complete: false, ...(diagnostic ? { diagnostic } : {}) });
    try {
      db = new Database(file, { readOnly: true });
      // One read-only snapshot avoids mixing pages with concurrent SQLite writes.
      db.exec('BEGIN');
      const matches = db.prepare(`SELECT session_id,request_id,
        CASE WHEN length(CAST(extra AS BLOB)) <= 16384 THEN extra END AS record_extra
        FROM chat_record WHERE parent_session_id=? AND parent_tool_call_id=? LIMIT 2`).all(session, call) as Array<{
          session_id: string; request_id: string; record_extra?: string }>;
      if (!matches.length) continue;
      if (matches.length !== 1 || !id(matches[0]!.session_id) || matches[0]!.session_id === session || !id(matches[0]!.request_id)) return null;
      found = matches[0]!;
      const stmt = db.prepare(`SELECT cm.rowid AS native_rowid,
        CASE WHEN length(CAST(cm.id AS BLOB)) <= 512 THEN cm.id END AS id,
        CASE WHEN length(CAST(cm.role AS BLOB)) <= 64 THEN cm.role END AS role, cm.gmt_create,
        CASE WHEN length(CAST(cm.token_info AS BLOB)) <= 16384 THEN cm.token_info END AS token_info,
        CASE WHEN length(CAST(cm.model_info AS BLOB)) <= 16384 THEN cm.model_info END AS model_info,
        CASE WHEN cm.role='tool' AND length(CAST(cm.tool_result AS BLOB)) <= ? AND json_valid(cm.tool_result)
          THEN json_extract(cm.tool_result,'$.toolCallId') END AS tool_call_id,
        CASE WHEN length(CAST(cm.tool_result AS BLOB)) > ? THEN 1 ELSE 0 END AS tool_metadata_large,
        CASE WHEN length(CAST(cm.tool_result AS BLOB)) > ? THEN 1 ELSE 0 END AS tool_metadata_oversized,
        CASE WHEN cm.role='tool' THEN length(CAST(cm.tool_result AS BLOB)) ELSE 0 END AS tool_metadata_bytes
        FROM chat_message cm WHERE cm.session_id=? AND cm.request_id=? AND cm.rowid>?
        ORDER BY cm.rowid LIMIT ?`);
      const largeTool = db.prepare(`SELECT CASE WHEN json_valid(tool_result)
        THEN json_extract(tool_result,'$.toolCallId') END AS tool_call_id
        FROM chat_message WHERE rowid=? AND session_id=? AND request_id=?`);
      const messages: IdeMessage[] = []; const tokens: IdeDelegation['tokens'] = [];
      let rowid = 0; let metadataBytes = 0; let toolMetadataBytes = 0;
      const recordModel = parseRecordModelKey(found.record_extra);
      for (;;) {
        const rows = stmt.all(INLINE_TOOL_METADATA_BYTES, INLINE_TOOL_METADATA_BYTES, MAX_TOOL_METADATA_BYTES,
          found.session_id, found.request_id, rowid, MESSAGE_PAGE_SIZE) as Array<IdeMessage & {
            native_rowid: number; tool_metadata_large: number; tool_metadata_oversized: number; tool_metadata_bytes?: number }>;
        for (const row of rows) {
          if (messages.length >= MAX_MESSAGES) return deferred('message-limit');
          if (row.tool_metadata_oversized && row.role === 'tool') return deferred('tool-metadata-byte-limit');
          toolMetadataBytes += row.tool_metadata_bytes ?? 0;
          if (toolMetadataBytes > MAX_TOOL_METADATA_TOTAL_BYTES) return deferred('tool-metadata-total-byte-limit');
          if (row.tool_metadata_large && row.role === 'tool') {
            const result = largeTool.all(row.native_rowid, found.session_id, found.request_id) as Array<{ tool_call_id?: string }>;
            row.tool_call_id = result[0]?.tool_call_id;
            // Keep a large JSON extraction from sharing a synchronous page with another one.
            await new Promise<void>(resolve => setImmediate(resolve));
          }
          if (!id(row.id) || typeof row.role !== 'string' || !Number.isFinite(Number(row.gmt_create))
            || !Number.isSafeInteger(row.native_rowid) || row.native_rowid <= rowid
            || (row.tool_call_id != null && !id(row.tool_call_id))) return deferred('invalid-metadata');
          rowid = row.native_rowid;
          const message: IdeMessage = { id: row.id, role: row.role, gmt_create: Number(row.gmt_create),
            ...(row.tool_call_id ? { tool_call_id: row.tool_call_id } : {}) };
          const usage = row.role === 'assistant' && row.token_info ? parseTokenInfo(row.token_info) : null;
          const candidateModel = usage ? (parseModelKey(row.model_info) ?? recordModel) : undefined;
          const token = usage ? { messageId: row.id, gmtCreate: Number(row.gmt_create),
            ...(candidateModel && candidateModel.length <= 512 ? { model: candidateModel } : {}),
            inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, cacheReadTokens: usage.cachedTokens } : undefined;
          metadataBytes += Buffer.byteLength(JSON.stringify(message)) + (token ? Buffer.byteLength(JSON.stringify(token)) : 0);
          if (metadataBytes > MAX_METADATA_BYTES) return deferred('metadata-byte-limit');
          messages.push(message); if (token) tokens.push(token);
        }
        if (rows.length < MESSAGE_PAGE_SIZE) break;
        // DatabaseSync returns one bounded page synchronously; yield between pages.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (!messages.length) return deferred();
      return { session: found.session_id, request: found.request_id, messages, tokens, complete: true };
    } catch { if (found) return deferred('metadata-query-failed'); /* Missing/locked DB remains retryable. */ }
    finally { try { db?.close(); } catch { /* Closing a read-only connection is best effort. */ } }
  }
  return null;
}

/** IDE sessions are siblings, not CLI sidechains. Correlation is per native request. */
export class QoderIdeDelegations {
  private retry = new Map<string, number>();
  private cursor = 0;
  private readonly nativeRows = new NativeToolRowReader();
  constructor(private readonly resolve = readIdeDelegation,
    private readonly warn: (reason: string, details?: Record<string, string>) => void = () => {}) {}

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
    const budget = { remaining: MAX_BYTES };
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
      // A TOOL may be exported before its SQLite relationship exists or before
      // this work reaches the processing budget. Fix its identity at discovery,
      // so a later child can still point at the already-exported parent.
      for (const record of records) {
        if ((record['event.name'] !== 'tool.call' && record['event.name'] !== 'tool.result')
          || record['gen_ai.agent.type'] !== 'qoder') continue;
        const session = record['gen_ai.session.id']; const turn = record['gen_ai.turn.id']; const call = record['gen_ai.tool.call.id'];
        if (!id(session) || !id(call) || typeof turn !== 'string') continue;
        const work = state[hash(['qoder-ide-delegation', session, turn, call]).slice(0, 32)];
        if (work) record.span_id = work.span;
      }
    };
    register(input);
    const release = (work: Work) => {
      this.nativeRows.releaseOwner(`${work.id}:parent`);
      this.nativeRows.releaseOwner(`${work.id}:child`);
    };
    this.nativeRows.retainOwners(new Set(Object.values(state).filter(work => !work.done || !work.result)
      .flatMap(work => [`${work.id}:parent`, `${work.id}:child`])));
    let handled = 0;
    const keys = Object.keys(state);
    const start = keys.length ? this.cursor % keys.length : 0;
    const rotated = [...keys.slice(start), ...keys.slice(0, start)];
    const activeOwners = new Set(this.nativeRows.activeOwners());
    const priority = (key: string) => activeOwners.has(`${key}:parent`) || activeOwners.has(`${key}:child`);
    const queue = [...rotated.filter(priority), ...rotated.filter(key => !priority(key))];
    for (let index = 0; index < queue.length && handled < 8; index++) {
      const work = state[queue[index]!]!;
      const current = available.filter(record => record['gen_ai.session.id'] === work.session
        && record['gen_ai.turn.id'] === work.turn && record['gen_ai.tool.call.id'] === work.call);
      if (!current.length && (this.retry.get(work.id) ?? 0) > now) continue;
      if (work.done && work.result) { release(work); continue; }
      handled++;
      this.cursor = (keys.indexOf(work.id) + 1) % Math.max(1, keys.length);
      let retryAfter = 5000;
      try {
        let call = current.find(record => record['event.name'] === 'tool.call');
        let result = current.find(record => record['event.name'] === 'tool.result');
        const parent = await this.nativeRows.read(work.file, work.session, new Set([work.call]), work.parentScan, budget, `${work.id}:parent`);
        if (parent.cursor.blocked && parent.cursor.blocked !== work.parentScan?.blocked) this.warn(`ide-delegation-${parent.cursor.blocked}`);
        work.parentScan = parent.cursor;
        let nativeReply = false;
        if (parent.rows) {
          for (const row of parent.rows) for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
            if (!call && block.type === 'tool_use' && block.name === 'Agent' && block.id === work.call) call = {
              'gen_ai.tool.call.arguments': block.input, 'gen_ai.tool.name': 'Agent', time_unix_nano: nano(Date.parse(row.timestamp)),
            };
            if (!result && block.type === 'tool_result' && block.tool_use_id === work.call) result = {
              'gen_ai.tool.call.result': block.content, 'tool.result.status': block.is_error ? 'error' : 'success',
              time_unix_nano: nano(Date.parse(row.timestamp)),
            };
            if (block.type === 'tool_result' && block.tool_use_id === work.call
              && typeof row.toolUseResult === 'string' && row.toolUseResult === block.content) nativeReply = true;
          }
        }
        if (!call) {
          // An unfinished bounded scan can be the only way to recover the
          // parent call after its input batch was already emitted.
          if (!this.nativeRows.activeOwners().includes(`${work.id}:parent`)) release(work);
          this.warn('ide-delegation-parent-unavailable'); continue;
        }
        const peer = await this.resolve(work.session, work.call, work.search ??= { nextIndex: 0 });
        // An IDE path/Agent nickname alone is not a relationship. In particular,
        // do not enable this adapter for JetBrains or missing native evidence.
        if (!peer || peer.session === work.session) { release(work); continue; }
        work.peer = peer.session; work.request = peer.request;
        if (peer.diagnostic) {
          if (work.diagnostic !== peer.diagnostic) this.warn(`ide-delegation-${peer.diagnostic}`,
            { parentSession: work.session, toolCallId: work.call, childSession: peer.session, requestId: peer.request });
          work.diagnostic = peer.diagnostic; retryAfter = 60000;
        } else delete work.diagnostic;
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
          && call['gen_ai.tool.call.arguments']?.async !== true
          && (nativeReply || result['tool.result.status'] === 'error');
        if (delivered && result && !work.result) {
          const event = audit('gen_ai.agent.result', result);
          const body = result['gen_ai.tool.call.result'];
          if (typeof body === 'string') event['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: body }] }];
          emitted.push(event); work.result = true;
        }
        if (peer.complete === false) { this.nativeRows.releaseOwner(`${work.id}:child`); continue; }
        if (work.done || !delivered) { this.nativeRows.releaseOwner(`${work.id}:child`); continue; }
        const childPath = path.join(path.dirname(work.file), `${peer.session}.jsonl`);
        const toolIds = new Set(peer.messages.filter(row => row.role === 'tool' && row.tool_call_id).map(row => row.tool_call_id!));
        let native: RecordData[] = [];
        if (toolIds.size) {
          const directory = await fs.realpath(path.dirname(work.file));
          if (path.dirname(await fs.realpath(childPath)) !== directory) throw new Error('IDE child path escapes transcript directory');
          const child = await this.nativeRows.read(childPath, peer.session, toolIds, work.childScan, budget, `${work.id}:child`);
          if (child.cursor.blocked && child.cursor.blocked !== work.childScan?.blocked) this.warn(`ide-delegation-${child.cursor.blocked}`);
          work.childScan = child.cursor;
          if (!child.rows) continue;
          native = child.rows;
        }
        const records = this.buildChild(work, peer, native, call, base, result);
        if (!records) continue;
        emitted.push(...records); available.push(...records); work.done = true;
        delete work.parentScan; delete work.childScan;
        const oldKeys = new Set(Object.keys(state)); register(records);
        queue.push(...Object.keys(state).filter(key => !oldKeys.has(key)));
      } catch { release(work); this.warn('ide-delegation-source-pending'); }
      finally {
        this.retry.set(work.id, now + retryAfter);
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
    const assistantIndices = peer.messages.flatMap((row, index) => row.role === 'assistant' ? [index] : []);
    const assistants = assistantIndices.map(index => peer.messages[index]!);
    const tokens = new Map(peer.tokens.map(token => [token.messageId, token]));
    if (users.length !== 1 || !assistants.length || peer.messages.at(-1)?.role !== 'assistant'
      || assistants.some(row => !tokens.has(row.id))) return null;
    const prompt = call['gen_ai.tool.call.arguments']?.prompt;
    if (typeof prompt !== 'string' || !prompt) return null;
    const rows: RecordData[] = [{ type: 'user', sessionId: peer.session, uuid: users[0]!.id,
      timestamp: new Date(Number(users[0]!.gmt_create)).toISOString(), message: { role: 'user', content: prompt } }];
    for (let i = 0; i < assistants.length; i++) {
      const message = assistants[i]!; const next = assistants[i + 1];
      // The native request's message ordering owns the model/tool grouping.
      // Exact toolCallId values connect that inventory to transcript bodies.
      const start = assistantIndices[i]! + 1;
      const end = next ? assistantIndices[i + 1]! : peer.messages.length;
      const associated = peer.messages.slice(start, end).filter(row => row.role === 'tool');
      if (associated.some(row => !row.tool_call_id || !tools.get(row.tool_call_id)?.call || !tools.get(row.tool_call_id)?.result)) return null;
      const usage = tokens.get(message.id)!;
      const content = associated.flatMap(row => tools.get(row.tool_call_id!)!.call!.message.content);
      rows.push({ type: 'assistant', sessionId: peer.session, uuid: message.id,
        timestamp: new Date(Number(message.gmt_create)).toISOString(), message: { id: message.id, role: 'assistant', model: usage.model,
          content, ...(content.length ? { stop_reason: 'tool_use' } : {}), usage: {
            input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens,
          } } });
      for (const row of associated) rows.push(tools.get(row.tool_call_id!)!.result!);
    }
    const turn = hash(['qoder-ide-request', peer.session, peer.request]);
    let records = buildEventsFromBoundaries(buildLlmBoundaries([], rows), rows, rows, turn, peer.session, 'qoder', {
      userId: base['user.id'], userIdentity: { name: base['user.name'], email: base['user.email'] },
      resourceAttributes: base.resourceAttributes ?? {},
    }, work.cwd);
    // IDE child transcripts omit text-only responses. Their native SQLite
    // assistant IDs/usage still prove the calls. For a successful foreground
    // Agent, the delivered tool result is its final assistant reply. Do not
    // reuse it for intermediate calls, failures or asynchronous receipts.
    const requests = records.filter(record => record['event.name'] === 'llm.request');
    if (requests.length !== assistants.length) return null;
    const responses = new Set(records.filter(record => record['event.name'] === 'llm.response')
      .map(record => record['gen_ai.response.id']));
    const missingResponses = new Map<RecordData, RecordData>();
    for (let i = 0; i < assistants.length; i++) {
      const message = assistants[i]!;
      if (responses.has(message.id)) continue;
      const request = requests[i]!; const usage = tokens.get(message.id)!;
      const response: RecordData = { ...request, 'event.name': 'llm.response',
        'gen_ai.response.id': message.id, ...(usage.model ? { 'gen_ai.response.model': usage.model } : {}),
        'gen_ai.usage.input_tokens': usage.inputTokens, 'gen_ai.usage.output_tokens': usage.outputTokens,
        'gen_ai.usage.cache_read.input_tokens': usage.cacheReadTokens,
        time_unix_nano: nano(Number(message.gmt_create)), 'agent.source': 'qoder-ide-sqlite-metadata' };
      delete response['gen_ai.input.messages_delta'];
      const delivered = result?.['gen_ai.tool.call.result'];
      if (i === assistants.length - 1 && result?.['tool.result.status'] === 'success'
        && typeof delivered === 'string' && delivered.length) {
        response['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: delivered }] }];
        response['agent.source'] = 'qoder-ide-agent-result';
      }
      missingResponses.set(request, response);
    }
    if (missingResponses.size) records = records.flatMap(record => {
      const response = missingResponses.get(record); return response ? [record, response] : [record];
    });
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
