// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// KiroDesktopSessionInput: passive Session File Polling input for Kiro Desktop.
//
// Reads ~/.kiro/sessions/<hash>/sess_*/messages.jsonl written by the Kiro
// Desktop Electron app and emits AgentActivityEntry records grouped into
// STEP/LLM/TOOL spans per Kiro turn (payload.executionId).
//
// Mapping (per Kiro turn = one executionId):
//   user (content, no executionId)      → 'other' user-input marker attached
//                                         to the NEXT turn (gen_ai.turn.id =
//                                         nextExecutionId) so the OTLP
//                                         converter picks it up as ENTRY
//                                         gen_ai.input.messages; also tracked
//                                         as pendingUser for the next turn's
//                                         first llm.request input.messages_delta.
//                                         If no next turn in this batch, drop.
//   turn_start / turn_end / usage_summary / session_metadata / session_event
//                                       → 'other' (within turn)
//   pending_interaction / interaction_resolved → dropped (UI metadata only)
//   assistant operationType=Say          → llm.response (output.messages = text)
//   tool_call                            → llm.response (output tool_call) + tool.call
//   tool_result                          → tool.result
//
// Each tool cycle (tool_call→tool_result) within a turn becomes its own STEP
// (gen_ai.step.id = `${executionId}#${toolCallId}`), satisfying the rule
// "exactly_one_child_of_kind LLM per STEP". Each assistant Say becomes its
// own STEP (`${executionId}#say_${recordId}`).
//
// LLM span duration: llm.request time = input source (user message timestamp
// or previous tool_result timestamp); llm.response time = tool_call/assistant
// timestamp. This guarantees start<end (non-zero LLM duration).
//
// Standalone 'other' records (no executionId) are NEVER emitted with no
// turn.id — they would create spurious ENTRY+AGENT traces via the OTLP
// flusher's per-key buffering. User markers are attached to the next turn;
// session_event 'other' records at session level are dropped.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_SESSION_DIR = '~/.kiro/sessions';
const DEFAULT_FILE_PATTERN = '**/messages.jsonl';
const DEFAULT_MODEL = 'kiro-desktop';
const TURN_FINISH_REASON_FROM_STOP: Record<string, string> = {
  end_turn: 'stop',
  stop: 'stop',
  error: 'error',
  cancelled: 'cancelled',
};

export interface KiroDesktopSessionInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

export class KiroDesktopSessionInput extends BaseSessionInput {
  readonly id = 'kiro-desktop-session';
  readonly agentType = ClientType.Kiro;
  override readonly collectionMethod = CollectionMethod.SessionFilePolling;

