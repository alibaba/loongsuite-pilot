import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_QODERWORK_ROOT_MAC = '~/Library/Application Support/QoderWork';
const DEFAULT_QODERWORK_ROOT_LINUX = '~/.config/QoderWork';
const DEFAULT_QODERWORK_CN_ROOT_MAC = '~/Library/Application Support/QoderWork CN';
const DEFAULT_QODERWORK_CN_ROOT_LINUX = '~/.config/QoderWork CN';
const SOURCE = 'qoder-work-sdk-log';
const UNKNOWN_MODEL = 'unknown';
const MAX_READ_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const RECEIVED_MSG_RE =
  /^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Received message: (\w+) (.+)$/;
/**
 * `Sending control request: set_model_policy` is the client → SDK control
 * request that pins the LLM model for the next conversation turn(s). The
 * payload's `request.request.chat.model` carries the actual model key (e.g.
 * `qwork-ultimate` for main chat, `qwork-auto` for summarizer/compact). We
 * snapshot this value at every `message_start` so each turn's emitted entries
 * report the model that was active when the turn began.
 */
const SET_MODEL_POLICY_RE =
  /^\[([^\]]+)\] \[(\w+)\] \[SDK\] \[QueryHandler\] Sending control request: set_model_policy (.+)$/;

export interface QoderWorkLogInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  /** Override QoderWork data root (default resolves to platform-specific dir). */
  dataRoot?: string;
  /** Agent type for this instance (default QoderWork). */
  agentType?: ClientType;
}

interface SessionState {
  /**
   * The `model` field on `system init` is the QoderWork subscription tier
   * ("Standard"/"Premium"), NOT the LLM model key. The real model key is
   * captured separately from `Sending control request: set_model_policy`
   * lines and snapshotted onto each ActiveTurn at `message_start`. The tier
   * itself is preserved here and surfaced via `attributes.subscription_tier`.
   */
  subscriptionTier: string;
  cwd: string;
  agents: string[];
  tools: string[];
  lastSeenMs: number;
  traceId: string;
  turnCounter: number;
}

interface ToolCallSlot {
  id: string;
  name: string;
}

interface ActiveTurn {
  messageId: string;
  /** Snapshot of the most recent `set_model_policy.chat.model` at turn start. */
  model: string;
  toolCalls: ToolCallSlot[];
  /** blockIndex -> toolCalls array index */
  toolIndexMap: Map<number, number>;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  startTimestamp: number;
  endTimestamp: number;
}

export type SdkEvent =
  | {
      kind: 'system_init';
      ts: number;
      sessionId: string;
      subscriptionTier: string;
      cwd: string;
      agents: string[];
      tools: string[];
    }
  | {
      /**
       * Client-side control request that pins models for upcoming turns.
       * `chat.model` is the value used by main user turns; `compact.model`
       * and `scene_model.model` are used by summarizer/scene tasks. We only
       * track `chat.model` since that is what each `message_start` consumes.
       */
      kind: 'set_model_policy';
      ts: number;
      chatModel: string;
      compactModel: string;
      sceneModel: string;
    }
  | { kind: 'message_start'; ts: number; sessionId: string; messageId: string }
  | {
      kind: 'block_start';
      ts: number;
      sessionId: string;
      blockType: 'thinking' | 'text' | 'tool_use';
      index: number;
      toolName?: string;
      toolId?: string;
    }
  | {
      kind: 'delta';
      ts: number;
      sessionId: string;
      deltaType: 'thinking_delta' | 'text_delta' | 'input_json_delta';
      content: string;
      blockIndex?: number;
    }
  | { kind: 'message_delta'; ts: number; sessionId: string; stopReason: string; inputTokens: number; outputTokens: number }
  | { kind: 'message_stop'; ts: number; sessionId: string }
  | {
      kind: 'result';
      ts: number;
      sessionId: string;
      subtype: string;
      durationMs: number;
      durationApiMs: number;
      numTurns: number;
      contextUsageRatio: number;
    }
  | { kind: 'post_tool_use'; ts: number; sessionId: string; toolUseId: string; toolName: string; toolResponse: string; transcriptPath: string };

