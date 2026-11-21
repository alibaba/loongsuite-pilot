import { doubaoDigest, type DoubaoToolPair } from './doubao-work-log.js';
import { nativeDemandFingerprint, nativeDemandKey, nativeReminderOnly } from './doubao-work-demand.js';

const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_CALLS = 4096;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;

export interface NativeCallContent {
  actor: string; name: string; decisionId: string; recordIndex: number;
  arguments?: string; result?: string; resultIndex?: number;
}
export interface NativeAssignment { timeMs: number; text: string }
export interface NativeContent {
  calls: Record<string, NativeCallContent>;
  assignments: Record<string, NativeAssignment[]>;
  lastAnswers: Record<string, { index: number; text: string }>;
  /** Original message order for visible assistant-round reconstruction. */
  transcripts?: Record<string, Record<string, unknown>[]>;
  /** Original row position when a bounded native window has evicted history. */
  transcriptOffsets?: Record<string, number>;
  /** Reader-private cache metadata; never used for semantic event time/IDs. */
  sourceVersions?: Record<string, string>;
  sourceBytes?: Record<string, number>;
  findUserRows?: (actor: string, fingerprint: string) => readonly number[] | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= MAX_CONTENT_BYTES ? independentNativeString(value) : undefined;
}

/** Small cached fields must not retain a large JSON string's backing store. */
export function independentNativeString(value: string): string { return Buffer.from(value, 'utf16le').toString('utf16le'); }

/** Content is read only for the freshly identified conversation. Nothing here
 * supplies model names, model time, token usage, or a guessed finish reason.
 * The caller must pass the result through InputManager's normal masking path.
 */