  constructor(opts: KiroDesktopSessionInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs:
        opts.pollIntervalMs ??
        (Number(process.env.KIRO_DESKTOP_POLL_INTERVAL) || 30_000),
    });
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      } catch {
        // file may disappear between discover and stat
      }
    }
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await collectSessionFiles(this.sessionDir, files);
    return files.sort();
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const allEntries: AgentActivityEntry[] = [];
    for (const filePath of files) {
      const entries = await this.processFileBatch(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  private async processFileBatch(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = this.stateKey(filePath);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;
    if (prevInode !== undefined && prevInode !== (stat as any).ino) {
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
    }

    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated or rotated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino) } });
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.stateStore.setOffset(stateKey, stat.size);
      this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });

      const records: Record<string, unknown>[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as Record<string, unknown>);
        } catch (err) {
          this.logger.warn('invalid session line', { file: filePath, error: String(err) });
        }
      }
      return this.processTurnBatch(records, filePath);
    } finally {
      await handle.close();
    }
  }

  protected async processTurnBatch(
    records: Record<string, unknown>[],
    filePath: string,
  ): Promise<AgentActivityEntry[]> {
    const sessionId = extractSessionId(filePath);
    const groups = groupByTurn(records);
    const entries: AgentActivityEntry[] = [];
    let pendingUser: { content: string; ts: number } | undefined;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const nextExecutionId = i + 1 < groups.length ? groups[i + 1]!.executionId : undefined;

      if (group.executionId === undefined) {
        for (const rec of group.records) {
          const payload = asRecord(rec.payload);
          const type = stringValue(payload.type);
          const ts = parseTimestamp(rec.timestamp);
          if (type !== 'user') continue;
          const content = stringValue(payload.content);
          if (!content) continue;
          pendingUser = { content, ts };
          if (!nextExecutionId) continue;
          entries.push(buildAgentActivityEntry({
            timestamp: ts,
            time_unix_nano: timestampToUnixNanos(ts),
            'event.id': stableEventId(filePath, rec, 'user-marker'),
            'event.name': 'other' as AgentEventName,
            'gen_ai.session.id': sessionId,
            'gen_ai.turn.id': nextExecutionId,
            'gen_ai.agent.type': ClientType.Kiro,
            'gen_ai.agent.name': 'Kiro Desktop',
            'gen_ai.input.messages': [{ role: 'user', content }],
            attributes: buildAttributes('user', filePath, rec),
          }));
        }
        continue;
      }

      const turnEntries = this.emitTurnEntries(group, filePath, sessionId, pendingUser);
      pendingUser = undefined;
      entries.push(...turnEntries);
    }

    return entries;
  }

  private emitTurnEntries(
    group: TurnGroup,
    filePath: string,
    sessionId: string,
    initialUser: { content: string; ts: number } | undefined,
  ): AgentActivityEntry[] {
    const executionId = group.executionId!;
    const entries: AgentActivityEntry[] = [];
    let pendingUser = initialUser;
    // Restore cross-batch turn state: Kiro may split a single turn's records
    // across multiple poll cycles (e.g. while waiting for slow tool approval).
    // Without this, cycle N+1's tool_call in a new batch loses lastToolResult
    // and emits reqTs=ts-1 fallback, producing a STEP that overlaps prior STEPs.
    const turnState = this.loadTurnState(executionId);
    let lastToolResult: { toolCallId: string; content: string; ts: number } | undefined = turnState.lastToolResult;
    let finishReason: string | undefined = turnState.finishReason;
    let emittedSayInTurn = turnState.emittedSayInTurn;
    let stepIndex = turnState.stepIndex;

    for (const rec of group.records) {
      const payload = asRecord(rec.payload);
      const type = stringValue(payload.type) ?? 'unknown';
      const ts = parseTimestamp(rec.timestamp);

      if (type === 'turn_start') {
        entries.push(this.emitOtherEntry(rec, type, ts, executionId, undefined, filePath, sessionId));
        continue;
      }
      if (type === 'turn_end') {
        const stopReason = stringValue(payload.stopReason);
        finishReason = stopReason ? (TURN_FINISH_REASON_FROM_STOP[stopReason] ?? stopReason) : undefined;
        entries.push(this.emitOtherEntry(rec, type, ts, executionId, undefined, filePath, sessionId));
        // If the turn ended without an assistant Say (e.g. cancelled mid-ReAct),
        // emit a synthetic final STEP with a text-only llm.response so the
        // last STEP's LLM output is not a tool_call (passes the
        // semantic.last_step_no_tool_call rule). The synthetic content is the
        // stopReason — it truthfully represents the turn's terminal state.
        if (!emittedSayInTurn) {
          const stepId = `${executionId}#final_${stableEventId(filePath, rec, 'final-say')}`;
          const reqTs = Math.max(ts - 1, lastToolResult?.ts ?? 0);
          const inputDelta = lastToolResult
            ? [{ role: 'tool', content: lastToolResult.content, tool_call_id: lastToolResult.toolCallId }]
            : pendingUser
              ? [{ role: 'user', content: pendingUser.content }]
              : [{ role: 'user', content: '' }];
          entries.push(this.emitLlmRequestEntry(rec, reqTs, executionId, stepId, inputDelta, filePath, sessionId));
          entries.push(this.emitLlmResponseEntry(rec, ts, executionId, stepId, `Turn ${stopReason ?? 'ended'}.`, finishReason ?? 'stop', filePath, sessionId));
        }
        continue;
      }
      if (type === 'usage_summary' || type === 'session_metadata' || type === 'session_event') {
        entries.push(this.emitOtherEntry(rec, type, ts, executionId, undefined, filePath, sessionId));
        continue;
      }
      if (type === 'user') {
        const content = stringValue(payload.content);
        if (content) pendingUser = { content, ts };
        entries.push(this.emitOtherEntry(rec, type, ts, executionId, undefined, filePath, sessionId));
        continue;
      }
      if (type === 'pending_interaction' || type === 'interaction_resolved') {
        continue;
      }
      if (type === 'assistant') {
        const content = stringValue(payload.content) ?? '';
        const stepId = `${executionId}#say_${stableEventId(filePath, rec, 'say')}`;
        const reqTs = pendingUser?.ts ?? lastToolResult?.ts ?? ts - 1;
        const inputDelta = pendingUser
          ? [{ role: 'user', content: pendingUser.content }]
          : lastToolResult
            ? [{ role: 'tool', content: lastToolResult.content, tool_call_id: lastToolResult.toolCallId }]
            : [{ role: 'user', content: '' }];
        entries.push(this.emitLlmRequestEntry(rec, reqTs, executionId, stepId, inputDelta, filePath, sessionId));
        entries.push(this.emitLlmResponseEntry(rec, ts, executionId, stepId, content, finishReason ?? 'stop', filePath, sessionId));
        emittedSayInTurn = true;
        pendingUser = undefined;
        lastToolResult = undefined;
        stepIndex++;
        continue;
      }
      if (type === 'tool_call') {
        const toolCallId = stringValue(payload.toolCallId);
        const toolName = stringValue(payload.toolName) ?? 'unknown';
        const args = payload.args;
        const stepId = toolCallId ? `${executionId}#${toolCallId}` : `${executionId}#tool_${stepIndex}`;
        const reqTs = pendingUser?.ts ?? lastToolResult?.ts ?? ts - 1;
        // Kiro may emit a tool_call record with a timestamp earlier than the
        // previous cycle's tool_result (the model decided this tool first but
        // the user approved it last). Bump the effective tool_call time to
        // lastToolResult.ts + 1 so this STEP starts AFTER the previous STEP
        // ended (passes time.no_step_overlap).
        const effectiveTs = lastToolResult && ts <= lastToolResult.ts ? lastToolResult.ts + 1 : ts;
        const inputDelta = pendingUser
          ? [{ role: 'user', content: pendingUser.content }]
          : lastToolResult
            ? [{ role: 'tool', content: lastToolResult.content, tool_call_id: lastToolResult.toolCallId }]
            : [{ role: 'user', content: '' }];
        entries.push(this.emitLlmRequestEntry(rec, reqTs, executionId, stepId, inputDelta, filePath, sessionId));
        entries.push(this.emitLlmToolUseResponseEntry(rec, effectiveTs, executionId, stepId, toolCallId, toolName, args, filePath, sessionId));
        entries.push(this.emitToolCallEntry(rec, effectiveTs, executionId, stepId, toolCallId, toolName, args, filePath, sessionId));
        // Do NOT reset lastToolResult here: the tool_result for THIS call has
        // not been emitted yet. Reset only pendingUser (consumed as input for
        // this cycle's llm.request).
        pendingUser = undefined;
        stepIndex++;
        continue;
      }
      if (type === 'tool_result') {
        const toolCallId = stringValue(payload.toolCallId);
        const content = stringValue(payload.content) ?? '';
        const success = payload.success;
        const stepId = toolCallId ? `${executionId}#${toolCallId}` : `${executionId}#tool_${stepIndex}`;
        const bumpedTs = Math.max(ts + 1, (lastToolResult?.ts ?? 0) + 2);
        entries.push(this.emitToolResultEntry(rec, bumpedTs, executionId, stepId, toolCallId, content, success, filePath, sessionId));
        lastToolResult = toolCallId ? { toolCallId, content, ts: bumpedTs } : undefined;
        continue;
      }
      entries.push(this.emitOtherEntry(rec, type, ts, executionId, undefined, filePath, sessionId));
    }

    // Persist turn state so the next poll cycle can resume (Kiro splits a
    // single turn's records across batches when tool approval takes long).
    this.saveTurnState(executionId, {
      lastToolResult,
      finishReason,
      emittedSayInTurn,
      stepIndex,
    });
    return entries;
  }

  private loadTurnState(executionId: string): {
    lastToolResult?: { toolCallId: string; content: string; ts: number };
    finishReason?: string;
    emittedSayInTurn: boolean;
    stepIndex: number;
  } {
    const state = this.stateStore.get(`${this.id}:turn:${executionId}`);
    const extra = (state.extra ?? {}) as Record<string, unknown>;
    const ltr = extra.lastToolResult as { toolCallId: string; content: string; ts: number } | undefined;
    return {
      lastToolResult: ltr && typeof ltr.ts === 'number' ? ltr : undefined,
      finishReason: typeof extra.finishReason === 'string' ? extra.finishReason : undefined,
      emittedSayInTurn: extra.emittedSayInTurn === true,
      stepIndex: typeof extra.stepIndex === 'number' ? extra.stepIndex : 0,
    };
  }

  private saveTurnState(
    executionId: string,
    state: {
      lastToolResult?: { toolCallId: string; content: string; ts: number };
      finishReason?: string;
      emittedSayInTurn: boolean;
      stepIndex: number;
    },
  ): void {
    this.stateStore.update(`${this.id}:turn:${executionId}`, {
      extra: {
        lastToolResult: state.lastToolResult,
        finishReason: state.finishReason,
        emittedSayInTurn: state.emittedSayInTurn,
        stepIndex: state.stepIndex,
      },
    });
  }

  private emitLlmRequestEntry(
    rec: Record<string, unknown>,
    ts: number,
    executionId: string,
    stepId: string,
    inputDelta: JsonValue,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, 'llm-req'),
      'event.name': 'llm.request' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      'gen_ai.request.model': DEFAULT_MODEL,
      'gen_ai.input.messages_delta': inputDelta,
      attributes: buildAttributes('llm_request', filePath, rec),
    });
  }

  private emitLlmResponseEntry(
    rec: Record<string, unknown>,
    ts: number,
    executionId: string,
    stepId: string,
    content: string,
    finishReason: string,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, 'llm-resp'),
      'event.name': 'llm.response' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      'gen_ai.request.model': DEFAULT_MODEL,
      'gen_ai.response.model': DEFAULT_MODEL,
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content }] }],
      attributes: buildAttributes('llm_response', filePath, rec),
    });
  }

  private emitLlmToolUseResponseEntry(
    rec: Record<string, unknown>,
    ts: number,
    executionId: string,
    stepId: string,
    toolCallId: string | undefined,
    toolName: string,
    args: unknown,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    const toolCallPart: Record<string, unknown> = { type: 'tool_call', name: toolName };
    if (toolCallId) toolCallPart.id = toolCallId;
    if (args !== undefined) toolCallPart.input = args;
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, 'llm-tooluse'),
      'event.name': 'llm.response' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      'gen_ai.request.model': DEFAULT_MODEL,
      'gen_ai.response.model': DEFAULT_MODEL,
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [toolCallPart as JsonValue] }],
      attributes: buildAttributes('llm_tooluse', filePath, rec),
    });
  }

  private emitToolCallEntry(
    rec: Record<string, unknown>,
    ts: number,
    executionId: string,
    stepId: string,
    toolCallId: string | undefined,
    toolName: string,
    args: unknown,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, 'tool-call'),
      'event.name': 'tool.call' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      'gen_ai.tool.name': toolName,
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.tool.call.exec.id': toolCallId,
      'gen_ai.tool.call.arguments': toJsonValue(args),
      attributes: buildAttributes('tool_call', filePath, rec),
    });
  }

  private emitToolResultEntry(
    rec: Record<string, unknown>,
    ts: number,
    executionId: string,
    stepId: string,
    toolCallId: string | undefined,
    content: string,
    success: unknown,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    const status = success === true ? 'success' : success === false ? 'failure' : 'unknown';
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, 'tool-result'),
      'event.name': 'tool.result' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.tool.call.exec.id': toolCallId,
      'gen_ai.tool.call.result': content.length > 0 ? content : '{}',
      'tool.result.status': status,
      attributes: buildAttributes('tool_result', filePath, rec),
    });
  }

  private emitOtherEntry(
    rec: Record<string, unknown>,
    kiroType: string,
    ts: number,
    executionId: string | undefined,
    stepId: string | undefined,
    filePath: string,
    sessionId: string,
  ): AgentActivityEntry {
    const attrs = buildAttributes(kiroType, filePath, rec);
    return buildAgentActivityEntry({
      timestamp: ts,
      time_unix_nano: timestampToUnixNanos(ts),
      'event.id': stableEventId(filePath, rec, `other-${kiroType}`),
      'event.name': 'other' as AgentEventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      attributes: attrs,
    });
  }

  // Per-line mapping retained for backwards compatibility with existing tests
  // that drive processSessionLine directly. Real collection goes through
  // collect() → processFileBatch() → processTurnBatch().
  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    const payload = asRecord(record.payload);
    const type = stringValue(payload.type) ?? 'unknown';
    const timestamp = parseTimestamp(record.timestamp);
    const sessionId = extractSessionId(filePath);
    const executionId = stringValue(payload.executionId);

    const attributes: Record<string, JsonValue> = {
      source: 'kiro-desktop-session',
      kiro_event_type: type,
      session_file: filePath,
    };
    if (executionId) attributes.kiro_execution_id = executionId;
    if (record.id) attributes.kiro_record_id = String(record.id);

    return buildAgentActivityEntry({
      timestamp,
      time_unix_nano: timestampToUnixNanos(timestamp),
      'event.name': 'other',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': executionId,
      'gen_ai.agent.type': ClientType.Kiro,
      'gen_ai.agent.name': 'Kiro Desktop',
      attributes,
    });
  }

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }
}

