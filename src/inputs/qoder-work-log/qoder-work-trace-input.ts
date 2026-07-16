import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import sqlite3 from 'sqlite3';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { directoryExists } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import {
  parseSdkLogLine,
  resolveQoderWorkRoot,
  type QoderWorkLogInputOptions,
  type SdkEvent,
} from './qoder-work-log-input.js';

// ─── constants ───────────────────────────────────────────────────────────────

const UNKNOWN_MODEL = 'unknown';
const MAX_READ_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PROMPT_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
const WINDOW_STATE_LIMIT = 500;
const TURN_COUNTER_STATE_LIMIT = 500;
const DB_MESSAGE_LIMIT = 2000;
const DB_REL_PATH = path.join('data', 'agents.db');

function msToNanos(ms: number): string {
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}

// ─── types ───────────────────────────────────────────────────────────────────

interface ToolCallSlot {
  id: string;
  name: string;
  argumentsJson: string;
  startTs: number;
  endTs: number;
}

interface ActiveTurn {
  messageId: string;
  model: string;
  startTimestamp: number;
  endTimestamp: number;
  thinkingContent: string;
  textContent: string;
  toolCalls: ToolCallSlot[];
  toolIndexMap: Map<number, number>;
  toolArgJsonMap: Map<number, string>;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

interface SessionState {
  subscriptionTier: string;
  cwd: string;
  agents: string[];
  tools: string[];
  startTime: number;
  lastSeenMs: number;
  turns: ActiveTurn[];
}

interface DbUserPrompt {
  id: string;
  text: string;
  updatedAtMs: number;
  sequence: number;
}

interface DbSessionData {
  userPrompts: DbUserPrompt[];
  toolResults: Array<{ toolCallId: string; result: string }>;
}

interface CompletedSessionWindow {
  session: SessionState;
  sessionId: string;
  resultId?: string;
  resultTimestamp?: number;
}

interface TurnIdentity {
  sessionId: string;
  turnId: string;
  emitKey: string;
  userPrompt?: DbUserPrompt;
  fallbackCounter?: number;
}

// ─── main input ──────────────────────────────────────────────────────────────

export class QoderWorkTraceInput extends BaseSessionInput {
  readonly id: string;
  readonly agentType: ClientType;

  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly activeTurns: Map<string, ActiveTurn> = new Map();
  private readonly fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy = { chat: '', compact: '', scene: '' };
  private sessionToolResults = new Map<string, Map<string, string>>();
  private sessionToolResultDirs = new Map<string, string>();
  private readonly dbPath: string;
  private readonly projectsDir: string;
  private readonly source: string;
  private configuredUserId = '';

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
    this.id = `${agentType}-trace`;
    this.source = agentType === ClientType.QoderWorkCN ? 'qoder-work-cn-trace' : 'qoder-work-trace';
    this.dbPath = path.join(dataRoot, DB_REL_PATH);
    const cliHome = path.join(os.homedir(), agentType === ClientType.QoderWorkCN ? '.qoderworkcn' : '.qoderwork');
    this.projectsDir = path.join(cliHome, 'projects');
  }

  setUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  static getWatchPaths(): string[] {
    return [path.join(resolveQoderWorkRoot('standard'), 'logs')];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(path.join(resolveQoderWorkRoot('standard'), 'logs'));
  }