/**
 * Qoder Work — SDK log tail input.
 *
 * Tails QoderWork's `sdk-*.log` files and emits LLM call METADATA only at turn
 * close. We deliberately do NOT reconstruct thinking/text content from
 * `*_delta` events: QoderWork SDK writes log lines asynchronously, so the
 * physical write order in the file does not match the actual LLM token
 * generation order — concatenating deltas by file order produces scrambled
 * text. Conversation content is sourced from the SQLite input instead.
 *
 * Model attribution: `Sending control request: set_model_policy` lines pin
 * the LLM model policy for upcoming turns (separate `chat`, `compact` and
 * `scene_model` slots). We track all three slots and, at every `message_start`,
 * snapshot the slot that matches the session's `subscription_tier` onto the
 * `ActiveTurn` (Premium→chat, Standard→scene_model, fallback to chat). The
 * result is then stamped onto every emitted entry's `gen_ai.{request,response}.model`.
 *
 * Per turn we emit:
 *   - one `llm.response` entry carrying tokens / finish_reasons / message_id /
 *     subscription_tier / cwd / agents / tools.
 *   - one `tool.call` entry per `tool_use` block carrying tool name and id
 *     (arguments are intentionally omitted — same async-ordering issue).
 * On `result` events we additionally emit a session-level `other` summary.
 */
