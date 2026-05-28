import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import sqlite3 from 'sqlite3';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import {
  parseSdkLogLine,
  type QoderWorkLogInputOptions,
  type SdkEvent,
} from './qoder-work-log-input.js';

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_QODERWORK_ROOT_MAC = '~/Library/Application Support/QoderWork';
const DEFAULT_QODERWORK_ROOT_LINUX = '~/.config/QoderWork';
const SOURCE = 'qoder-work-trace';
const UNKNOWN_MODEL = 'unknown';
const MAX_READ_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const DB_REL_PATH = path.join('data', 'agents.db');

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

interface DbSessionData {
  userPrompt: string;
  toolResults: Array<{ toolCallId: string; result: string }>;
}

// ─── main input ──────────────────────────────────────────────────────────────

export class QoderWorkTraceInput extends BaseSessionInput {
  readonly id = 'qoder-work-trace';
  readonly agentType = ClientType.QoderWork;

  private readonly sessions: Map<string, SessionState> = new Map();
  private readonly activeTurns: Map<string, ActiveTurn> = new Map();
  private readonly fileModelPolicies: Map<string, { chat: string; compact: string; scene: string }> = new Map();
  private currentModelPolicy = { chat: '', compact: '', scene: '' };
  private readonly dbPath: string;
  private configuredUserId = '';

  constructor(opts: QoderWorkLogInputOptions) {
    const dataRoot = opts.dataRoot ?? resolveQoderWorkRoot();
    super({
      stateStore: opts.stateStore,
      sessionDir: path.join(dataRoot, 'logs'),
      filePattern: 'sdk-*.log',
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    });
    this.dbPath = path.join(dataRoot, DB_REL_PATH);
  }

  setUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  static getWatchPaths(): string[] {
    return [path.join(resolveQoderWorkRoot(), 'logs')];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(path.join(resolveQoderWorkRoot(), 'logs'));
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
    const completedSessions: Array<{ session: SessionState; sessionId: string }> = [];

    for (const filePath of files) {
      const completed = await this.processLogFile(filePath);
      completedSessions.push(...completed);
    }

    const evicted = this.evictStaleSessions();
    completedSessions.push(...evicted);

    const allEntries: AgentActivityEntry[] = [];
    for (const { session, sessionId } of completedSessions) {
      const entries = await this.emitSessionSpans(session, sessionId);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  // ─── SDK log processing ────────────────────────────────────────────────────

  private async processLogFile(filePath: string): Promise<Array<{ session: SessionState; sessionId: string }>> {
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

    const completed: Array<{ session: SessionState; sessionId: string }> = [];
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

  private handleEvent(event: SdkEvent): { session: SessionState; sessionId: string } | null {
    switch (event.kind) {
      case 'system_init': {
        const session = this.ensureSession(event.sessionId, event.ts);
        session.subscriptionTier = event.subscriptionTier;
        session.cwd = event.cwd;
        session.agents = event.agents;
        session.tools = event.tools;
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
        return { session, sessionId: event.sessionId };
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

    const session = this.sessions.get(sessionId);
    if (session) session.turns.push(turn);
  }

  private pickModelForSession(sessionId: string): string {
    const tier = this.sessions.get(sessionId)?.subscriptionTier ?? '';
    const policy = this.currentModelPolicy;
    if (tier === 'Standard') return policy.scene || policy.compact || policy.chat || UNKNOWN_MODEL;
    return policy.chat || policy.scene || policy.compact || UNKNOWN_MODEL;
  }

  private evictStaleSessions(): Array<{ session: SessionState; sessionId: string }> {
    const now = Date.now();
    const evicted: Array<{ session: SessionState; sessionId: string }> = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeenMs > SESSION_TTL_MS) {
        this.finalizeTurn(id);
        if (session.turns.length > 0) {
          evicted.push({ session, sessionId: id });
        }
        this.sessions.delete(id);
        this.activeTurns.delete(id);
      }
    }
    return evicted;
  }

  // ─── SQLite DB reader ──────────────────────────────────────────────────────

  private async readDbSessionData(sessionId: string): Promise<DbSessionData | null> {
    try {
      await fs.access(this.dbPath);
    } catch {
      return null;
    }

    try {
      const rows = await queryReadonly<{ messages: string }>(
        this.dbPath,
        `SELECT sc.messages FROM sub_chats sc WHERE sc.session_id = ? AND sc.messages IS NOT NULL AND sc.messages != '[]'`,
        [sessionId],
      );
      if (!rows.length) return null;

      let userPrompt = '';
      const toolResults: DbSessionData['toolResults'] = [];

      for (const row of rows) {
        let messages: unknown[];
        try { messages = JSON.parse(row.messages); } catch { continue; }
        if (!Array.isArray(messages)) continue;

        for (const msg of messages) {
          if (!msg || typeof msg !== 'object') continue;
          const m = msg as Record<string, unknown>;

          if (m.role === 'user') {
            const text = extractUserText(m);
            if (text) userPrompt = text;
          }

          if (m.role === 'assistant' && Array.isArray(m.parts)) {
            for (const part of m.parts as Array<Record<string, unknown>>) {
              const partType = typeof part.type === 'string' ? part.type : '';
              if (!partType.startsWith('tool-') || partType === 'tool-Thinking') continue;
              const callId = typeof part.toolCallId === 'string' ? part.toolCallId
                : typeof part.tool_call_id === 'string' ? part.tool_call_id : '';
              const result = typeof part.output === 'string' ? part.output
                : typeof part.result === 'string' ? part.result
                : part.output !== undefined ? JSON.stringify(part.output) : '';
              if (callId && result) toolResults.push({ toolCallId: callId, result });
            }
          }
        }
      }

      return userPrompt || toolResults.length > 0 ? { userPrompt, toolResults } : null;
    } catch (err) {
      this.logger.warn('failed to read qoder-work sqlite for trace', { error: String(err) });
      return null;
    }
  }

  // ─── Span tree emitter ─────────────────────────────────────────────────────

  private async emitSessionSpans(session: SessionState, sessionId: string): Promise<AgentActivityEntry[]> {
    if (session.turns.length === 0) return [];

    const dbData = await this.readDbSessionData(sessionId);

    const toolResultMap = new Map<string, string>();
    if (dbData?.toolResults) {
      for (const tr of dbData.toolResults) toolResultMap.set(tr.toolCallId, tr.result);
    }

    const traceId = crypto.randomBytes(16).toString('hex');
    const entrySpanId = generateSpanId();
    const agentSpanId = generateSpanId();

    const startTime = session.turns[0].startTimestamp;
    const endTime = session.turns[session.turns.length - 1].endTimestamp;
    const model = session.turns[0].model || UNKNOWN_MODEL;
    const userId = this.configuredUserId || undefined;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const turn of session.turns) {
      totalInputTokens += turn.inputTokens;
      totalOutputTokens += turn.outputTokens;
    }

    const finalOutput = session.turns[session.turns.length - 1].textContent || '';
    const turnId = `${sessionId}:t1`;

    const entries: AgentActivityEntry[] = [];

    const baseFields = {
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.agent.type': ClientType.QoderWork,
      'gen_ai.request.model': model,
      'user.id': userId,
    };

    // ── ENTRY span (llm.request) ──
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      timestamp: startTime,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      span_id: entrySpanId,
      'gen_ai.input.messages_delta': dbData?.userPrompt
        ? [{ role: 'user', parts: [{ type: 'text', content: dbData.userPrompt }] }]
        : undefined,
      attributes: { source: SOURCE },
    }));

