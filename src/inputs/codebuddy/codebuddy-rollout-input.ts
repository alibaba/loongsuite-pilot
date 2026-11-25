import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { createLogger } from '../../utils/logger.js';
import {
  appendProcessed,
  normalizeStopBoundaries,
  settledRequestIds,
} from './codebuddy-history-input.js';
import { buildCodeBuddyHistoryEvents } from './codebuddy-history-builder.js';
import type {
  CodeBuddyContentBlock,
  CodeBuddyHistoryConversation,
  CodeBuddyHistoryIndex,
  CodeBuddyHistoryMessage,
  CodeBuddyHistoryRequest,
  CodeBuddyHistoryRequestUsage,
} from './codebuddy-history-types.js';

const logger = createLogger('CodeBuddyRolloutInput');

const INITIALIZED_KEY = 'codebuddyRolloutInitialized';
const PROCESSED_KEY = 'codebuddyRolloutProcessed';
const MTIME_KEY = 'codebuddyRolloutMtime';
const MAX_PROCESSED_PER_CONVERSATION = 4_096;

/**
 * A live turn keeps appending rollout lines (reasoning deltas, messages, tool
 * calls), and the turn's own UserPromptSubmit hook boundary fires ~1s after its
 * first line lands — long before the assistant response is written. Sealing an
 * incomplete last request on that boundary would mark the request processed and
 * permanently lose the usage/output its assistant line will carry, so the last
 * request is only sealed once the rollout has been quiet this long: a finished
 * (or cancelled) run stops writing, a streaming one does not.
 */
const LAST_TURN_QUIET_MS = 15_000;

const HOOK_INPUT_ID = 'codebuddy';
const HOOK_BOUNDARIES_KEY = 'boundaries';

/**
 * Input for the CodeBuddy CLI (`codebuddy` npm package, Claude-Code lineage).
 *
 * The CLI persists every session as an append-only JSONL rollout under
 * `~/.codebuddy/projects/<cwd-slug>/<sessionId>.jsonl` — the same layout on
 * Windows, macOS and Linux (`~/.codebuddy` is platform-neutral). Each line is
 * one typed record:
 *
 *   - `message`            user / assistant turn content (content blocks
 *                          `input_text` / `output_text`), with
 *                          `providerData.conversationRequestId` grouping the
 *                          lines of one model request, `providerData.usage`
 *                          or `providerData.rawUsage` (token usage — the
 *                          CLI persists the OpenAI-style `rawUsage`) and
 *                          `_meta.traceparent` (W3C, per-turn trace id; the
 *                          CLI keeps a per-turn trace carrier, so no
 *                          session-level mega-trace risk — when absent the
 *                          `providerData.traceId` hex field is used).
 *   - `function_call`      a tool invocation: `{callId, id, name, arguments}`.
 *   - `function_call_result` the matching tool output.
 *   - `reasoning`          assistant reasoning item.
 *   - `session-meta` / `ai-title` / `file-history-snapshot` — metadata, skipped.
 *
 * The input synthesizes the same conversation shape the IDE/plugin history
 * input consumes and delegates to {@link buildCodeBuddyHistoryEvents}, so
 * turn sealing, cancelled-turn capture (hook Stop / UserPromptSubmit boundary
 * evidence joined on the session id) and usage attribution behave identically
 * across both surfaces.
 */
export class CodeBuddyRolloutInput extends BaseInput {
  readonly id = 'codebuddy-rollout';
  readonly agentType = ClientType.CodeBuddy;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly rolloutRoot: string;
  private readonly dataRoot: string;
  private watchers: fsSync.FSWatcher[] = [];

  constructor(opts: InputOptions & { rolloutRoot?: string }) {
    super(opts);
    this.dataRoot = path.join(homedir(), '.codebuddy');
    this.rolloutRoot = opts.rolloutRoot ?? path.join(this.dataRoot, 'projects');
  }

