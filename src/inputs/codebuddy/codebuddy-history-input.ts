import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { createLogger } from '../../utils/logger.js';
import { buildCodeBuddyHistoryEvents } from './codebuddy-history-builder.js';
import type {
  CodeBuddyHistoryConversation,
  CodeBuddyHistoryIndex,
  CodeBuddyHistoryMessage,
  CodeBuddyHistoryRequest,
} from './codebuddy-history-types.js';

const logger = createLogger('CodeBuddyHistoryInput');

const INITIALIZED_KEY = 'codebuddyHistoryInitialized';
const PROCESSED_KEY = 'codebuddyHistoryProcessed';
const INDEX_MTIME_KEY = 'codebuddyHistoryIndexMtime';
/** Cap on request ids retained per conversation to bound checkpoint growth. */
const MAX_PROCESSED_PER_CONVERSATION = 4_096;

/** Input id of the CodeBuddy hook stream (shares this input's StateStore). */
const HOOK_INPUT_ID = 'codebuddy';
/** Key inside the hook input's state extra holding the boundary timeline. */
const HOOK_BOUNDARIES_KEY = 'boundaries';

/**
 * Session id → hook-observed boundary evidence (epoch ms). The hook stream
 * keeps the last few boundaries per session; both Stop and UserPromptSubmit
 * are evidence: each proves nothing after it belongs to an earlier turn
 * (CodeBuddy omits Stop when the user aborts a running turn).
 */
export function normalizeStopBoundaries(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number[]> = {};
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!sessionId || typeof sessionId !== 'string') continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const valid = (list: unknown): number[] =>
      Array.isArray(list)
        ? list.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0)
        : [];
    const evidence = [...valid((value as { stops?: unknown }).stops), ...valid((value as { prompts?: unknown }).prompts)];
    if (evidence.length > 0) out[sessionId] = evidence;
  }
  return out;
}

interface ConversationLocation {
  dir: string;
  conversationId: string;
  scope: string;
  workspaceToken: string;
  workspaceHash: string;
  indexPath: string;
}

/**
 * Input for legacy CodeBuddy (CodeBuddy CN / genie extension) session content.
 *
 * Complements {@link CodeBuddyInput}: the hook input delivers real-time turn and
 * tool boundaries (no usage, no message text), while this input reads the
 * persisted conversation history to recover message bodies and token usage.
 * Both key on the same conversation id (`gen_ai.session.id`).
 *
 * The history lives under the extension's cache root — not `~/.codebuddy`:
 *
 *   <cacheBase>/CodeBuddyExtension/Data/<scope>/<product>/<token>/
 *     history/<workspace-md5>/<conversationId>/
 *
 * `<product>` is the client surface that produced the conversation:
 * `CodeBuddyIDE` (standalone IDE), `VSCode` or `JetBrains` (plugins) — all
 * with an identical layout.
 *
 * `<cacheBase>` is `%LOCALAPPDATA%` on Windows (verified in the field; the
 * official FAQ also references `%APPDATA%`, so Roaming is probed too),
 * `~/Library/Application Support` on macOS and `~/.config` on Linux — the
 * standard Electron `userData` locations (mirrors the extension's
 * `getCacheBasePath()`; the official FAQ points at
 * `~/Library/Application Support/CodeBuddyExtension` for permission issues).
 * `~/Library/Caches` (macOS) and `~/.cache` / `~/.local/share` (Linux) remain
 * as compatibility candidates for older builds that used the cache dir.
 * Layout and message encoding are private to the extension and may change
 * between releases, so every read is defensive: an unreadable or reshaped
 * file is skipped for this cycle and retried later.
 */
export class CodeBuddyHistoryInput extends BaseInput {
  readonly id = 'codebuddy-history';
  readonly agentType = ClientType.CodeBuddy;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly dataRoots: string[];
  private watchers: fsSync.FSWatcher[] = [];

  constructor(opts: InputOptions & { dataRoots?: string[] }) {
    super(opts);
    this.dataRoots = opts.dataRoots ?? CodeBuddyHistoryInput.candidateDataRoots();
  }