export class QoderWorkLogInput extends BaseSessionInput {
  readonly id: string;
  readonly agentType: ClientType;

  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly activeTurns: Map<string, ActiveTurn> = new Map();
  private pendingEntries: AgentActivityEntry[] = [];
  private currentFilePath: string = '';
  /**
   * Per-file model policy state. Each SDK log file may belong to a different
   * SDK process with its own `set_model_policy` line, so we isolate policy
   * by file path. The policy is restored at the start of each `processLogFile`
   * call and saved back after processing, ensuring cross-poll-cycle continuity
   * without cross-file leakage.
   */
  private readonly fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy: { chat: string; compact: string; scene: string } = {
    chat: '',
    compact: '',
    scene: '',
  };
  constructor(opts: QoderWorkLogInputOptions) {
    const agentType = opts.agentType ?? ClientType.QoderWork;
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot(agentType === ClientType.QoderWorkCN ? 'cn' : 'standard');
    super({
      stateStore: opts.stateStore,
      sessionDir: path.join(dataRoot, 'logs'),
      filePattern: 'sdk-*.log',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.agentType = agentType;
    this.id = `${agentType}-log`;
  }

  static getWatchPaths(): string[] {
    return [path.join(resolveQoderWorkRoot(), 'logs')];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(path.join(resolveQoderWorkRoot(), 'logs'));
  }

  protected override async onStart(): Promise<void> {
    // Baseline: skip already-completed turns on first start, but keep any
    // in-flight turn so its events are emitted once it terminates. We do this
    // by setting the per-file offset to the byte just AFTER the most recent
    // `result` line. Files without a `result` line baseline to 0 (full read).
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = `${this.id}:${filePath}`;
        const prev = this.stateStore.get(stateKey);
        if (prev.lastOffset !== undefined) continue;

        const baselineOffset = await findLastResultBoundary(filePath, stat.size);
        this.stateStore.setOffset(stateKey, baselineOffset);
        this.stateStore.update(stateKey, {
          extra: { inode: (stat as unknown as { ino: number }).ino },
        });
      } catch {
        // file might disappear during rotation
      }
    }
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const sessionPath = path.join(this.sessionDir, dir.name);

      // New layout: <session>/main.log (SDK events mixed into a single file)
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) {
          files.push(mainLogPath);
          continue;
        }
      } catch { /* fall through to legacy layout */ }

      // Legacy layout: <session>/main/sdk-*.log
      const mainDir = path.join(sessionPath, 'main');
      let entries: Dirent[];
      try {
        entries = await fs.readdir(mainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    // BaseSessionInput parses each line via JSON.parse first. For SDK logs
    // (non-JSON), JSON.parse will throw and BaseSessionInput logs a warning.
    // To handle plain text lines, we override collect() below to bypass the
    // JSON parsing path. This method remains as a no-op fallback for any
    // accidental JSON-shaped lines that slip through.
    void record;
    void filePath;
    return null;
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      this.currentFilePath = filePath;
      const fileEntries = await this.processLogFile(filePath);
      allEntries.push(...fileEntries);
    }
    this.currentFilePath = '';

    if (this.pendingEntries.length > 0) {
      allEntries.push(...this.pendingEntries);
      this.pendingEntries = [];
    }

    this.evictStaleSessions();
    return allEntries;
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        this.sessions.delete(id);
        this.activeTurns.delete(id);
      }
    }
  }

  private async processLogFile(filePath: string): Promise<AgentActivityEntry[]> {
    this.currentModelPolicy = this.fileModelPolicies.get(filePath)
      ?? { chat: '', compact: '', scene: '' };
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;
    const currentInode = (stat as unknown as { ino: number }).ino;

    if (prevInode !== undefined && prevInode !== currentInode) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
      this.fileModelPolicies.delete(filePath);
      this.currentModelPolicy = { chat: '', compact: '', scene: '' };
    } else if (prevInode === undefined) {
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    }

    const offset = this.stateStore.getOffset(stateKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    let text: string;
    try {
      const readSize = Math.min(stat.size - offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      text = buf.toString('utf-8');

      // When capped by MAX_READ_BYTES the last "line" is likely truncated.
      // Roll back to the last complete newline so the partial line is re-read
      // next cycle.
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) {
          text = text.substring(0, lastNL);
          consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; // +1 for the \n
        }
      }

      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    const out: AgentActivityEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (!event) continue;
      this.handleEvent(event, filePath, out);
    }

    this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
    return out;
  }

  private handleEvent(
    event: SdkEvent,
    filePath: string,
    out: AgentActivityEntry[],
  ): void {
    switch (event.kind) {
      case 'system_init':
        this.sessions.set(event.sessionId, {
          subscriptionTier: event.subscriptionTier,
          cwd: event.cwd,
          agents: event.agents,
          tools: event.tools,
          lastSeenMs: event.ts,
          traceId: crypto.randomBytes(16).toString('hex'),
          turnCounter: 0,
        });
        // QoderWork CN only sends `set_model_policy` once per SDK process
        // start, which may be skipped by baseline. Use system init's `model`
        // field as a fallback policy seed when no explicit policy has been
        // observed yet (e.g. init.model = "Auto" in CN, "Premium" in intl).
        if (event.subscriptionTier &&
            !this.currentModelPolicy.chat &&
            !this.currentModelPolicy.scene &&
            !this.currentModelPolicy.compact) {
          const candidate = event.subscriptionTier.toLowerCase();
          if (candidate !== 'premium' && candidate !== 'standard') {
            this.currentModelPolicy.chat = candidate;
          }
        }
        return;

      case 'set_model_policy':
        // Pure state update; no entries emitted. Captures all model slots so
        // subsequent `message_start` events can snapshot the correct one
        // based on the session's subscription tier.
        if (event.chatModel) this.currentModelPolicy.chat = event.chatModel;
        if (event.compactModel) this.currentModelPolicy.compact = event.compactModel;
        if (event.sceneModel) this.currentModelPolicy.scene = event.sceneModel;
        return;

      case 'message_start': {
        // close prior turn before starting new one
        this.finalizeTurn(event.sessionId, filePath, out);
        const sess = this.sessions.get(event.sessionId);
        if (sess) {
          sess.lastSeenMs = event.ts;
          sess.turnCounter++;
        }
        this.activeTurns.set(event.sessionId, {
          messageId: event.messageId,
          model: this.pickModelForSession(event.sessionId),
          toolCalls: [],
          toolIndexMap: new Map(),
          stopReason: '',
          inputTokens: 0,
          outputTokens: 0,
          startTimestamp: event.ts,
          endTimestamp: event.ts,
        });
        return;
      }

      case 'block_start': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        if (event.blockType === 'tool_use' && event.toolId && event.toolName) {
          const idx = turn.toolCalls.length;
          turn.toolIndexMap.set(event.index, idx);
          turn.toolCalls.push({ id: event.toolId, name: event.toolName });
        }
        turn.endTimestamp = event.ts;
        return;
      }

      case 'delta': {
        // We intentionally drop content (thinking/text/input_json) — see class
        // doc comment. We only refresh endTimestamp so the turn's emitted
        // entries reflect the latest activity time.
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        turn.endTimestamp = event.ts;
        return;
      }

      case 'message_delta': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return;
        turn.stopReason = event.stopReason;
        turn.inputTokens = event.inputTokens;
        turn.outputTokens = event.outputTokens;
        turn.endTimestamp = event.ts;
        return;
      }

      case 'message_stop': {
        const turn = this.activeTurns.get(event.sessionId);
        if (turn) turn.endTimestamp = event.ts;
        // Do NOT finalize here: message_delta may arrive after message_stop.
        return;
      }

      case 'result': {
        this.finalizeTurn(event.sessionId, filePath, out);
        const session = this.sessions.get(event.sessionId);
        const resultModel = this.pickModelForSession(event.sessionId);
        out.push(
          buildAgentActivityEntry({
            timestamp: event.ts,
            'event.id': hashId([
              filePath,
              event.sessionId,
              'result',
              String(event.ts),
            ]),
            'event.name': 'other',
            trace_id: session?.traceId,
            'gen_ai.session.id': event.sessionId,
            'gen_ai.agent.type': this.agentType,
            'gen_ai.request.model': resultModel,
            'gen_ai.response.model': resultModel,
            attributes: {
              source: SOURCE,
              event_kind: 'result',
              result_subtype: event.subtype,
              duration_ms: event.durationMs,
              duration_api_ms: event.durationApiMs,
              num_turns: event.numTurns,
              context_usage_ratio: event.contextUsageRatio,
              ...sessionAttributes(session),
            },
          }),
        );
        // Keep session state for any follow-up turns; QoderWork can emit
        // additional message_start blocks within the same SDK process after
        // result. Only delete on hard reset (file rotation).
        return;
      }
    }
  }

  /**
   * Select the LLM model key for a session based on its subscription tier.
   * QoderWork emits a single `set_model_policy` payload with parallel slots
   * (chat / compact / scene_model); main user turns (Premium tier) consume
   * `chat`, while summarizer / scene turns (Standard tier) consume
   * `scene_model`. Falls back to chat → compact → UNKNOWN when slots are
   * empty (e.g. before the first policy line is observed).
   */
  private pickModelForSession(sessionId: string): string {
    const tier = this.sessions.get(sessionId)?.subscriptionTier ?? '';
    const policy = this.currentModelPolicy;
    if (tier === 'Standard') {
      return policy.scene || policy.compact || policy.chat || UNKNOWN_MODEL;
    }
    // Premium and any other tier (or unknown) default to the main chat slot.
    return policy.chat || policy.scene || policy.compact || UNKNOWN_MODEL;
  }

  private finalizeTurn(
    sessionId: string,
    filePath: string,
    out: AgentActivityEntry[],
  ): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);

    const session = this.sessions.get(sessionId);
    const model = turn.model || UNKNOWN_MODEL;
    const sharedAttrs = sessionAttributes(session);

    const traceId = session?.traceId;
    const turnId = session ? `${sessionId}:t${session.turnCounter}` : undefined;
    const stepId = turnId ? `${turnId}:s1` : undefined;

    // Emit llm.request at turn start so OTLP flusher can compute span duration
    out.push(
      buildAgentActivityEntry({
        timestamp: turn.startTimestamp,
        'event.id': hashId([filePath, sessionId, turn.messageId, 'request']),
        'event.name': 'llm.request',
        trace_id: traceId,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': this.agentType,
        'gen_ai.request.model': model,
        attributes: { source: SOURCE, event_kind: 'request', ...sharedAttrs },
      }),
    );

    out.push(
      buildAgentActivityEntry({
        timestamp: turn.endTimestamp,
        'event.id': hashId([filePath, sessionId, turn.messageId, 'response']),
        'event.name': 'llm.response',
        trace_id: traceId,
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.response.id': turn.messageId,
        'gen_ai.agent.type': this.agentType,
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.usage.input_tokens': finiteNum(turn.inputTokens),
        'gen_ai.usage.output_tokens': finiteNum(turn.outputTokens),
        'gen_ai.usage.total_tokens': sumIfPresent(
          finiteNum(turn.inputTokens),
          finiteNum(turn.outputTokens),
        ),
        'gen_ai.response.finish_reasons': turn.stopReason ? [turn.stopReason] : undefined,
        attributes: {
          source: SOURCE,
          event_kind: 'response',
          message_id: turn.messageId,
          tool_use_count: turn.toolCalls.length,
          ...sharedAttrs,
        },
      }),
    );

    for (let i = 0; i < turn.toolCalls.length; i++) {
      const tc = turn.toolCalls[i];
      out.push(
        buildAgentActivityEntry({
          timestamp: turn.endTimestamp,
          'event.id': hashId([
            filePath,
            sessionId,
            turn.messageId,
            'tool_use',
            tc.id,
            String(i),
          ]),
          'event.name': 'tool.call',
          trace_id: traceId,
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.response.id': turn.messageId,
          'gen_ai.agent.type': this.agentType,
          'gen_ai.request.model': model,
          'gen_ai.response.model': model,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          attributes: {
            source: SOURCE,
            event_kind: 'tool_use',
            message_id: turn.messageId,
            tool_index: i,
            ...sharedAttrs,
          },
        }),
      );
    }
  }
}