export function parseNativeContent(files: Record<string, string>, assignments: Record<string, string>): NativeContent | undefined {
  const result: NativeContent = { calls: {}, assignments: {}, lastAnswers: {}, transcripts: {} };
  let count = 0;
  for (const [actor, content] of Object.entries(files)) {
    const rows = content.split('\n').filter(Boolean).map(line => JSON.parse(line));
    result.transcripts![actor] = rows;
    for (let index = 0; index < rows.length; index++) {
      if (rows[index].role === 'assistant' && Array.isArray(rows[index].tool_calls)) count += rows[index].tool_calls.length;
      if (count > MAX_CALLS || !appendNativeContentRow(result, actor, rows[index], index)) return undefined;
    }
    const last = rows.at(-1);
    const answer = last?.role === 'assistant' && !last.tool_calls?.length ? text(last.content) : undefined;
    if (answer) result.lastAnswers[actor] = { index: rows.length - 1, text: answer };
    const source = assignments[actor];
    if (source === undefined) continue;
    // Assignment is an append-only, native per-agent task file. Keep the
    // literal body, without adding the file's administrative header to input.
    const matches = [...source.matchAll(/^## \[([^\]\r\n]+)\] 需求\r?\n/gm)];
    result.assignments[actor] = matches.flatMap((match, index) => {
      const timeMs = Date.parse(match[1]);
      const body = text(source.slice(match.index! + match[0].length, matches[index + 1]?.index).trim());
      return Number.isSafeInteger(timeMs) && body ? [{ timeMs, text: body }] : [];
    });
  }
  return result;
}

/** Shared by complete-file fixtures and the incremental native reader. */
export function appendNativeContentRow(result: NativeContent, actor: string, row: Record<string, any>, index: number, prunedHistory = false): boolean {
  delete result.lastAnswers[actor];
  if (row.role === 'assistant' && Array.isArray(row.tool_calls)) {
    const ids = row.tool_calls.map((call: { id?: unknown }) => call?.id);
    if (!ids.every((id: unknown) => typeof id === 'string' && ID.test(id))) return false;
    const decisionId = doubaoDigest(JSON.stringify([actor, ids]));
    for (const call of row.tool_calls) {
      if (result.calls[call.id] || typeof call.function?.name !== 'string'
        || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(call.function.name)) return false;
      const raw = call.function?.arguments;
      let args: string | undefined;
      if (raw !== undefined) {
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = text(JSON.stringify(parsed));
        } catch { /* Invalid arguments are not promoted into a JSON field. */ }
      }
      result.calls[call.id] = { actor, name: independentNativeString(call.function.name), decisionId, recordIndex: index,
        ...(args === undefined ? {} : { arguments: args }) };
    }
  } else if (row.role === 'tool' && typeof row.tool_call_id === 'string') {
    const call = result.calls[row.tool_call_id];
    if (!call) return prunedHistory;
    if (call.actor !== actor || call.resultIndex !== undefined) return false;
    call.resultIndex = index; call.result = text(row.content);
  }
  const answer = row.role === 'assistant' && !row.tool_calls?.length ? text(row.content) : undefined;
  if (answer) result.lastAnswers[actor] = { index, text: answer };
  return true;
}

/** A completion notification can reuse the native demand timestamp. Ignore it
 * only beside one actual demand with a visible matching user delimiter. A
 * reminder-shaped user message or multiple actual demands remain ambiguous. */
export function nativeCurrentAssignment(content: NativeContent, actor: string, queryMs: number, endMs: number): NativeAssignment | undefined {
  const current = (content.assignments[actor] ?? []).filter(item => item.timeMs >= queryMs && item.timeMs <= endMs);
  if (current.length === 1) return current[0];
  const demands = current.filter(item => !nativeReminderOnly(item.text));
  if (demands.length !== 1 || current.some(item => item.timeMs !== demands[0].timeMs)) return undefined;
  const hasUser = (value: string) => {
    const indexed = content.findUserRows?.(actor, nativeDemandFingerprint(value));
    const key = indexed === undefined ? nativeDemandKey(value) : undefined;
    return indexed === undefined
      ? content.transcripts?.[actor]?.some(row => row.role === 'user' && typeof row.content === 'string'
        && row.content.length <= MAX_CONTENT_BYTES && nativeDemandKey(row.content) === key)
      : indexed.length > 0;
  };
  return hasUser(demands[0].text) && !hasUser('') ? demands[0] : undefined;
}

/** A unique native assignment in this request window plus exact tool IDs is
 * required for reuse. Future assignments, an old tail, or ambiguity omit I/O.
 */
export function nativeTaskContent(content: NativeContent | undefined, actor: string, queryMs: number, endNano: string, callIds: string[]): { input?: string; output?: string } {
  if (!content) return {};
  const endMs = Number(BigInt(endNano) / 1_000_000n);
  const assignments = content.assignments[actor] ?? [];
  if (assignments.some(item => item.timeMs > endMs)) return {};
  const current = nativeCurrentAssignment(content, actor, queryMs, endMs);
  if (!current) return {};
  const answer = content.lastAnswers[actor];
  const results = callIds.map(id => content.calls[id]).filter(call => call?.actor === actor && call.resultIndex !== undefined);
  const freshTail = results.length > 0
    ? answer && results.every(call => call.resultIndex! < answer.index)
    : assignments.length === 1;
  return { input: current.text, ...(answer && freshTail ? { output: answer.text } : {}) };
}

/** Attach only the exact call's native content; Windows callback "Bash" may
 * implement a native PowerShell call. Keep both names with their own meaning.
 */
export function enrichNativeToolEvents<T extends Record<string, unknown>>(entries: T[], content?: NativeContent): T[] {
  if (!content) return entries;
  return entries.map(entry => {
    const id = entry['gen_ai.tool.call.id'];
    const call = typeof id === 'string' ? content.calls[id] : undefined;
    if (!call || entry['gen_ai.agent.id'] !== call.actor) return entry;
    return { ...entry, 'gen_ai.tool.name': call.name,
      'loongsuite.doubao_work.local_executor_tool_name': entry['gen_ai.tool.name'],
      'loongsuite.doubao_work.native_decision_id': call.decisionId,
      ...(entry['event.name'] === 'tool.call' && call.arguments !== undefined ? { 'gen_ai.tool.call.arguments': JSON.parse(call.arguments) } : {}),
      ...(entry['event.name'] === 'tool.result' && call.result !== undefined ? { 'gen_ai.tool.call.result': call.result } : {}),
    };
  });
}

export function nativeToolObservations(pairs: DoubaoToolPair[], content?: NativeContent) {
  return pairs.flatMap(pair => {
    const call = pair.start.tool, end = pair.end.tool;
    if (!call || !end || !pair.start.turnId || call.id !== end.id || call.sandboxId !== end.sandboxId
      || call.name !== end.name || call.phase !== 'received' || end.phase !== 'settled'
      || !end.status || BigInt(pair.end.timeNano) <= BigInt(pair.start.timeNano)) return [];
    const native = content?.calls[call.id];
    const matched = native?.actor === pair.start.turnId ? native : undefined;
    return [{ callId: call.id, name: matched?.name ?? call.name, executorName: call.name,
      actor: pair.start.turnId, startNano: pair.start.timeNano, endNano: pair.end.timeNano, status: end.status,
      ...(matched?.decisionId ? { decisionId: matched.decisionId } : {}),
      ...(matched?.arguments === undefined ? {} : { arguments: JSON.parse(matched.arguments) }),
      ...(matched?.result === undefined ? {} : { result: matched.result }),
    }];
  });
}