  /** `~/.codebuddy` — the CLI home, identical on Windows / macOS / Linux. */
  static getWatchPaths(home = homedir()): string[] {
    return [path.join(home, '.codebuddy')];
  }

  static async checkAvailability(home = homedir()): Promise<boolean> {
    try {
      return (await fs.stat(path.join(home, '.codebuddy'))).isDirectory();
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    this.watchDirectory(this.dataRoot);
  }

  protected override async onStop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fsSync.watch(dir, { recursive: true }, () => this.requestCollection());
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Polling remains active when the path is absent or recursive watch is unsupported.
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const processedBefore = normalizeProcessedMap(state.extra?.[PROCESSED_KEY]);
    const mtimeBefore = normalizeMtimeMap(state.extra?.[MTIME_KEY]);

    const discovered = await this.discoverRollouts();
    const discoveredIds = new Set(discovered.map(file => file.sessionId));

    // Boundary evidence recorded by the CodeBuddyInput hook stream (Stop and
    // UserPromptSubmit timestamps, keyed by session id — the rollout's
    // sessionId is the same id the hooks carry).
    const boundaries = normalizeStopBoundaries(
      this.stateStore.get(HOOK_INPUT_ID).extra?.[HOOK_BOUNDARIES_KEY],
    );

    const processedNow: Record<string, string[]> = {};
    const mtimeNow: Record<string, number> = {};
    for (const [sessionId, ids] of Object.entries(processedBefore)) {
      if (discoveredIds.has(sessionId)) processedNow[sessionId] = ids;
    }
    for (const [sessionId, mtime] of Object.entries(mtimeBefore)) {
      if (discoveredIds.has(sessionId)) mtimeNow[sessionId] = mtime;
    }

    const entries: AgentActivityEntry[] = [];

    for (const file of discovered) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(file.filePath);
      } catch {
        continue;
      }
      const mtimeMs = Math.trunc(stat.mtimeMs);
      const seenMtime = mtimeNow[file.sessionId];
      mtimeNow[file.sessionId] = mtimeMs;

      const conversation = await this.readRollout(file);
      if (!conversation) continue;

      const requests = conversation.index.requests ?? [];
      const settled = settledRequestIds(requests);
      const processed = new Set(processedNow[file.sessionId] ?? []);

      if (!initialized) {
        // Baseline: mark everything already on disk as processed so an install
        // does not replay the entire pre-existing CLI history.
        processedNow[file.sessionId] = appendProcessed(
          processedNow[file.sessionId] ?? [],
          settled,
        );
        continue;
      }

      const evidence = boundaries[file.sessionId];
      const boundaryAtMs = evidence ? Math.max(...evidence) : undefined;

      // The newest not-yet-settled request becomes emittable once a boundary
      // observed after its start proves the run ended (Stop hook, or the user
      // submitting the next prompt — the CLI omits Stop on aborts) AND the
      // rollout has gone quiet (the response is no longer being streamed —
      // see LAST_TURN_QUIET_MS).
      const lastRequest = requests[requests.length - 1];
      const lastRequestQuiet = Date.now() - mtimeMs >= LAST_TURN_QUIET_MS;
      const sealableLast = lastRequest
        && typeof lastRequest.id === 'string' && lastRequest.id.length > 0
        && !settled.includes(lastRequest.id)
        && !processed.has(lastRequest.id)
        && typeof lastRequest.startedAt === 'number'
        && Number.isFinite(lastRequest.startedAt)
        && boundaryAtMs !== undefined
        && boundaryAtMs >= lastRequest.startedAt
        && lastRequestQuiet
        ? lastRequest.id : undefined;

      if (seenMtime === mtimeMs && settled.every(id => processed.has(id)) && sealableLast === undefined) {
        continue;
      }

      const newRequestIds = settled.filter(id => !processed.has(id));
      if (newRequestIds.length === 0 && sealableLast === undefined) continue;