/**
 * Per-session attributes shared by every entry (tier/cwd/agents/tools).
 * Returns an empty object when session state is missing.
 */
function sessionAttributes(session: SessionState | undefined): Record<string, JsonValue> {
  if (!session) return {};
  const out: Record<string, JsonValue> = {};
  if (session.subscriptionTier) out.subscription_tier = session.subscriptionTier;
  if (session.cwd) out.cwd = session.cwd;
  if (session.agents.length > 0) out.agents = session.agents;
  if (session.tools.length > 0) out.tools = session.tools;
  return out;
}

export function resolveQoderWorkRoot(variant: 'standard' | 'cn' = 'standard'): string {
  if (process.platform === 'darwin') {
    return resolveHome(variant === 'cn' ? DEFAULT_QODERWORK_CN_ROOT_MAC : DEFAULT_QODERWORK_ROOT_MAC);
  }
  const dirName = variant === 'cn' ? 'QoderWork CN' : 'QoderWork';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), dirName);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, dirName);
  return resolveHome(variant === 'cn' ? DEFAULT_QODERWORK_CN_ROOT_LINUX : DEFAULT_QODERWORK_ROOT_LINUX);
}

export function parseSdkLogLine(line: string): SdkEvent | null {
  const policyMatch = SET_MODEL_POLICY_RE.exec(line);
  if (policyMatch) {
    const [, tsStr, , jsonStr] = policyMatch;
    const ts = Date.parse(tsStr);
    const tsNum = Number.isNaN(ts) ? Date.now() : ts;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return null;
    }
    // Payload shape:
    //   { requestId, request: { type, request_id,
    //       request: { subtype: 'set_model_policy', chat:{model}, compact:{model}, scene_model:{model} } } }
    const outer = (envelope.request && typeof envelope.request === 'object'
      ? (envelope.request as Record<string, unknown>).request
      : undefined);
    const inner = (outer && typeof outer === 'object' ? outer : {}) as Record<string, unknown>;
    return {
      kind: 'set_model_policy',
      ts: tsNum,
      chatModel: extractModel(inner.chat),
      compactModel: extractModel(inner.compact),
      sceneModel: extractModel(inner.scene_model),
    };
  }

  const match = RECEIVED_MSG_RE.exec(line);
  if (!match) return null;
  const [, tsStr, , msgType, jsonStr] = match;
  const ts = Date.parse(tsStr);
  const tsNum = Number.isNaN(ts) ? Date.now() : ts;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (msgType === 'system' && (data.subtype === 'init' || data.type === 'init')) {
    return {
      kind: 'system_init',
      ts: tsNum,
      sessionId: stringOr(data.session_id, ''),
      subscriptionTier: stringOr(data.model, ''),
      cwd: stringOr(data.cwd, ''),
      agents: arrayOfString(data.agents),
      tools: arrayOfString(data.tools),
    };
  }

  if (msgType === 'stream_event' && data.event && typeof data.event === 'object') {
    return parseStreamEvent(tsNum, stringOr(data.session_id, ''), data.event as Record<string, unknown>);
  }

  if (msgType === 'result') {
    return {
      kind: 'result',
      ts: tsNum,
      sessionId: stringOr(data.session_id, ''),
      subtype: stringOr(data.subtype, ''),
      durationMs: numberOr(data.duration_ms, 0),
      durationApiMs: numberOr(data.duration_api_ms, 0),
      numTurns: numberOr(data.num_turns, 0),
      contextUsageRatio: numberOr(data.context_usage_ratio, 0),
    };
  }

  if (msgType === 'control_request') {
    const req = data.request as Record<string, unknown> | undefined;
    const input = (req && typeof req === 'object'
      ? (req as Record<string, unknown>).input
      : undefined) as Record<string, unknown> | undefined;
    if (input && input.hook_event_name === 'PostToolUse') {
      return {
        kind: 'post_tool_use',
        ts: tsNum,
        sessionId: stringOr(input.session_id, ''),
        toolUseId: stringOr(input.tool_use_id, ''),
        toolName: stringOr(input.tool_name, ''),
        toolResponse: stringOr(input.tool_response, ''),
        transcriptPath: stringOr(input.transcript_path, ''),
      };
    }
    return null;
  }

  return null;
}