interface TurnGroup {
  executionId: string | undefined;
  records: Record<string, unknown>[];
}

function groupByTurn(records: Record<string, unknown>[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (const rec of records) {
    const payload = asRecord(rec.payload);
    const executionId = stringValue(payload.executionId);
    if (executionId === undefined) {
      if (!current || current.executionId !== undefined) {
        current = { executionId: undefined, records: [] };
        groups.push(current);
      }
      current.records.push(rec);
      continue;
    }
    if (!current || current.executionId !== executionId) {
      current = { executionId, records: [] };
      groups.push(current);
    }
    current.records.push(rec);
  }
  return groups;
}

async function collectSessionFiles(dir: string, files: string[]): Promise<void> {
  let hashDirs: Dirent[];
  try {
    hashDirs = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue;
    if (hashDir.name.startsWith('_')) continue;

    const hashPath = path.join(dir, hashDir.name);
    let sessDirs: Dirent[];
    try {
      sessDirs = await fs.readdir(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessDir of sessDirs) {
      if (!sessDir.isDirectory()) continue;
      if (!sessDir.name.startsWith('sess_')) continue;

      const sessPath = path.join(hashPath, sessDir.name);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(sessPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'messages.jsonl') {
          files.push(path.join(sessPath, entry.name));
        }
      }
    }
  }
}

function extractSessionId(filePath: string): string {
  // ~/.kiro/sessions/<hash>/sess_<uuid>/messages.jsonl
  const sessDir = path.dirname(filePath);
  return path.basename(sessDir);
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return Date.now();

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((v): v is JsonValue => v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const json = toJsonValue(v);
      if (json !== undefined) out[k] = json;
    }
    return out;
  }
  return String(value);
}