      const built = buildCodeBuddyHistoryEvents(conversation, {
        includeRequestIds: new Set(sealableLast ? [...newRequestIds, sealableLast] : newRequestIds),
        sealEvidence: evidence,
      });
      entries.push(...built.entries);
      // Withheld turns (no boundary evidence yet) stay unmarked so a later
      // cycle rebuilds them together with their seal record.
      const emitIds = (sealableLast ? [...newRequestIds, sealableLast] : newRequestIds)
        .filter(id => !built.unsealedRequestIds.includes(id));
      processedNow[file.sessionId] = appendProcessed(
        processedNow[file.sessionId] ?? [],
        emitIds,
      );
    }

    const nextExtra: Record<string, unknown> = {
      ...state.extra,
      [INITIALIZED_KEY]: true,
      [PROCESSED_KEY]: processedNow,
      [MTIME_KEY]: mtimeNow,
    };
    this.setState({ extra: nextExtra });
    return entries;
  }

  private async discoverRollouts(): Promise<Array<{ filePath: string; sessionId: string }>> {
    const found: Array<{ filePath: string; sessionId: string }> = [];
    let slugs: Dirent[];
    try {
      slugs = await fs.readdir(this.rolloutRoot, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const slugDir = path.join(this.rolloutRoot, slug.name);
      let files: Dirent[];
      try {
        files = await fs.readdir(slugDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        found.push({
          filePath: path.join(slugDir, file.name),
          sessionId: file.name.slice(0, -'.jsonl'.length),
        });
      }
    }
    return found;
  }

  private async readRollout(
    file: { filePath: string; sessionId: string },
  ): Promise<CodeBuddyHistoryConversation | null> {
    let raw: string;
    try {
      raw = await fs.readFile(file.filePath, 'utf8');
    } catch {
      return null;
    }
    return parseRolloutConversation(raw, file.sessionId);
  }
}

// ─── Rollout → conversation synthesis ───

interface RolloutLine {
  type?: string;
  role?: string;
  id?: string;
  timestamp?: number;
  sessionId?: string;
  content?: Array<Record<string, unknown>>;
  providerData?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  // function_call / function_call_result item fields:
  callId?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  result?: unknown;
  text?: unknown;
  summary?: unknown;
  [key: string]: unknown;
}

/**
 * Parse a rollout JSONL transcript into the conversation shape consumed by
 * {@link buildCodeBuddyHistoryEvents}. Lines that cannot contribute events
 * (session metadata, titles, snapshots) are skipped; malformed lines are
 * ignored — the file is retried on the next cycle.
 */
/** Seal the in-progress group into a request; empty groups are dropped. */
function pushGroup(
  requests: CodeBuddyHistoryRequest[],
  state: {
    id?: string;
    messageIds: string[];
    startedAt?: number;
    traceId?: string;
    usage?: CodeBuddyHistoryRequestUsage;
    hasAssistant: boolean;
  },
): void {
  if (!state.id || state.messageIds.length === 0) return;
  requests.push({
    id: state.id,
    messages: state.messageIds,
    state: state.hasAssistant ? 'complete' : 'incomplete',
    startedAt: state.startedAt,
    usage: state.usage,
  });
}

export function parseRolloutConversation(
  raw: string,
  sessionId: string,
): CodeBuddyHistoryConversation | null {
  const messages: CodeBuddyHistoryMessage[] = [];
  const requests: CodeBuddyHistoryRequest[] = [];
  // Flat scalar group state — avoids the object-narrowing pitfalls of a
  // nullable group pointer reassigned inside the line loop.
  const groupState = {
    id: undefined as string | undefined,
    messageIds: [] as string[],
    startedAt: undefined as number | undefined,
    traceId: undefined as string | undefined,
    usage: undefined as CodeBuddyHistoryRequestUsage | undefined,
    hasAssistant: false,
  };

  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim().length === 0) continue;
    let line: RolloutLine;
    try {
      const parsed = JSON.parse(lines[index]) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      line = parsed as RolloutLine;
    } catch {
      continue;
    }

    const type = typeof line.type === 'string' ? line.type : '';
    if (type !== 'message' && type !== 'function_call' && type !== 'function_call_result' && type !== 'reasoning') {
      continue;
    }

    const requestId: string = requestIdFor(line) ?? groupState.id ?? `${sessionId}:t${requests.length + 1}`;
    if (groupState.id !== undefined && groupState.id !== requestId) {
      pushGroup(requests, groupState);
      groupState.id = undefined;
      groupState.messageIds = [];
      groupState.startedAt = undefined;
      groupState.traceId = undefined;
      groupState.usage = undefined;
      groupState.hasAssistant = false;
    }
    if (groupState.id === undefined) groupState.id = requestId;
    const traceId = traceIdFor(line);
    if (groupState.traceId === undefined && traceId !== undefined) groupState.traceId = traceId;
    if (groupState.startedAt === undefined
      && typeof line.timestamp === 'number' && Number.isFinite(line.timestamp)) {
      groupState.startedAt = line.timestamp;
    }

    if (type === 'message') {
      // May produce 1–2 messages: a user message plus a tool-role message
      // when tool results are carried inside the user line's content.
      for (const mapped of mapMessageLine(line, requestId, traceId ?? groupState.traceId)) {
        messages.push(mapped);
        groupState.messageIds.push(mapped.id);
        if (mapped.role === 'assistant') {
          groupState.hasAssistant = true;
          const usage = usageOf(line);
          if (usage) groupState.usage = usage;
        }
      }
      continue;
    }

    if (type === 'function_call') {
      const mapped = mapFunctionCall(line, requestId, traceId ?? groupState.traceId);
      if (mapped) {
        messages.push(mapped);
        groupState.messageIds.push(mapped.id);
        groupState.hasAssistant = true;
      }
      continue;
    }

    if (type === 'function_call_result') {
      const mapped = mapFunctionCallResult(line, requestId, traceId ?? groupState.traceId);
      if (mapped) {
        messages.push(mapped);
        groupState.messageIds.push(mapped.id);
      }
      continue;
    }

    // type === 'reasoning'
    const mapped = mapReasoning(line, requestId, traceId ?? groupState.traceId);
    if (mapped) {
      messages.push(mapped);
      groupState.messageIds.push(mapped.id);
    }
  }
  pushGroup(requests, groupState);

  if (messages.length === 0) return null;
  const index: CodeBuddyHistoryIndex = { requests };
  return { conversationId: sessionId, index, messages };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The model request a rollout line belongs to. */