function parseStreamEvent(
  ts: number,
  sessionId: string,
  event: Record<string, unknown>,
): SdkEvent | null {
  const type = stringOr(event.type, '');
  switch (type) {
    case 'message_start': {
      const message = (event.message && typeof event.message === 'object'
        ? event.message
        : {}) as Record<string, unknown>;
      return {
        kind: 'message_start',
        ts,
        sessionId,
        messageId: stringOr(message.id, ''),
      };
    }
    case 'content_block_start': {
      const block = (event.content_block && typeof event.content_block === 'object'
        ? event.content_block
        : null) as Record<string, unknown> | null;
      if (!block) return null;
      const blockType = stringOr(block.type, '');
      if (blockType === 'thinking' || blockType === 'text') {
        return {
          kind: 'block_start',
          ts,
          sessionId,
          blockType,
          index: numberOr(event.index, 0),
        };
      }
      if (blockType === 'tool_use') {
        return {
          kind: 'block_start',
          ts,
          sessionId,
          blockType: 'tool_use',
          index: numberOr(event.index, 0),
          toolName: stringOr(block.name, ''),
          toolId: stringOr(block.id, ''),
        };
      }
      return null;
    }
    case 'content_block_delta': {
      const delta = (event.delta && typeof event.delta === 'object'
        ? event.delta
        : null) as Record<string, unknown> | null;
      if (!delta) return null;
      const deltaType = stringOr(delta.type, '');
      if (deltaType === 'thinking_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'thinking_delta',
          content: stringOr(delta.thinking, ''),
        };
      }
      if (deltaType === 'text_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'text_delta',
          content: stringOr(delta.text, ''),
        };
      }
      if (deltaType === 'input_json_delta') {
        return {
          kind: 'delta',
          ts,
          sessionId,
          deltaType: 'input_json_delta',
          content: stringOr(delta.partial_json, ''),
          blockIndex: numberOr(event.index, -1),
        };
      }
      return null;
    }
    case 'message_delta': {
      const delta = (event.delta && typeof event.delta === 'object'
        ? event.delta
        : {}) as Record<string, unknown>;
      const usage = (event.usage && typeof event.usage === 'object'
        ? event.usage
        : {}) as Record<string, unknown>;
      return {
        kind: 'message_delta',
        ts,
        sessionId,
        stopReason: stringOr(delta.stop_reason, ''),
        inputTokens: numberOr(usage.input_tokens, 0),
        outputTokens: numberOr(usage.output_tokens, 0),
      };
    }
    case 'message_stop':
      return { kind: 'message_stop', ts, sessionId };
    default:
      return null;
  }
}