    // ── AGENT span (llm.request) ──
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      timestamp: startTime,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      span_id: agentSpanId,
      parent_span_id: entrySpanId,
      attributes: {
        source: SOURCE,
        subscription_tier: session.subscriptionTier,
        cwd: session.cwd,
        agents: session.agents,
        tools: session.tools,
      },
    }));

    // ── STEP + LLM + TOOL spans per turn ──
    for (let round = 0; round < session.turns.length; round++) {
      const turn = session.turns[round];
      const stepId = `${turnId}:s${round + 1}`;
      const stepSpanId = generateSpanId();
      const llmSpanId = generateSpanId();
      const turnModel = turn.model || model;

      const stepFields = { ...baseFields, 'gen_ai.step.id': stepId, 'gen_ai.request.model': turnModel };

      // STEP span — llm.request (container)
      entries.push(buildAgentActivityEntry({
        ...stepFields,
        timestamp: turn.startTimestamp,
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.request',
        span_id: stepSpanId,
        parent_span_id: agentSpanId,
        'gen_ai.input.messages_delta': this.buildLlmInputMessages(session, round, toolResultMap, dbData),
        attributes: { source: SOURCE },
      }));

      // LLM span — llm.response
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

      const outputMessages: JsonValue | undefined = outputParts.length > 0
        ? [{ role: 'assistant', parts: outputParts, finishReason: mapStopReason(turn.stopReason) }]
        : undefined;

      entries.push(buildAgentActivityEntry({
        ...stepFields,
        timestamp: turn.endTimestamp,
        'event.id': crypto.randomUUID(),
        'event.name': 'llm.response',
        span_id: llmSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.response.id': turn.messageId,
        'gen_ai.response.model': turnModel,
        'gen_ai.usage.input_tokens': finiteNum(turn.inputTokens),
        'gen_ai.usage.output_tokens': finiteNum(turn.outputTokens),
        'gen_ai.usage.total_tokens': sumIfPresent(finiteNum(turn.inputTokens), finiteNum(turn.outputTokens)),
        'gen_ai.response.finish_reasons': turn.stopReason ? [mapStopReason(turn.stopReason)] : undefined,
        'gen_ai.output.messages': outputMessages,
        attributes: { source: SOURCE },
      }));

      // TOOL spans — each with its own start/end timestamps
      for (const tc of turn.toolCalls) {
        const toolSpanId = generateSpanId();
        const toolResult = toolResultMap.get(tc.id);

        entries.push(buildAgentActivityEntry({
          ...stepFields,
          timestamp: tc.startTs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.call',
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.arguments': safeParseJson(tc.argumentsJson),
          attributes: { source: SOURCE },
        }));

        entries.push(buildAgentActivityEntry({
          ...stepFields,
          timestamp: tc.endTs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.result': toolResult ?? undefined,
          'tool.result.status': 'success',
          attributes: { source: SOURCE },
        }));
      }
    }

    // ── Close AGENT span (llm.response) ──
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      timestamp: endTime,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      span_id: agentSpanId,
      parent_span_id: entrySpanId,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': finiteNum(totalInputTokens),
      'gen_ai.usage.output_tokens': finiteNum(totalOutputTokens),
      'gen_ai.usage.total_tokens': sumIfPresent(finiteNum(totalInputTokens), finiteNum(totalOutputTokens)),
      'gen_ai.output.messages': finalOutput
        ? [{ role: 'assistant', parts: [{ type: 'text', content: finalOutput }] }]
        : undefined,
      attributes: { source: SOURCE },
    }));

    // ── Close ENTRY span (llm.response) ──
    entries.push(buildAgentActivityEntry({
      ...baseFields,
      timestamp: endTime,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      span_id: entrySpanId,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': finiteNum(totalInputTokens),
      'gen_ai.usage.output_tokens': finiteNum(totalOutputTokens),
      'gen_ai.usage.total_tokens': sumIfPresent(finiteNum(totalInputTokens), finiteNum(totalOutputTokens)),
      attributes: { source: SOURCE },
    }));

    return entries;
  }

  private buildLlmInputMessages(
    session: SessionState,
    round: number,
    toolResultMap: Map<string, string>,
    dbData?: DbSessionData | null,
  ): JsonValue | undefined {
    const messages: JsonValue[] = [];

    if (dbData?.userPrompt) {
      messages.push({ role: 'user', parts: [{ type: 'text', content: dbData.userPrompt }] });
    }

    for (let i = 0; i < round; i++) {
      const prevTurn = session.turns[i];
      if (!prevTurn) break;

      const assistantParts: JsonValue[] = [];
      if (prevTurn.thinkingContent) assistantParts.push({ type: 'reasoning', content: prevTurn.thinkingContent });
      if (prevTurn.textContent) assistantParts.push({ type: 'text', content: prevTurn.textContent });
      if (assistantParts.length > 0) {
        messages.push({ role: 'assistant', parts: assistantParts });
      }

      for (const tc of prevTurn.toolCalls) {
        const result = toolResultMap.get(tc.id);
        if (result) {
          messages.push({ role: 'tool', parts: [{ type: 'text', content: result }] });
        }
      }
    }

    return messages.length > 0 ? messages : undefined;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function resolveQoderWorkRoot(): string {
  if (process.platform === 'darwin') return resolveHome(DEFAULT_QODERWORK_ROOT_MAC);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'QoderWork');
  return resolveHome(DEFAULT_QODERWORK_ROOT_LINUX);
}

function finiteNum(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sumIfPresent(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  return a + b;
}

function mapStopReason(reason: string): string {
  if (reason === 'end_turn' || reason === 'stop') return 'stop';
  if (reason === 'tool_use') return 'tool_calls';
  return reason || 'stop';
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