function requestIdFor(line: RolloutLine): string | undefined {
  const provider = asRecord(line.providerData);
  const fromProvider = provider?.conversationRequestId;
  if (typeof fromProvider === 'string' && fromProvider.length > 0) return fromProvider;
  const meta = asRecord(line._meta);
  const baggage = typeof meta?.baggage === 'string' ? meta.baggage : '';
  const match = /codebuddy\.conversation_request_id=([^,;\s]+)/.exec(baggage);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Per-turn W3C trace id carried by every message line's `_meta.traceparent`. */
function traceIdFor(line: RolloutLine): string | undefined {
  const provider = asRecord(line.providerData);
  const explicit = provider?.traceId;
  if (typeof explicit === 'string' && /^[0-9a-fA-F]{32}$/.test(explicit)) return explicit.toLowerCase();
  const meta = asRecord(line._meta);
  const traceparent = typeof meta?.traceparent === 'string' ? meta.traceparent : '';
  const parts = traceparent.split('-');
  return parts.length >= 3 && /^[0-9a-fA-F]{32}$/.test(parts[1]) ? parts[1].toLowerCase() : undefined;
}

/**
 * Token usage from an assistant rollout line.
 *
 * Two on-disk shapes are accepted:
 *  - `providerData.usage` — normalized camelCase (`inputTokens`, …), as
 *    written by some CLI/plugin builds;
 *  - `providerData.rawUsage` — OpenAI-style snake_case (`prompt_tokens`,
 *    `completion_tokens`, `prompt_tokens_details.cached_tokens`, …), the
 *    shape the CLI actually persists today.
 */
function usageOf(line: RolloutLine): CodeBuddyHistoryRequestUsage | undefined {
  const provider = asRecord(line.providerData);
  const usage = asRecord(provider?.usage) ?? asRecord(provider?.rawUsage);
  if (!usage) return undefined;
  const details = Array.isArray(usage.inputTokensDetails)
    ? (usage.inputTokensDetails as Array<Record<string, unknown>>)
    : Array.isArray(usage.prompt_tokens_details)
      ? (usage.prompt_tokens_details as Array<Record<string, unknown>>)
      : [];
  const cacheTokens = details
    .map(entry => entry?.cached_tokens)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
  const pick = (key: string): number | undefined => {
    const value = usage[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const nestedCached = (() => {
    const details = asRecord(usage.prompt_tokens_details);
    const value = details?.cached_tokens;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  })();
  const cacheRead = cacheTokens > 0 ? cacheTokens : nestedCached;
  const cacheWrite = pick('cache_creation_input_tokens') ?? pick('prompt_cache_write_tokens');
  const cacheMiss = pick('prompt_cache_miss_tokens');
  const credit = pick('credit');
  const mapped: CodeBuddyHistoryRequestUsage = {
    inputTokens: pick('inputTokens') ?? pick('prompt_tokens'),
    outputTokens: pick('outputTokens') ?? pick('completion_tokens'),
    totalTokens: pick('totalTokens') ?? pick('total_tokens'),
    ...(cacheRead !== undefined && cacheRead > 0 ? { cacheTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cachedWriteTokens: cacheWrite } : {}),
    ...(cacheMiss !== undefined ? { cachedMissTokens: cacheMiss } : {}),
    ...(credit !== undefined ? { credit } : {}),
  };
  return mapped.inputTokens !== undefined || mapped.outputTokens !== undefined || mapped.totalTokens !== undefined
    ? mapped
    : undefined;
}

function createdAtIso(line: RolloutLine): string | undefined {
  return typeof line.timestamp === 'number' && Number.isFinite(line.timestamp)
    ? new Date(line.timestamp).toISOString()
    : undefined;
}

function makeExtra(
  requestId: string,
  traceId: string | undefined,
  fields: { modelId?: unknown; modelName?: unknown; responseId?: unknown } = {},
): string {
  return JSON.stringify({
    requestId,
    ...(traceId !== undefined ? { traceId } : {}),
    ...(typeof fields.modelId === 'string' ? { modelId: fields.modelId } : {}),
    ...(typeof fields.modelName === 'string' ? { modelName: fields.modelName } : {}),
    ...(typeof fields.responseId === 'string' ? { responseId: fields.responseId } : {}),
  });
}

function makeMessage(
  id: string,
  role: string,
  content: CodeBuddyContentBlock[],
  requestId: string,
  traceId: string | undefined,
  line: RolloutLine,
  fields: { modelId?: unknown; modelName?: unknown; responseId?: unknown } = {},
): CodeBuddyHistoryMessage {
  return {
    id,
    role,
    message: JSON.stringify({ role, content }),
    extra: makeExtra(requestId, traceId, fields),
    createdAt: createdAtIso(line),
  };
}

function mapMessageLine(
  line: RolloutLine,
  requestId: string,
  traceId: string | undefined,
): CodeBuddyHistoryMessage[] {
  const role = typeof line.role === 'string' ? line.role : '';
  const provider = asRecord(line.providerData);
  if (role === 'user') {
    const blocks: CodeBuddyContentBlock[] = [];
    const toolResults: CodeBuddyContentBlock[] = [];
    for (const raw of Array.isArray(line.content) ? line.content : []) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'input_text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_result' || block.type === 'tool-result') {
        toolResults.push({
          type: 'tool-result',
          toolCallId: typeof block.call_id === 'string' ? block.call_id : undefined,
          result: block.output ?? block.content,
        });
      }
    }
    if (blocks.length === 0 && toolResults.length === 0) return [];
    const id = typeof line.id === 'string' && line.id.length > 0 ? line.id : `rollout-user:${requestId}:${line.timestamp}`;
    const produced: CodeBuddyHistoryMessage[] = [];
    if (blocks.length > 0) {
      produced.push(makeMessage(id, 'user', blocks, requestId, traceId, line));
    }
    // Tool results carried inside a user message become a separate tool-role
    // message so the builder emits tool.result entries for them.
    if (toolResults.length > 0) {
      produced.push(makeMessage(`${id}:tools`, 'tool', toolResults, requestId, traceId, line));
    }
    return produced;
  }
  if (role === 'assistant') {
    const blocks: CodeBuddyContentBlock[] = [];
    for (const raw of Array.isArray(line.content) ? line.content : []) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === 'output_text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'reasoning' && typeof block.text === 'string') {
        blocks.push({ type: 'reasoning', text: block.text });
      }
    }
    if (blocks.length === 0) return [];
    const id = typeof line.id === 'string' && line.id.length > 0
      ? line.id
      : (typeof provider?.messageId === 'string' ? provider.messageId : `rollout-assistant:${requestId}:${line.timestamp}`);
    return [makeMessage(id, 'assistant', blocks, requestId, traceId, line, {
      modelId: provider?.requestModelId,
      modelName: provider?.requestModelName,
      responseId: provider?.messageId,
    })];
  }
  return [];
}