function hashId(parts: Array<string | number | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map(p => p ?? '').join('\0'))
    .digest('hex');
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteNum(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function arrayOfString(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function extractModel(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  return stringOr(obj.model, '');
}

function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

/**
 * Scan a sdk log file backwards and return the byte offset just AFTER the
 * newline that terminates the most recent `Received message: result` line.
 * If no result line exists, return 0 (full read). The scan reads the tail of
 * the file in 64 KiB chunks to avoid loading huge logs into memory.
 */
async function findLastResultBoundary(filePath: string, size: number): Promise<number> {
  if (size <= 0) return 0;
  const CHUNK = 64 * 1024;
  const handle = await fs.open(filePath, 'r');
  try {
    let cursor = size;
    let tail = '';
    while (cursor > 0) {
      const readSize = Math.min(CHUNK, cursor);
      cursor -= readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, cursor);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // Keep first chunk fragment for next iteration to handle line splits.
      const fragment = cursor > 0 ? lines.shift() ?? '' : '';
      // Walk lines from end to start within the assembled tail (excluding
      // the leading fragment we still need to combine with previous chunk).
      let runningOffset = cursor + Buffer.byteLength(fragment, 'utf-8');
      // We need offsets per line; rebuild them by re-walking from start.
      const offsets: number[] = [];
      let off = runningOffset;
      for (const line of lines) {
        offsets.push(off);
        off += Buffer.byteLength(line, 'utf-8') + 1; // +1 for the \n
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('Received message: result ')) {
          // Boundary is just after this line's terminating newline.
          return offsets[i] + Buffer.byteLength(lines[i], 'utf-8') + 1;
        }
      }
      tail = fragment;
    }
    return 0;
  } finally {
    await handle.close();
  }
}