function buildAttributes(
  phase: string,
  filePath: string,
  record: Record<string, unknown>,
): Record<string, JsonValue> {
  const payload = asRecord(record.payload);
  const type = stringValue(payload.type) ?? 'unknown';
  const attrs: Record<string, JsonValue> = {
    source: 'kiro-desktop-session',
    kiro_event_type: type,
    kiro_phase: phase,
    session_file: filePath,
  };
  const executionId = stringValue(payload.executionId);
  if (executionId) attrs.kiro_execution_id = executionId;
  if (record.id) attrs.kiro_record_id = String(record.id);
  if (payload.toolName) attrs.kiro_tool_name = String(payload.toolName);
  if (payload.operationType) attrs.kiro_operation_type = String(payload.operationType);
  if (payload.stopReason) attrs.kiro_stop_reason = String(payload.stopReason);
  if (payload.status) attrs.kiro_status = String(payload.status);
  return attrs;
}

function stableEventId(
  filePath: string,
  record: Record<string, unknown>,
  phase: string,
): string {
  const id = record.id ? String(record.id) : `${phase}-${record.timestamp ?? ''}`;
  return crypto
    .createHash('sha256')
    .update(`${filePath}::${id}::${phase}`)
    .digest('hex')
    .slice(0, 32);
}