function mapFunctionCall(
  line: RolloutLine,
  requestId: string,
  traceId: string | undefined,
): CodeBuddyHistoryMessage | null {
  const callId = typeof line.callId === 'string' && line.callId.length > 0
    ? line.callId
    : (typeof line.id === 'string' ? line.id : undefined);
  const name = typeof line.name === 'string' ? line.name : undefined;
  if (!callId || !name) return null;
  let args: unknown = line.arguments;
  if (typeof args === 'string' && args.length > 0) {
    try {
      args = JSON.parse(args);
    } catch {
      // Keep the raw string; toJsonValue in the builder handles primitives.
    }
  }
  const id = `fc:${callId}`;
  return makeMessage(
    id,
    'assistant',
    [{ type: 'tool-call', toolCallId: callId, toolName: name, args }],
    requestId,
    traceId,
    line,
  );
}

function mapFunctionCallResult(
  line: RolloutLine,
  requestId: string,
  traceId: string | undefined,
): CodeBuddyHistoryMessage | null {
  const callId = typeof line.callId === 'string' && line.callId.length > 0
    ? line.callId
    : (typeof line.id === 'string' ? line.id : undefined);
  if (!callId) return null;
  const result = line.output ?? line.result ?? line.content;
  if (result === undefined) return null;
  const id = `fcr:${callId}`;
  return makeMessage(
    id,
    'tool',
    [{ type: 'tool-result', toolCallId: callId, result }],
    requestId,
    traceId,
    line,
  );
}

function mapReasoning(
  line: RolloutLine,
  requestId: string,
  traceId: string | undefined,
): CodeBuddyHistoryMessage | null {
  const text = typeof line.text === 'string' && line.text.length > 0
    ? line.text
    : (typeof line.summary === 'string' ? line.summary : undefined);
  if (!text) return null;
  const id = typeof line.id === 'string' && line.id.length > 0 ? line.id : `reasoning:${requestId}:${line.timestamp}`;
  return makeMessage(id, 'assistant', [{ type: 'reasoning', text }], requestId, traceId, line);
}

function normalizeProcessedMap(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    out[key] = value.filter((item): item is string => typeof item === 'string');
  }
  return out;
}

function normalizeMtimeMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Exposed for tests. */
export const __testing = {
  parseRolloutConversation,
};