  protected override async onStart(): Promise<void> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = `${this.id}:${filePath}`;
        const prev = this.stateStore.get(stateKey);
        if (prev.lastOffset !== undefined) continue;
        const baselineOffset = await findLastResultBoundary(filePath, stat.size);
        this.stateStore.setOffset(stateKey, baselineOffset);
        this.stateStore.update(stateKey, { extra: { inode: (stat as unknown as { ino: number }).ino } });
      } catch { /* skip */ }
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
      const mainLogPath = path.join(sessionPath, 'main.log');
      try {
        const st = await fs.stat(mainLogPath);
        if (st.isFile()) { files.push(mainLogPath); continue; }
      } catch { /* fall through */ }
      const mainDir = path.join(sessionPath, 'main');
      let entries: Dirent[];
      try { entries = await fs.readdir(mainDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('sdk-') && entry.name.endsWith('.log')) {
          files.push(path.join(mainDir, entry.name));
        }
      }
    }
    return files.sort();
  }

  protected async processSessionLine(): Promise<AgentActivityEntry | null> {
    return null;
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const completedSessions: CompletedSessionWindow[] = [];

    for (const filePath of files) {
      const completed = await this.processLogFile(filePath);
      completedSessions.push(...completed);
    }

    const evicted = this.evictStaleSessions();
    completedSessions.push(...evicted);

    const allEntries: AgentActivityEntry[] = [];
    for (const completed of completedSessions) {
      const entries = await this.emitSessionSpans(completed);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  // ─── SDK log processing ────────────────────────────────────────────────────

  private async processLogFile(filePath: string): Promise<CompletedSessionWindow[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try { stat = await fs.stat(filePath); } catch { return []; }

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

    // Restore model policy from persisted state (survives process restarts)
    const persistedPolicy = prevState.extra?.modelPolicy as { chat?: string; compact?: string; scene?: string } | undefined;
    this.currentModelPolicy = this.fileModelPolicies.get(filePath)
      ?? (persistedPolicy ? { chat: persistedPolicy.chat ?? '', compact: persistedPolicy.compact ?? '', scene: persistedPolicy.scene ?? '' }
        : { chat: '', compact: '', scene: '' });

    const offset = this.stateStore.getOffset(stateKey);
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    let text: string;
    try {
      const readSize = Math.min(stat.size - offset, MAX_READ_BYTES);
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      text = buf.toString('utf-8');
      let consumedBytes = readSize;
      if (readSize < stat.size - offset) {
        const lastNL = text.lastIndexOf('\n');
        if (lastNL >= 0) { text = text.substring(0, lastNL); consumedBytes = Buffer.byteLength(text, 'utf-8') + 1; }
      }
      this.stateStore.setOffset(stateKey, offset + consumedBytes);
      this.stateStore.update(stateKey, { extra: { inode: currentInode } });
    } finally {
      await handle.close();
    }

    const completed: CompletedSessionWindow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseSdkLogLine(line);
      if (!event) continue;
      const result = this.handleEvent(event);
      if (result) completed.push(result);
    }

    this.fileModelPolicies.set(filePath, { ...this.currentModelPolicy });
    // Persist model policy so it survives process restarts
    this.stateStore.update(stateKey, {
      extra: { inode: currentInode, modelPolicy: { ...this.currentModelPolicy } },
    });
    return completed;
  }

  private ensureSession(sessionId: string, ts: number): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { subscriptionTier: '', cwd: '', agents: [], tools: [], startTime: ts, lastSeenMs: ts, turns: [] };
      this.sessions.set(sessionId, session);
    }
    session.lastSeenMs = ts;
    return session;
  }

  private handleEvent(event: SdkEvent): CompletedSessionWindow | null {
    switch (event.kind) {
      case 'system_init': {
        const session = this.ensureSession(event.sessionId, event.ts);
        session.subscriptionTier = event.subscriptionTier;
        session.cwd = event.cwd;
        session.agents = event.agents;
        session.tools = event.tools;
        // QoderWork CN only sends set_model_policy once per SDK process start,
        // which may be skipped by baseline. Use system init model field as fallback.
        if (event.subscriptionTier &&
            !this.currentModelPolicy.chat &&
            !this.currentModelPolicy.scene &&
            !this.currentModelPolicy.compact) {
          const candidate = event.subscriptionTier.toLowerCase();
          if (candidate !== 'premium' && candidate !== 'standard') {
            this.currentModelPolicy.chat = candidate;
          }
        }
        return null;
      }

      case 'set_model_policy':
        if (event.chatModel) this.currentModelPolicy.chat = event.chatModel;
        if (event.compactModel) this.currentModelPolicy.compact = event.compactModel;
        if (event.sceneModel) this.currentModelPolicy.scene = event.sceneModel;
        return null;

      case 'message_start': {
        this.ensureSession(event.sessionId, event.ts);
        this.finalizeTurn(event.sessionId);
        this.activeTurns.set(event.sessionId, {
          messageId: event.messageId,
          model: this.pickModelForSession(event.sessionId),
          startTimestamp: event.ts,
          endTimestamp: event.ts,
          thinkingContent: '',
          textContent: '',
          toolCalls: [],
          toolIndexMap: new Map(),
          toolArgJsonMap: new Map(),
          stopReason: '',
          inputTokens: 0,
          outputTokens: 0,
        });
        return null;
      }

      case 'block_start': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        if (event.blockType === 'tool_use' && event.toolId && event.toolName) {
          const idx = turn.toolCalls.length;
          turn.toolIndexMap.set(event.index, idx);
          turn.toolCalls.push({
            id: event.toolId, name: event.toolName, argumentsJson: '',
            startTs: event.ts, endTs: event.ts,
          });
        }
        turn.endTimestamp = event.ts;
        return null;
      }

      case 'delta': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.endTimestamp = event.ts;
        if (event.deltaType === 'thinking_delta') {
          turn.thinkingContent += event.content;
        } else if (event.deltaType === 'text_delta') {
          turn.textContent += event.content;
        } else if (event.deltaType === 'input_json_delta' && event.blockIndex !== undefined) {
          const tcIdx = turn.toolIndexMap.get(event.blockIndex);
          if (tcIdx !== undefined) {
            const prev = turn.toolArgJsonMap.get(event.blockIndex) ?? '';
            turn.toolArgJsonMap.set(event.blockIndex, prev + event.content);
            turn.toolCalls[tcIdx].endTs = event.ts;
          }
        }
        return null;
      }

      case 'message_delta': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.stopReason = event.stopReason;
        turn.inputTokens = event.inputTokens;
        turn.outputTokens = event.outputTokens;
        turn.endTimestamp = event.ts;
        for (const tc of turn.toolCalls) tc.endTs = event.ts;
        return null;
      }

      case 'message_stop': {
        const turn = this.activeTurns.get(event.sessionId);
        if (!turn) return null;
        turn.endTimestamp = event.ts;
        for (const tc of turn.toolCalls) tc.endTs = event.ts;
        return null;
      }

      case 'result': {
        this.finalizeTurn(event.sessionId);
        const session = this.sessions.get(event.sessionId);
        if (!session) return null;
        this.sessions.delete(event.sessionId);
        this.activeTurns.delete(event.sessionId);
        return {
          session,
          sessionId: event.sessionId,
          resultId: event.resultId,
          resultTimestamp: event.ts,
        };
      }

      case 'post_tool_use': {
        if (!event.sessionId || !event.toolUseId) return null;
        this.ensureSession(event.sessionId, event.ts);
        let map = this.sessionToolResults.get(event.sessionId);
        if (!map) { map = new Map(); this.sessionToolResults.set(event.sessionId, map); }
        map.set(event.toolUseId, event.toolResponse);
        if (event.transcriptPath && !this.sessionToolResultDirs.has(event.sessionId)) {
          const dir = path.join(path.dirname(event.transcriptPath), event.sessionId, 'tool-results');
          this.sessionToolResultDirs.set(event.sessionId, dir);
        }
        return null;
      }
    }
  }

  private finalizeTurn(sessionId: string): void {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) return;
    this.activeTurns.delete(sessionId);

    // Assemble tool arguments from accumulated JSON deltas
    for (const [blockIndex, json] of turn.toolArgJsonMap) {
      const tcIdx = turn.toolIndexMap.get(blockIndex);
      if (tcIdx !== undefined && turn.toolCalls[tcIdx]) {
        turn.toolCalls[tcIdx].argumentsJson = json;
      }
    }

    // Skip empty turns (no content, no tokens, no tool calls) to avoid ghost spans
    if (!turn.thinkingContent && !turn.textContent && turn.toolCalls.length === 0
        && turn.inputTokens === 0 && turn.outputTokens === 0) {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (session) session.turns.push(turn);
  }

  private pickModelForSession(sessionId: string): string {
    const tier = this.sessions.get(sessionId)?.subscriptionTier ?? '';
    const policy = this.currentModelPolicy;
    if (tier === 'Standard') return policy.scene || policy.compact || policy.chat || UNKNOWN_MODEL;
    return policy.chat || policy.scene || policy.compact || UNKNOWN_MODEL;
  }

  private evictStaleSessions(): CompletedSessionWindow[] {
    const now = Date.now();
    const evicted: CompletedSessionWindow[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        this.finalizeTurn(id);
        if (session.turns.length > 0) {
          evicted.push({ session, sessionId: id });
        }
        this.sessions.delete(id);
        this.activeTurns.delete(id);
        this.cleanupSessionCaches(id);
      }
    }
    return evicted;
  }

  private async findToolResultDir(sessionId: string): Promise<string | null> {
    try {
      const projectDirs = await fs.readdir(this.projectsDir, { withFileTypes: true });
      for (const d of projectDirs) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(this.projectsDir, d.name, sessionId, 'tool-results');
        try {
          const st = await fs.stat(candidate);
          if (st.isDirectory()) return candidate;
        } catch { /* not found, try next */ }
      }
    } catch { /* projects dir may not exist */ }
    return null;
  }

  // ─── SQLite DB reader ──────────────────────────────────────────────────────

  private async readDbSessionData(sessionId: string): Promise<DbSessionData | null> {
    try {
      await fs.access(this.dbPath);
    } catch {
      return null;
    }

    try {
      const userPrompts: DbUserPrompt[] = [];
      const toolResults: DbSessionData['toolResults'] = [];

      // Strategy 1: sub_chats.messages (standard QoderWork format)
      const rows = await queryReadonly<{ messages: string }>(
        this.dbPath,
        `SELECT sc.messages FROM sub_chats sc WHERE sc.session_id = ? AND sc.messages IS NOT NULL AND sc.messages != '[]'`,
        [sessionId],
      );

      for (const row of rows) {
        let messages: unknown[];
        try { messages = JSON.parse(row.messages); } catch { continue; }
        if (!Array.isArray(messages)) continue;

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg || typeof msg !== 'object') continue;
          const m = msg as Record<string, unknown>;

          if (m.role === 'user') {
            const text = extractUserText(m);
            if (text) {
              userPrompts.push({
                id: stringFrom(m.id) || stringFrom(m.uuid) || `subchat-${i}`,
                text,
                updatedAtMs: millisFromUnknown(m.timestamp) ?? millisFromUnknown(m.created_at) ?? 0,
                sequence: i,
              });
            }
          }

          if (m.role === 'assistant' && Array.isArray(m.parts)) {
            collectToolResultsFromParts(m.parts as Array<Record<string, unknown>>, toolResults);
          }
        }
      }

      if (userPrompts.length === 0 && toolResults.length === 0) {
        const msgRows = await queryReadonly<{ id: string; role: string; parts: string; updatedAt: number; sequence: number }>(
          this.dbPath,
          `SELECT m.id AS id, m.role AS role, m.parts AS parts, m.updated_at AS updatedAt, m.sequence AS sequence
           FROM messages m
           JOIN sub_chats sc ON m.sub_chat_id = sc.id
           WHERE sc.session_id = ?
             AND m.parts IS NOT NULL
             AND m.parts != ''
             AND m.parts != '[]'
           ORDER BY m.sequence ASC, m.updated_at ASC
           LIMIT ${DB_MESSAGE_LIMIT}`,
          [sessionId],
        );

        for (const row of msgRows) {
          let parsed: unknown;
          try { parsed = JSON.parse(row.parts); } catch { continue; }
          if (!Array.isArray(parsed)) continue;

          if (row.role === 'user') {
            const text = extractUserText({ parts: parsed });
            if (text) {
              userPrompts.push({
                id: row.id,
                text,
                updatedAtMs: row.updatedAt > 0 ? row.updatedAt * 1000 : 0,
                sequence: row.sequence,
              });
            }
          } else if (row.role === 'assistant') {
            collectToolResultsFromParts(parsed as Array<Record<string, unknown>>, toolResults);
          }
        }
      }

      userPrompts.sort((a, b) => a.sequence - b.sequence || a.updatedAtMs - b.updatedAtMs);
      return userPrompts.length > 0 || toolResults.length > 0 ? { userPrompts, toolResults } : null;
    } catch (err) {
      this.logger.warn('failed to read qoder-work sqlite for trace', { error: String(err) });
      return null;
    }
  }

  // ─── Span tree emitter ─────────────────────────────────────────────────────

  private async emitSessionSpans(completed: CompletedSessionWindow): Promise<AgentActivityEntry[]> {
    const { session, sessionId, resultId, resultTimestamp } = completed;
    if (session.turns.length === 0) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    const physicalEmitKey = this.resolvePhysicalEmitKey(sessionId, session, resultId, resultTimestamp);
    if (this.hasEmittedWindow(physicalEmitKey)) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    const dbData = await this.readDbSessionData(sessionId);
    const identity = this.resolveTurnIdentity(sessionId, session, physicalEmitKey, dbData, resultTimestamp);
    if (!identity || this.hasEmittedWindow(identity.emitKey)) {
      this.cleanupSessionCaches(sessionId);
      return [];
    }

    const toolResultMap = new Map<string, string>();
    const sdkToolResults = this.sessionToolResults.get(sessionId);
    if (sdkToolResults) {
      for (const [k, v] of sdkToolResults) toolResultMap.set(k, v);
    }
    if (dbData?.toolResults) {
      for (const tr of dbData.toolResults) {
        if (!toolResultMap.has(tr.toolCallId)) toolResultMap.set(tr.toolCallId, tr.result);
      }
    }

    // Fallback: read tool results from tool-results directory (CN stores results as individual files)
    const missingIds: string[] = [];
    for (const turn of session.turns) {
      for (const tc of turn.toolCalls) {
        if (!toolResultMap.has(tc.id)) missingIds.push(tc.id);
      }
    }
    if (missingIds.length > 0) {
      const toolResultDir = this.sessionToolResultDirs.get(sessionId) ?? await this.findToolResultDir(sessionId);
      if (toolResultDir) {
        for (const toolId of missingIds) {
          try {
            const content = await fs.readFile(path.join(toolResultDir, `${toolId}.txt`), 'utf-8');
            toolResultMap.set(toolId, content);
          } catch { /* file may not exist */ }
        }
      }
    }

    const traceId = crypto.randomBytes(16).toString('hex');

    const startTime = session.turns[0].startTimestamp;
    const model = session.turns[0].model || UNKNOWN_MODEL;
    const userId = this.configuredUserId || undefined;
    const turnId = identity.turnId;

    const entries: AgentActivityEntry[] = [];

    const baseFields = {
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.agent.type': this.agentType,
      'gen_ai.request.model': model,
      'user.id': userId,
    };

    // ── User prompt (other event, attached to s1 so converter does not create an empty STEP) ──
    const matchedPrompt = identity.userPrompt;
    const firstStepId = `${turnId}:s1`;
    const entryTime = matchedPrompt?.updatedAtMs && matchedPrompt.updatedAtMs > 0
      ? matchedPrompt.updatedAtMs
      : session.startTime < startTime ? session.startTime : startTime - 100;
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      'gen_ai.request.model': undefined,
      'gen_ai.step.id': firstStepId,
      time_unix_nano: msToNanos(entryTime),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      'gen_ai.input.messages_delta': matchedPrompt?.text
        ? [{ role: 'user', parts: [{ type: 'text', content: matchedPrompt.text }] }]
        : undefined,
      attributes: { source: this.source },
    }));

    // Track per-step entries for overlap capping
    const stepEntryGroups: Array<{ stepId: string; entries: AgentActivityEntry[] }> = [];

    // ── Per-step events (flat, no explicit span_id — converter infers hierarchy) ──
    for (let round = 0; round < session.turns.length; round++) {
      const turn = session.turns[round];
      const stepId = `${turnId}:s${round + 1}`;
      const turnModel = turn.model || model;
      const isLastStep = round === session.turns.length - 1;

      const stepFields = { ...baseFields, 'gen_ai.step.id': stepId, 'gen_ai.request.model': turnModel };
      const stepEntries: AgentActivityEntry[] = [];

      // Build input.messages_delta (step1=user prompt, stepN=prev tool results)
      let inputDelta: JsonValue | undefined;
      if (round === 0 && matchedPrompt?.text) {
        inputDelta = [{ role: 'user', parts: [{ type: 'text', content: matchedPrompt.text }] }];
      } else if (round > 0) {
        const prevTurn = session.turns[round - 1];
        if (prevTurn && prevTurn.toolCalls.length > 0) {
          const toolParts: JsonValue[] = [];
          for (const tc of prevTurn.toolCalls) {
            const result = toolResultMap.get(tc.id);
            if (result) {
              toolParts.push({ type: 'tool_call_response', id: tc.id, response: result });
            }
          }
          if (toolParts.length > 0) {
            inputDelta = [{ role: 'tool', parts: toolParts }];
          }
        }
      }

      // llm.request for this step
      const stepRequest = buildAgentActivityEntry({
        ...stepFields,
        time_unix_nano: msToNanos(turn.startTimestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        'gen_ai.input.messages_delta': inputDelta,
        attributes: { source: this.source },
      });
      entries.push(stepRequest);
      stepEntries.push(stepRequest);

      // Build output parts
      const outputParts: JsonValue[] = [];
      if (turn.thinkingContent) outputParts.push({ type: 'reasoning', content: turn.thinkingContent });
      if (turn.textContent) outputParts.push({ type: 'text', content: turn.textContent });
      if (turn.toolCalls.length > 0) {
        for (const tc of turn.toolCalls) {
          const toolPart: Record<string, JsonValue> = {
            type: 'tool_call',
            id: tc.id,
            name: tc.name,
          };
          const args = safeParseJson(tc.argumentsJson);
          if (args !== undefined) toolPart.arguments = args;
          outputParts.push(toolPart);
        }
      }

      const finishReason = turn.toolCalls.length > 0 ? 'tool_calls' : (isLastStep ? 'end_turn' : 'stop');
      const outputMessages: JsonValue | undefined = outputParts.length > 0
        ? [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }]
        : undefined;

      // llm.response for this step
      const llmResponse = buildAgentActivityEntry({
        ...stepFields,
        time_unix_nano: msToNanos(turn.endTimestamp),
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        'gen_ai.response.id': turn.messageId,
        'gen_ai.response.model': turnModel,
        'gen_ai.usage.input_tokens': finiteNum(turn.inputTokens),
        'gen_ai.usage.output_tokens': finiteNum(turn.outputTokens),
        'gen_ai.usage.total_tokens': sumIfPresent(finiteNum(turn.inputTokens), finiteNum(turn.outputTokens)),
        'gen_ai.response.finish_reasons': [finishReason],
        'gen_ai.output.messages': outputMessages,
        attributes: { source: this.source },
      });
      entries.push(llmResponse);
      stepEntries.push(llmResponse);

      // tool.call + tool.result events
      for (const tc of turn.toolCalls) {
        const toolResult = toolResultMap.get(tc.id);

        const toolCall = buildAgentActivityEntry({
          ...stepFields,
          time_unix_nano: msToNanos(tc.startTs),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.call',
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.arguments': safeParseJson(tc.argumentsJson),
          attributes: { source: this.source },
        });
        entries.push(toolCall);
        stepEntries.push(toolCall);

        const toolResultEntry = buildAgentActivityEntry({
          ...stepFields,
          time_unix_nano: msToNanos(tc.endTs),
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.result': toolResult ?? undefined,
          'gen_ai.tool.call.duration': tc.endTs > tc.startTs ? tc.endTs - tc.startTs : undefined,
          attributes: { source: this.source },
        });
        entries.push(toolResultEntry);
        stepEntries.push(toolResultEntry);
      }

      stepEntryGroups.push({ stepId, entries: stepEntries });
    }

    // ── STEP overlap capping ──
    for (let i = 0; i < stepEntryGroups.length - 1; i++) {
      const currentStep = stepEntryGroups[i];
      const nextStep = stepEntryGroups[i + 1];
      const nextRequest = nextStep.entries.find(e => e['event.name'] === 'llm.request');
      if (!nextRequest) continue;
      const nextStartNano = nextRequest.time_unix_nano;
      if (!nextStartNano) continue;
      const nextStartBig = BigInt(nextStartNano);
      const capNano = String(nextStartBig - 1_000_000n);

      for (const e of currentStep.entries) {
        if (e['event.name'] !== 'tool.result') continue;
        const ts = e.time_unix_nano;
        if (ts && BigInt(ts) > nextStartBig) {
          (e as Record<string, unknown>)['time_unix_nano'] = capNano;
        }
      }
    }

    this.markWindowEmitted(identity);
    this.cleanupSessionCaches(sessionId);
    return entries;
  }

  private resolveTurnIdentity(
    sessionId: string,
    session: SessionState,
    physicalEmitKey: string,
    dbData: DbSessionData | null,
    resultTimestamp?: number,
  ): TurnIdentity | null {
    const prompt = this.matchUserPrompt(session, dbData, resultTimestamp);
    if (this.hasEmittedWindow(physicalEmitKey)) return null;

    if (prompt?.id) {
      return {
        sessionId,
        turnId: `${sessionId}:${prompt.id}`,
        emitKey: physicalEmitKey,
        userPrompt: prompt,
      };
    }

    const fallbackCounter = this.nextFallbackTurnCounter(sessionId);
    return {
      sessionId,
      turnId: `${sessionId}:t${fallbackCounter}`,
      emitKey: physicalEmitKey,
      fallbackCounter,
    };
  }

  private resolvePhysicalEmitKey(
    sessionId: string,
    session: SessionState,
    resultId?: string,
    resultTimestamp?: number,
  ): string {
    const lastMessageId = [...session.turns].reverse().find(turn => turn.messageId)?.messageId;
    if (resultId) return `${sessionId}:result:${resultId}`;
    if (lastMessageId) return `${sessionId}:last-message:${lastMessageId}`;
    if (resultTimestamp) return `${sessionId}:result-ts:${resultTimestamp}`;
    return `${sessionId}:window:${session.startTime}:${session.lastSeenMs}`;
  }

  private matchUserPrompt(
    session: SessionState,
    dbData: DbSessionData | null,
    resultTimestamp?: number,
  ): DbUserPrompt | undefined {
    const prompts = dbData?.userPrompts ?? [];
    if (prompts.length === 0) return undefined;

    const consumed = new Set(this.getStringArrayState('consumedPromptIds'));
    const unconsumed = prompts.filter(prompt => prompt.id && !consumed.has(prompt.id));
    if (unconsumed.length === 0) return undefined;

    const windowStart = session.turns[0]?.startTimestamp ?? session.startTime;
    const resultTime = resultTimestamp ?? session.lastSeenMs;
    const upperBound = Math.max(windowStart, resultTime) + 30_000;
    const orderedCandidates = unconsumed
      .filter(prompt => prompt.updatedAtMs === 0 || prompt.updatedAtMs <= upperBound)
      .sort((a, b) => {
        const da = a.updatedAtMs > 0 ? Math.abs(a.updatedAtMs - windowStart) : Number.MAX_SAFE_INTEGER;
        const db = b.updatedAtMs > 0 ? Math.abs(b.updatedAtMs - windowStart) : Number.MAX_SAFE_INTEGER;
        return da - db || a.sequence - b.sequence;
      });
    if (orderedCandidates.length > 0) return orderedCandidates[0];

    const nearest = unconsumed
      .filter(prompt => prompt.updatedAtMs > 0)
      .map(prompt => ({ prompt, delta: Math.min(Math.abs(prompt.updatedAtMs - windowStart), Math.abs(prompt.updatedAtMs - resultTime)) }))
      .filter(item => item.delta <= PROMPT_MATCH_TOLERANCE_MS)
      .sort((a, b) => a.delta - b.delta || a.prompt.sequence - b.prompt.sequence)[0];
    return nearest?.prompt;
  }

  private hasEmittedWindow(emitKey: string): boolean {
    return this.getStringArrayState('emittedWindowKeys').includes(emitKey);
  }

  private markWindowEmitted(identity: TurnIdentity): void {
    const state = this.getState();
    const extra = toPlainObject(state.extra);
    const emittedWindowKeys = capArray([...this.getStringArrayState('emittedWindowKeys'), identity.emitKey], WINDOW_STATE_LIMIT);
    const consumedPromptIds = identity.userPrompt?.id
      ? capArray([...this.getStringArrayState('consumedPromptIds'), identity.userPrompt.id], WINDOW_STATE_LIMIT)
      : this.getStringArrayState('consumedPromptIds');
    const turnCounters = toNumberRecord(extra.turnCounters);
    if (identity.fallbackCounter !== undefined) {
      turnCounters[identity.sessionId] = Math.max(turnCounters[identity.sessionId] ?? 0, identity.fallbackCounter);
    }
    this.setState({
      extra: {
        ...extra,
        emittedWindowKeys,
        consumedPromptIds,
        turnCounters: capNumberRecord(turnCounters, TURN_COUNTER_STATE_LIMIT),
      },
    });
  }

  private nextFallbackTurnCounter(sessionId: string): number {
    const extra = toPlainObject(this.getState().extra);
    const turnCounters = toNumberRecord(extra.turnCounters);
    return (turnCounters[sessionId] ?? 0) + 1;
  }

  private getStringArrayState(key: string): string[] {
    const value = toPlainObject(this.getState().extra)[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  }

  private cleanupSessionCaches(sessionId: string): void {
    this.sessionToolResults.delete(sessionId);
    this.sessionToolResultDirs.delete(sessionId);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function collectToolResultsFromParts(
  parts: Array<Record<string, unknown>>,
  toolResults: Array<{ toolCallId: string; result: string }>,
): void {
  for (const part of parts) {
    const partType = typeof part.type === 'string' ? part.type : '';
    if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;
    const callId = typeof part.toolCallId === 'string' ? part.toolCallId
      : typeof part.tool_call_id === 'string' ? part.tool_call_id
      : typeof part.id === 'string' ? part.id : '';
    const result = typeof part.output === 'string' ? part.output
      : typeof part.result === 'string' ? part.result
      : part.output !== undefined ? JSON.stringify(part.output) : '';
    if (callId && result) toolResults.push({ toolCallId: callId, result });
  }
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function millisFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function capArray<T>(values: T[], max: number): T[] {
  return values.length > max ? values.slice(values.length - max) : values;
}

function toPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function capNumberRecord(values: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(values);
  return Object.fromEntries(entries.length > max ? entries.slice(entries.length - max) : entries);
}

function toNumberRecord(value: unknown): Record<string, number> {
  const input = toPlainObject(value);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

function finiteNum(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sumIfPresent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a + b;
}

function extractUserText(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts = Array.isArray(msg.parts) ? msg.parts : Array.isArray(msg.content) ? msg.content : [];
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    const part = p as Record<string, unknown>;
    if (typeof part.text === 'string' && part.text) texts.push(part.text);
    else if (typeof part.content === 'string' && part.content) texts.push(part.content);
  }
  return texts.join('\n');
}

function safeParseJson(value: string): JsonValue | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

function queryReadonly<T>(dbPath: string, sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.all(sql, params, (queryErr: Error | null, rows: T[]) => {
        db.close((closeErr) => {
          if (queryErr) { reject(queryErr); return; }
          if (closeErr) { reject(closeErr); return; }
          resolve(rows);
        });
      });
    });
  });
}

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
      const fragment = cursor > 0 ? lines.shift() ?? '' : '';
      const offsets: number[] = [];
      let off = cursor + Buffer.byteLength(fragment, 'utf-8');
      for (const line of lines) { offsets.push(off); off += Buffer.byteLength(line, 'utf-8') + 1; }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('Received message: result ')) {
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