  /** All plausible `CodeBuddyExtension/Data` roots for this platform. */
  static candidateDataRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
    const bases: string[] = [];
    if (process.platform === 'win32') {
      // The client's own data dir is %LOCALAPPDATA% (verified in the field);
      // the official FAQ references %APPDATA% (Roaming), so both are probed.
      if (env.LOCALAPPDATA) bases.push(env.LOCALAPPDATA);
      if (env.APPDATA) bases.push(env.APPDATA);
      bases.push(path.join(home, 'AppData', 'Local'));
    } else if (process.platform === 'darwin') {
      // Electron's userData on macOS: ~/Library/Application Support (the
      // official FAQ points there for CodeBuddyExtension). ~/Library/Caches
      // stays as a compatibility candidate for older builds.
      bases.push(path.join(home, 'Library', 'Application Support'));
      bases.push(path.join(home, 'Library', 'Caches'));
    } else {
      // Electron's userData on Linux: ~/.config. ~/.cache and ~/.local/share
      // stay as compatibility candidates.
      bases.push(path.join(home, '.config'));
      bases.push(path.join(home, '.cache'));
      bases.push(path.join(home, '.local', 'share'));
    }
    const roots = bases.map(base => path.join(base, 'CodeBuddyExtension', 'Data'));
    return [...new Set(roots)];
  }

  static getWatchPaths(dataRoots = CodeBuddyHistoryInput.candidateDataRoots()): string[] {
    return dataRoots;
  }

  static async checkAvailability(
    dataRoots = CodeBuddyHistoryInput.candidateDataRoots(),
  ): Promise<boolean> {
    for (const root of dataRoots) {
      try {
        if ((await fs.stat(root)).isDirectory()) return true;
      } catch {
        // Try the next candidate.
      }
    }
    return false;
  }

  protected override async onStart(): Promise<void> {
    for (const root of this.dataRoots) this.watchDirectory(root);
  }

  protected override async onStop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const processedBefore = normalizeProcessedMap(state.extra?.[PROCESSED_KEY]);
    const mtimeBefore = normalizeMtimeMap(state.extra?.[INDEX_MTIME_KEY]);

    const discovered = await this.discoverConversations();
    const discoveredIds = new Set(discovered.map(location => location.conversationId));

    // Stop boundaries observed by the CodeBuddyInput hook stream (shared via
    // the same StateStore, keyed by the hook input's id). Read once per cycle.
    const stopBoundaries = normalizeStopBoundaries(
      this.stateStore.get(HOOK_INPUT_ID).extra?.[HOOK_BOUNDARIES_KEY],
    );

    // Drop checkpoints for conversations whose directory no longer exists.
    const processedNow: Record<string, string[]> = {};
    const mtimeNow: Record<string, number> = {};
    for (const [conversationId, ids] of Object.entries(processedBefore)) {
      if (discoveredIds.has(conversationId)) processedNow[conversationId] = ids;
    }
    for (const [conversationId, mtime] of Object.entries(mtimeBefore)) {
      if (discoveredIds.has(conversationId)) mtimeNow[conversationId] = mtime;
    }

    const entries: AgentActivityEntry[] = [];

    for (const location of discovered) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(location.indexPath);
      } catch {
        continue;
      }
      const mtimeMs = Math.trunc(stat.mtimeMs);
      const seenMtime = mtimeNow[location.conversationId];
      mtimeNow[location.conversationId] = mtimeMs;

      const conversation = await this.readConversation(location);
      if (!conversation) continue;

      const requests = conversation.index.requests ?? [];
      const settled = settledRequestIds(requests);
      const processed = new Set(processedNow[location.conversationId] ?? []);

      if (!initialized) {
        // Baseline: mark everything already on disk as processed so an install
        // does not replay the entire pre-existing history.
        processedNow[location.conversationId] = appendProcessed(
          processedNow[location.conversationId] ?? [],
          settled,
        );
        continue;
      }

      // Hook-derived boundary evidence for this conversation (written by the
      // CodeBuddyInput hook stream: Stop and UserPromptSubmit timestamps).
      // Seals turns the store alone cannot close (tool-call endings, cancelled
      // runs) and lets the newest in-flight request be emitted once any
      // boundary proves the run has ended.
      const evidence = stopBoundaries[location.conversationId];
      const boundaryAtMs = evidence ? Math.max(...evidence) : undefined;

      // A not-yet-settled newest request becomes emittable once a boundary
      // (Stop or the next UserPromptSubmit) observed after its start proves
      // the run ended (cancelled or finished without the store reflecting
      // it). Sealing is final: the request is marked processed even though
      // the store may never record 'complete'.
      const lastRequest = requests[requests.length - 1];
      const sealableLast = lastRequest
        && typeof lastRequest.id === 'string' && lastRequest.id.length > 0
        && !settled.includes(lastRequest.id)
        && !processed.has(lastRequest.id)
        && typeof lastRequest.startedAt === 'number'
        && Number.isFinite(lastRequest.startedAt)
        && boundaryAtMs !== undefined
        && boundaryAtMs >= lastRequest.startedAt
        ? lastRequest.id : undefined;

      // Skip unchanged conversations that produced nothing new last cycle.
      // (A pending Stop seal counts as new work even when the store is quiet.)
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
      // Withheld turns (no boundary evidence yet) are NOT marked processed:
      // a later cycle rebuilds them together with their seal record, so the
      // flusher's turn buffer always receives a closed turn.
      const emitIds = (sealableLast ? [...newRequestIds, sealableLast] : newRequestIds)
        .filter(id => !built.unsealedRequestIds.includes(id));
      processedNow[location.conversationId] = appendProcessed(
        processedNow[location.conversationId] ?? [],
        emitIds,
      );
    }

    const nextExtra: Record<string, unknown> = {
      ...state.extra,
      [INITIALIZED_KEY]: true,
      [PROCESSED_KEY]: processedNow,
      [INDEX_MTIME_KEY]: mtimeNow,
    };
    this.setState({ extra: nextExtra });
    return entries;
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

  private async discoverConversations(): Promise<ConversationLocation[]> {
    const found: ConversationLocation[] = [];
    for (const root of this.dataRoots) {
      let scopes: Dirent[];
      try {
        scopes = await fs.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scope of scopes) {
        if (!scope.isDirectory()) continue;
        const scopeDir = path.join(root, scope.name);
        // The store hosts every CodeBuddy client product — the standalone IDE,
        // the VSCode plugin and the JetBrains plugin all persist under their
        // own `<product>` directory with an identical layout. Scan all of them;
        // hardcoding `CodeBuddyIDE` silently drops plugin conversations.
        let products: Dirent[];
        try {
          products = await fs.readdir(scopeDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const product of products) {
          if (!product.isDirectory()) continue;
          await this.scanProductDir(path.join(scopeDir, product.name), scope.name, found);
        }
      }
    }
    return found;
  }

  private async scanProductDir(
    productDir: string,
    scope: string,
    found: ConversationLocation[],
  ): Promise<void> {
    let tokens: Dirent[];
    try {
      tokens = await fs.readdir(productDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const token of tokens) {
      if (!token.isDirectory()) continue;
      await this.scanHistoryDir(path.join(productDir, token.name, 'history'), scope, token.name, found);
    }
  }

  private async scanHistoryDir(
    historyDir: string,
    scope: string,
    workspaceToken: string,
    found: ConversationLocation[],
  ): Promise<void> {
    let workspaceHashes: Dirent[];
    try {
      workspaceHashes = await fs.readdir(historyDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const workspace of workspaceHashes) {
      if (!workspace.isDirectory()) continue;
      const workspaceDir = path.join(historyDir, workspace.name);
      let conversations: Dirent[];
      try {
        conversations = await fs.readdir(workspaceDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const conversation of conversations) {
        if (!conversation.isDirectory()) continue;
        const dir = path.join(workspaceDir, conversation.name);
        found.push({
          dir,
          conversationId: conversation.name,
          scope,
          workspaceToken,
          workspaceHash: workspace.name,
          indexPath: path.join(dir, 'index.json'),
        });
      }
    }
  }

  private async readConversation(
    location: ConversationLocation,
  ): Promise<CodeBuddyHistoryConversation | null> {
    let index: CodeBuddyHistoryIndex;
    try {
      const raw = await fs.readFile(location.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as CodeBuddyHistoryIndex;
      if (!parsed || typeof parsed !== 'object') return null;
      index = parsed;
    } catch {
      // index.json may be mid-rewrite; retry next cycle.
      return null;
    }

    const messages = await this.readMessages(path.join(location.dir, 'messages'));
    return {
      conversationId: location.conversationId,
      index,
      messages,
      scope: location.scope,
      workspaceToken: location.workspaceToken,
      workspaceHash: location.workspaceHash,
    };
  }

  private async readMessages(messagesDir: string): Promise<CodeBuddyHistoryMessage[]> {
    let names: string[];
    try {
      names = await fs.readdir(messagesDir);
    } catch {
      return [];
    }
    const messages: CodeBuddyHistoryMessage[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(messagesDir, name), 'utf8');
        const parsed = JSON.parse(raw) as CodeBuddyHistoryMessage;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.role === 'string') {
          messages.push(parsed);
        }
      } catch {
        // A message file may be partially written; skip it this cycle.
        logger.debug('skipping unreadable codebuddy message file', { file: name });
      }
    }
    return messages;
  }
}

/**
 * Request ids that are safe to emit now. A request is settled when its state is
 * terminal, or when it is not the newest request (an appended newer request
 * proves the earlier one is no longer being written).
 */
export function settledRequestIds(requests: CodeBuddyHistoryRequest[]): string[] {
  const ids: string[] = [];
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    if (!request || typeof request.id !== 'string' || request.id.length === 0) continue;
    if (isRequestSettled(request, index === requests.length - 1)) ids.push(request.id);
  }
  return ids;
}

function isRequestSettled(request: CodeBuddyHistoryRequest, isLast: boolean): boolean {
  const state = (request.state ?? '').toLowerCase();
  if (state === 'complete' || state === 'completed' || state === 'done' || state === 'finished') {
    return true;
  }
  if (state === 'pending' || state === 'streaming' || state === 'generating' || state === 'running') {
    return false;
  }
  // Unknown/absent state: trust anything that is not the newest request.
  return !isLast;
}

export function appendProcessed(existing: string[], added: string[]): string[] {
  const merged = new Set(existing);
  for (const id of added) merged.add(id);
  const list = [...merged];
  return list.length > MAX_PROCESSED_PER_CONVERSATION
    ? list.slice(list.length - MAX_PROCESSED_PER_CONVERSATION)
    : list;
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

/** Exposed for tests: the platform-independent helpers. */
export const __testing = {
  settledRequestIds,
  candidateDataRoots: CodeBuddyHistoryInput.candidateDataRoots,
};
