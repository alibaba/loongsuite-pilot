import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { VALID_FINISH_REASONS } from '../../normalization/finish-reason.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

// Import the shared helpers from the .mjs file so the AGENT span_id (derived
// in assets/hooks/zcode-hook-processor.mjs) and the STEP parent_span_id
// (derived here) come from the SAME function. Per architect de8a29fe
// implementation reminder: "派生 span_id helper 须为单一 shared 函数，严禁
// 两边各写一份公式——否则跨源拼接静默失败".
//
// The .mjs also reuses hashJson from agent-event-normalizer.mjs, keeping the
// sha256 derivation formula in exactly one place end-to-end. Types come from
// the sibling event-emitter.d.mts (review P3) — no more @ts-expect-error.
import { toW3CTraceId, deriveSpanId } from '../../../assets/hooks/shared/event-emitter.mjs';

const DEFAULT_ROLLOUT_DIR = '~/.zcode/cli/rollout';
const AGENT_ID = 'zcode';
const ROLLOUT_READ_CHUNK_BYTES = 256 * 1024;
const ROLLOUT_READ_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_ROLLOUT_RECORD_BYTES = 32 * 1024 * 1024;

async function baselineRolloutCursor(
  file: FileHandle, size: number,
): Promise<{ offset: number; discardOffset?: number }> {
  const lowerBound = Math.max(0, size - MAX_ROLLOUT_RECORD_BYTES);
  const block = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
  for (let end = size; end > lowerBound;) {
    const start = Math.max(lowerBound, end - block.length);
    const { bytesRead } = await file.read(block, 0, end - start, start);
    const newline = block.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return { offset: start + newline + 1 };
    end = start;
  }
  // A tail this long cannot become a supported record even if a newline arrives.
  return size >= MAX_ROLLOUT_RECORD_BYTES ? { offset: 0, discardOffset: size } : { offset: 0 };
}


export interface ZCodeRolloutInputOptions extends Omit<InputOptions, 'stateStore'> {
  stateStore: InputOptions['stateStore'];
  rolloutDir?: string;
}

/**
 * ZCode rollout JSONL input — V3 main data source.
 *
 * Tails `~/.zcode/cli/rollout/model-io-sess_<sanitized-sid>.jsonl` files. Each
 * line is a complete `model_io` record containing request.messages[] +
 * response.text + response.toolCalls[] + usage + traceId/sessionId/turnId +
 * startedAt/completedAt timestamps.
 *
 * For each line, emits:
 *   - STEP envelope (parent_span_id = AGENT span_id derived from same shared
 *     formula as the hook-processor's AGENT envelope span_id)
 *   - llm.request (with gen_ai.input.messages)
 *   - llm.response (with gen_ai.output.messages + usage + finish_reasons)
 *   - tool.call + tool.result per response.toolCalls[]
 *
 * The hook-processor's ENTRY/AGENT envelope records are emitted independently
 * (by ZCodeHookInput reading the JSONL that zcode-hook-processor.mjs writes).
 * The two inputs feed the flusher; cross-source parent linking happens by
 * trace_id + gen_ai.session.id + gen_ai.turn.id, with AGENT.span_id and
 * STEP.parent_span_id derived from the same shared deriveSpanId() so they
 * match deterministically across processes.
 *
 * Per spec §1.4 baseline skip: on pilot startup, for each rollout file not
 * yet seen, initialize the cursor after the last complete historical row (state store key
 * `zcode-rollout:<sessionId>` — actually implemented as
 * `zcode-rollout:<absoluteFilePath>` to match BaseInput's state store
 * convention). This prevents replaying history on first install. Pilot
 * restarts read from persisted offset and only tail appends.
 */
export class ZCodeRolloutInput extends BaseInput {
  readonly id = 'zcode-rollout';
  readonly agentType = ClientType.ZCode;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly rolloutDir: string;

  constructor(opts: ZCodeRolloutInputOptions) {
    super({ stateStore: opts.stateStore, pollIntervalMs: opts.pollIntervalMs });
    this.rolloutDir = opts.rolloutDir ?? resolveHome(DEFAULT_ROLLOUT_DIR);
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_ROLLOUT_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_ROLLOUT_DIR));
  }

  protected override async onStart(): Promise<void> {
    // Skip historical complete rows only on first discovery at startup.
    // Earlier versions could checkpoint files created during a running
    // collector without setting initialized. Keep that durable cursor.
    const files = await this.discoverRolloutFiles();
    for (const filePath of files) {
      const stateKey = this.stateKey(filePath);
      const existing = this.stateStore.get(stateKey);
      if (existing.extra?.initialized === true) continue;
      if (typeof existing.lastOffset === 'number' || typeof existing.extra?.inode === 'number') {
        this.stateStore.update(stateKey, { extra: { initialized: true } });
        continue;
      }

      let handle: FileHandle | undefined;
      try {
        handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        const cursor = await baselineRolloutCursor(handle, stat.size);
        this.stateStore.update(stateKey, {
          lastOffset: cursor.offset,
          extra: { inode: stat.ino, initialized: true, rolloutDiscardOffset: cursor.discardOffset },
        });
      } catch {
        // Files can disappear or rotate between discovery and opening.
      } finally {
        await handle?.close();
      }
    }
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverRolloutFiles();
    const allEntries = this.recoverUnreportedToolCalls();

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = this.stateKey(filePath);
    let handle: FileHandle;
    try {
      handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch {
      return [];
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return [];

      const prevState = this.stateStore.get(stateKey);
      const prevInode = prevState.extra?.inode as number | undefined;
      let offset = prevState.lastOffset ?? 0;
      const persistedDiscard = prevState.extra?.rolloutDiscardOffset;
      let discardOffset = typeof persistedDiscard === 'number' && Number.isSafeInteger(persistedDiscard)
        && persistedDiscard - offset >= MAX_ROLLOUT_RECORD_BYTES ? persistedDiscard : undefined;
      if ((prevInode !== undefined && prevInode !== stat.ino) || stat.size < offset) {
        offset = 0;
        discardOffset = undefined;
      } else if (discardOffset !== undefined && stat.size < discardOffset) {
        // Truncating only the unfinished row need not replay earlier records.
        discardOffset = undefined;
      }
      const batch = await this.readRolloutLines(handle, filePath, stat.size, offset, discardOffset);
      const entries = this.buildEntriesFromRolloutLines(batch.lines);
      // Even an empty file discovered during a running collector is live.
      if (prevState.lastOffset !== batch.offset || prevInode !== stat.ino
        || prevState.extra?.initialized !== true || persistedDiscard !== batch.discardOffset) {
        this.stateStore.update(stateKey, {
          lastOffset: batch.offset,
          extra: { inode: stat.ino, initialized: true, rolloutDiscardOffset: batch.discardOffset },
        });
      }
      return entries;
    } finally {
      await handle.close();
    }
  }

  private async readRolloutLines(
    handle: FileHandle, filePath: string, size: number, offset: number, discardOffset?: number,
  ): Promise<{ lines: Record<string, unknown>[]; offset: number; discardOffset?: number }> {
    const start = discardOffset ?? offset;
    const normalEnd = Math.min(size, start + ROLLOUT_READ_BUDGET_BYTES);
    let position = start;
    let end = normalEnd;
    let discarding = discardOffset !== undefined;
    let parts: Buffer[] = [];
    const lines: Record<string, unknown>[] = [];
    while (position < end) {
      const chunk = Buffer.allocUnsafe(Math.min(ROLLOUT_READ_CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = data.indexOf(0x0a, cursor);
        const partEnd = newline < 0 ? bytesRead : newline;
        const recordBytes = position + partEnd - offset;
        if (!discarding) {
          if (recordBytes >= MAX_ROLLOUT_RECORD_BYTES) {
            discarding = true;
            parts = [];
            this.logger.warn('oversized rollout JSONL line skipped', {
              file: filePath, offset, maxRecordBytes: MAX_ROLLOUT_RECORD_BYTES,
            });
          } else {
            parts.push(data.subarray(cursor, partEnd));
          }
        }
        if (newline < 0) break;
        if (!discarding) {
          const text = (parts.length === 1 ? parts[0] : Buffer.concat(parts, recordBytes)).toString('utf8').trim();
          if (text) {
            try {
              lines.push(JSON.parse(text) as Record<string, unknown>);
            } catch {
              this.logger.warn('invalid rollout JSONL line', { file: filePath, offset });
            }
          }
        }
        offset = position + newline + 1;
        if (end > normalEnd) return { lines, offset };
        discarding = false;
        parts = [];
        cursor = newline + 1;
      }
      position += bytesRead;
      if (position === end && offset === start && !discarding) {
        // Finish the first record even if it crosses the ordinary scan budget.
        end = Math.min(size, start + MAX_ROLLOUT_RECORD_BYTES);
      }
    }
    // Keep the complete record cursor separate from progress seeking the end
    // of a record that is already too long to decode.
    return { lines, offset, discardOffset: discarding ? position : undefined };
  }

  /** Convert complete native records in file order, retaining late tool links. */
  buildEntriesFromRolloutLines(lines: Record<string, unknown>[]): AgentActivityEntry[] {
    const allEntries: AgentActivityEntry[] = [];

    for (const record of lines) {
      if (record?.type !== 'model_io') continue;
      const sid = str(record.sessionId) ?? str(record.session_id);
      const tid = str(record.turnId) ?? str(record.turn_id);
      const trace = str(record.traceId) ?? str(record.trace_id);
      if (sid && tid && trace) {
        allEntries.push(...this.flushPendingToolResults(sid, tid, toW3CTraceId(trace), record));
      }
      allEntries.push(...this.buildEntriesFromRolloutLine(record));
    }
    return allEntries;
  }

  /**
   * Bounded registry of turns awaiting observed tool results.
   */
  private getPendingTurnRegistry(): string[] {
    const key = 'zcode-rollout:pending-turn-registry';
    return (this.stateStore.get(key).extra?.turns as string[] | undefined) ?? [];
  }

  private setPendingTurnRegistry(turns: string[]): void {
    const key = 'zcode-rollout:pending-turn-registry';
    this.stateStore.update(key, { extra: { turns } });
  }

  /** Older checkpoints can contain an observed call from an unchanged EOF. */
  private recoverUnreportedToolCalls(): AgentActivityEntry[] {
    const recovered: AgentActivityEntry[] = [];
    for (const turn of this.getPendingTurnRegistry()) {
      const key = `zcode-rollout:pending-tool-calls:${turn}`;
      const pending = (this.stateStore.get(key).extra?.pending as PendingToolCall[] | undefined) ?? [];
      const unreported = pending.filter(call => !call.callEmitted);
      if (!unreported.length) continue;
      recovered.push(...this.buildToolCallEntries(unreported));
      this.stateStore.update(key, { extra: { pending: pending.map(({ args: _args, ...call }) =>
        ({ ...call, callEmitted: true })) } });
    }
    return recovered;
  }

  /** Emit calls as observed and retain only their identities for a real result. */
  private emitAndRememberToolCalls(
    metadata: Omit<PendingToolCall, 'callId' | 'toolName' | 'args' | 'callEmitted'>,
    toolCalls: ToolCall[],
  ): AgentActivityEntry[] {
    if (toolCalls.length === 0) return [];
    const turnKey = `${metadata.sid}+${metadata.tid}`;
    const key = `zcode-rollout:pending-tool-calls:${turnKey}`;
    const existing = (this.stateStore.get(key).extra?.pending as PendingToolCall[] | undefined) ?? [];
    const observed: PendingToolCall[] = toolCalls.map(call => ({
      ...metadata, callId: call.id, toolName: call.name, args: call.args,
    }));
    const emitted = this.buildToolCallEntries(observed);
    const newPending = observed.map(({ args: _args, ...call }) => ({ ...call, callEmitted: true }));
    const pending = [...existing, ...newPending];
    // Report calls from a pre-upgrade checkpoint before expiring their metadata.
    const evictedCalls = pending.splice(0, Math.max(0, pending.length - 512));
    emitted.push(...this.buildToolCallEntries(evictedCalls.filter(call => !call.callEmitted)));
    this.stateStore.update(key, { extra: { pending } });

    const MAX_PENDING_TURNS = 32;
    const registry = this.getPendingTurnRegistry().filter((t) => t !== turnKey);
    registry.push(turnKey);
    if (registry.length > MAX_PENDING_TURNS) {
      const evicted = registry.splice(0, registry.length - MAX_PENDING_TURNS);
      for (const t of evicted) {
        const evictedPending = (this.stateStore.get(`zcode-rollout:pending-tool-calls:${t}`)
          .extra?.pending as PendingToolCall[] | undefined) ?? [];
        emitted.push(...this.buildToolCallEntries(evictedPending.filter(call => !call.callEmitted)));
        this.stateStore.delete(`zcode-rollout:pending-tool-calls:${t}`);
      }
    }
    this.setPendingTurnRegistry(registry);
    return emitted;
  }

  private buildToolCallEntries(calls: PendingToolCall[]): AgentActivityEntry[] {
    return calls.map((p) => buildAgentActivityEntry({
      time_unix_nano: p.completedAtNs,
      'event.id': crypto.randomUUID(),
      'event.name': 'tool.call',
      'gen_ai.session.id': p.sid,
      'gen_ai.turn.id': p.tid,
      'gen_ai.step.id': p.stepId,
      'gen_ai.agent.type': ClientType.ZCode,
      'gen_ai.agent.id': p.sid,
      'gen_ai.agent.name': 'ZCode',
      'agent.source': 'zcode-rollout',
      'gen_ai.provider.name': p.providerId,
      'gen_ai.tool.name': p.toolName,
      'gen_ai.tool.call.id': p.callId,
      'gen_ai.tool.call.exec.id': p.callId,
      ...(p.args !== undefined && p.args !== null
        ? { 'gen_ai.tool.call.arguments': p.args as JsonValue }
        : {}),
      trace_id: p.traceId,
      span_id: deriveSpanId('tool', p.sid, p.tid, p.requestId ?? 'r', p.callId),
      parent_span_id: p.stepSpanId,
    }));
  }

  /** A later real model request can carry the result, including across polls. */
  private flushPendingToolResults(
    sid: string, tid: string, traceId: string, currentLine: Record<string, unknown>,
  ): AgentActivityEntry[] {
    const registry = this.getPendingTurnRegistry();
    const groups = registry.filter(turn => turn.startsWith(`${sid}+`)).map(turn => {
      const key = `zcode-rollout:pending-tool-calls:${turn}`;
      return { turn, key, pending: (this.stateStore.get(key).extra?.pending as PendingToolCall[] | undefined) ?? [] };
    });
    if (!groups.length) return [];
    const sameSession = groups.flatMap(group => group.pending.filter(call => call.sid === sid));
    const resultsByCall = matchToolResults(currentLine, sameSession, tid, traceId);
    const startedAt = str(currentLine.startedAt) ?? str(currentLine.started_at) ?? '';
    const nextStartedAt = timestampToUnixNanos(startedAt);
    const cleared = new Set<string>();
    const out: AgentActivityEntry[] = [];
    for (const { turn, key, pending } of groups) {
      const retained: PendingToolCall[] = [];
      for (const p of pending) {
        if (p.sid !== sid) {
          retained.push(p);
          continue;
        }
        if (!p.callEmitted) out.push(...this.buildToolCallEntries([p]));
        const result = resultsByCall.get(p);
        if (!result) {
          const { args: _args, ...call } = p;
          retained.push({ ...call, callEmitted: true });
          continue;
        }
        const toolSpanId = deriveSpanId('tool', p.sid, p.tid, p.requestId ?? 'r', p.callId);
        const callTime = BigInt(p.completedAtNs);
        const nextTime = BigInt(nextStartedAt);
        const resultTimeNs = (nextTime > callTime + 1n ? nextTime - 1n : callTime + 1_000_000n).toString();
        const isError = result.isError === true;
        out.push(buildAgentActivityEntry({
          time_unix_nano: resultTimeNs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.session.id': p.sid,
          'gen_ai.turn.id': p.tid,
          'gen_ai.step.id': p.stepId,
          'gen_ai.agent.type': ClientType.ZCode,
          'gen_ai.agent.id': p.sid,
          'gen_ai.agent.name': 'ZCode',
          'agent.source': 'zcode-rollout',
          'gen_ai.provider.name': p.providerId,
          'gen_ai.tool.name': result.toolName ?? p.toolName,
          'gen_ai.tool.call.id': p.callId,
          'gen_ai.tool.call.exec.id': p.callId,
          ...(result.content !== undefined
            ? { 'gen_ai.tool.call.result': result.content as JsonValue }
            : {}),
          'tool.result.status': isError ? 'failure' : 'success',
          ...(isError && result.content
            ? { 'error.type': 'ToolError', 'error.message': String(result.content).slice(0, 500) }
            : {}),
          trace_id: p.traceId,
          span_id: toolSpanId,
          parent_span_id: p.stepSpanId,
        }));
      }
      if (pending.length && retained.length === pending.length && pending.every(call => call.callEmitted)) continue;
      if (retained.length) this.stateStore.update(key, { extra: { pending: retained } });
      else {
        cleared.add(turn);
        this.stateStore.delete(key);
      }
    }
    if (cleared.size) this.setPendingTurnRegistry(registry.filter(turn => !cleared.has(turn)));
    return this.sortEntries(out);
  }

  /** Convert one native model invocation and emit any observed tool calls. */
  buildEntriesFromRolloutLine(record: Record<string, unknown>): AgentActivityEntry[] {
    if (record.type !== 'model_io') return [];

    const sessionId = str(record.sessionId) ?? str(record.session_id);
    const turnId = str(record.turnId) ?? str(record.turn_id);
    const traceIdRaw = str(record.traceId) ?? str(record.trace_id);
    const requestId = str(record.requestId) ?? str(record.request_id) ?? crypto.randomUUID();
    const startedAt = str(record.startedAt) ?? str(record.started_at);
    const completedAt = str(record.completedAt) ?? str(record.completed_at);
    const durationMs = num(record.durationMs) ?? num(record.duration_ms);

    const model = (record.model && typeof record.model === 'object' ? record.model : {}) as Record<string, unknown>;
    const modelId = str(model.modelId) ?? str(model.model_id) ?? 'unknown';
    const providerId = str(model.providerId) ?? str(model.provider_id) ?? 'unknown';

    const request = (record.request && typeof record.request === 'object' ? record.request : {}) as Record<string, unknown>;
    const rawInputMessages = Array.isArray(request.messages_sample_truncated)
      ? request.messages_sample_truncated
      : Array.isArray(request.messages) ? request.messages : [];
    const inputMessages = (rawInputMessages as unknown[])
      .map((m) => normalizeInputMessage(m))
      .filter(Boolean) as { role: string; content: string }[];

    // Native rollout formats have either complete tool definitions or names only.
    const systemInstructions: JsonValue[] = (rawInputMessages as unknown[])
      .map((m) => normalizeInputMessage(m))
      .filter(Boolean)
      .filter((m) => m!.role === 'system')
      .map((m) => ({ type: 'text', content: String(m!.content ?? '') })) as JsonValue[];
    const toolDefinitions = extractToolDefinitions(record, request);

    // P1 fix: detect first line of a turn (no assistant message in input →
    // user prompt that triggered the turn is present). Emit a synthetic
    // AGENT-level `other` event carrying gen_ai.input.messages_delta with
    // the user-side messages so the ARMS UI / validator can attribute the
    // turn's user input on the AGENT span (mirrors codex-transcript-builder
    // lines 30-44). Filters out <system-reminder> wrapper blocks since those
    // are agent-injected context, not the user's actual prompt.
    const hasAssistantInInput = inputMessages.some((m) => m.role === 'assistant');
    const userDeltaMessages = !hasAssistantInInput
      ? inputMessages
          .filter((m) => m.role === 'user')
          .filter((m) => !String(m.content ?? '').startsWith('<system-reminder>'))
      : [];
    const userDeltaJsonValue: JsonValue[] = userDeltaMessages.map((m) => ({
      role: 'user',
      parts: [{ type: 'text', content: String(m.content ?? '') }],
    }));

    const response = (record.response && typeof record.response === 'object' ? record.response : {}) as Record<string, unknown>;
    const responseText = str(response.text) ?? '';
    // P1 fix: do NOT default finishReason to 'stop' — when ZCode is interrupted
    // or times out, response.finishReason may be null/empty. Defaulting to 'stop'
    // incorrectly marks interrupted sessions as normal completions and causes
    // the flusher to treat this as a terminal signal, dropping late hook entries.
    // When completedAt exists but finishReason is missing → 'interrupted'.
    // When both are missing → 'end_turn' as safe neutral (not a terminal signal).
    // Raw values are normalized to the canonical validator set via
    // normalizeFinishReason() (e.g. tool_use/tool-calls → tool_call).
    const rawFinishReason = str(response.finishReason) ?? str(response.finish_reason);
    const hasCompletedAt = !!(str(record.completedAt) ?? str(record.completed_at));
    const finishReason = normalizeFinishReason(
      rawFinishReason ?? (hasCompletedAt ? 'interrupted' : 'end_turn'),
    );
    const responseId = str(response.responseId) ?? str(response.response_id) ?? requestId;
    const responseModelId = str(response.modelId) ?? str(response.model_id) ?? modelId;
    const toolCallsRaw = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const toolCalls = (toolCallsRaw as unknown[])
      .map(normalizeToolCall)
      .filter((call): call is ToolCall => call !== null);

    const usage = (response.usage && typeof response.usage === 'object' ? response.usage : {}) as Record<string, unknown>;
    const inputTokens = num(usage.inputTokens) ?? num(usage.input_tokens);
    const outputTokens = num(usage.outputTokens) ?? num(usage.output_tokens);
    const cacheReadTokens = num(usage.cacheReadTokens) ?? num(usage.cache_read_tokens);
    const totalTokens = num(usage.totalTokens) ?? num(usage.total_tokens);

    if (!sessionId || !turnId || !traceIdRaw) {
      this.logger.warn('rollout line missing required id field', {
        sessionId, turnId, traceId: traceIdRaw,
      });
      return [];
    }

    const traceId = toW3CTraceId(traceIdRaw);
    // STEP parent_span_id uses the SAME deriveSpanId('agent', sessionId, turnId)
    // formula as the hook-processor's AGENT envelope span_id — this is the
    // cross-source stitching contract. AGENT and STEP come from different
    // processes (hook-processor.mjs vs this TS input), so they can't share
    // in-process state; matching derived values is what makes the OTLP flusher
    // able to assemble the 5-layer tree.
    const stepParentSpanId = deriveSpanId('agent', sessionId, turnId);
    const stepId = `${turnId}:${requestId}`;
    const stepSpanId = deriveSpanId('step', sessionId, turnId, requestId);
    const llmSpanId = deriveSpanId('llm', sessionId, turnId, requestId, responseId || 'r');
    const requestTimeNs = timestampToUnixNanos(startedAt || completedAt || Date.now());
    const responseTimeNs = timestampToUnixNanos(completedAt || startedAt || Date.now());

    const entries: AgentActivityEntry[] = [];

    // P1 fix: synthetic AGENT-level `other` event carrying the user prompt
    // as gen_ai.input.messages_delta. Emitted only on the first line of a
    // turn (no assistant message in input → user prompt is present).
    // Span_id matches the hook-processor's AGENT envelope span_id
    // (deriveSpanId('agent', sessionId, turnId)) so the OTLP flusher merges
    // this event into the same AGENT span. parent_span_id points to the
    // ENTRY envelope (deriveSpanId('entry', sessionId)) for tree linkage.
    if (userDeltaJsonValue.length > 0) {
      entries.push(buildAgentActivityEntry({
        time_unix_nano: requestTimeNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'other',
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.agent.type': ClientType.ZCode,
        'gen_ai.agent.id': sessionId,
        'gen_ai.agent.name': 'ZCode',
        'agent.source': 'zcode-rollout',
        'gen_ai.provider.name': providerId,
        'gen_ai.input.messages_delta': userDeltaJsonValue,
        trace_id: traceId,
        span_id: stepParentSpanId,
        parent_span_id: deriveSpanId('entry', sessionId),
        'gen_ai.span.kind': 'agent',
      }));
    }

    // STEP envelope — marks the per-attempt boundary. Carries parent_span_id
    // pointing to AGENT envelope (derived from same formula as the hook path's
    // AGENT span_id, so they match across processes).
    entries.push(buildAgentActivityEntry({
      time_unix_nano: requestTimeNs,
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.ZCode,
      'gen_ai.agent.id': sessionId,
      'gen_ai.agent.name': 'ZCode',
      'agent.source': 'zcode-rollout',
      'gen_ai.provider.name': providerId,
      trace_id: traceId,
      span_id: stepSpanId,
      parent_span_id: stepParentSpanId,
      'gen_ai.span.kind': 'step',
    }));

    // llm.request — input messages + model + provider.
    entries.push(buildAgentActivityEntry({
      time_unix_nano: requestTimeNs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.ZCode,
      'gen_ai.agent.id': sessionId,
      'gen_ai.agent.name': 'ZCode',
      'agent.source': 'zcode-rollout',
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': providerId,
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': responseModelId,
      'gen_ai.input.messages': inputMessages.map((m) => ({
        role: m.role,
        parts: [{ type: 'text', content: String(m.content ?? '') }],
      })) as JsonValue,
      ...(systemInstructions.length > 0
        ? { 'gen_ai.system_instructions': systemInstructions }
        : {}),
      ...(toolDefinitions.length > 0
        ? { 'gen_ai.tool.definitions': toolDefinitions }
        : {}),
      trace_id: traceId,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
    }));

    // llm.response — output messages (text + tool_call parts) + usage + finish.
    const outputParts: JsonValue[] = [];
    if (responseText.length > 0) {
      outputParts.push({ type: 'text', content: responseText });
    }
    for (const tc of toolCalls) {
      const part: Record<string, JsonValue> = { type: 'tool_call', id: tc.id, name: tc.name };
      if (tc.args !== undefined && tc.args !== null) {
        part.arguments = tc.args as JsonValue;
      }
      outputParts.push(part);
    }
    // P1 fix: for interrupted turns where responseText and toolCalls are both
    // empty, emit a placeholder assistant message instead of an empty array.
    // Empty output.messages is typically rejected by the trace validator for
    // interrupted sessions.
    const outputMessages: JsonValue = outputParts.length > 0
      ? [{ role: 'assistant', parts: outputParts }]
      : finishReason === 'interrupted'
        ? [{ role: 'assistant', parts: [{ type: 'text', content: '' }] }]
        : [];

    const endedAbnormally = finishReason === 'interrupted' || finishReason === 'cancelled' || finishReason === 'error';
    entries.push(buildAgentActivityEntry({
      time_unix_nano: responseTimeNs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      'agent.zcode.rollout_completion_candidate': hasCompletedAt
        && (endedAbnormally || (finishReason !== 'tool_call' && toolCalls.length === 0)),
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.agent.type': ClientType.ZCode,
      'gen_ai.agent.id': sessionId,
      'gen_ai.agent.name': 'ZCode',
      'agent.source': 'zcode-rollout',
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': providerId,
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': responseModelId,
      'gen_ai.response.finish_reasons': [finishReason],
      ...(inputTokens !== undefined ? { 'gen_ai.usage.input_tokens': inputTokens } : {}),
      ...(outputTokens !== undefined ? { 'gen_ai.usage.output_tokens': outputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { 'gen_ai.usage.cache_read.input_tokens': cacheReadTokens } : {}),
      ...(totalTokens !== undefined ? { 'gen_ai.usage.total_tokens': totalTokens } : {}),
      'gen_ai.output.messages': outputMessages,
      ...(durationMs !== undefined ? { 'gen_ai.response.duration_ms': durationMs } : {}),
      'gen_ai.response.attempt_index': num(record.attempt) ?? 1,
      ...(systemInstructions.length > 0
        ? { 'gen_ai.system_instructions': systemInstructions }
        : {}),
      ...(toolDefinitions.length > 0
        ? { 'gen_ai.tool.definitions': toolDefinitions }
        : {}),
      trace_id: traceId,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
    }));

    entries.push(...this.emitAndRememberToolCalls({
      sid: sessionId, tid: turnId, traceId, requestId, stepId, stepSpanId, providerId,
      completedAtNs: responseTimeNs,
    }, toolCalls));
    return this.sortEntries(entries);
  }

  private sortEntries(entries: AgentActivityEntry[]): AgentActivityEntry[] {
    // Sort: STEP (request time) → llm.request → llm.response → tool.call (all at response time).
    // The flusher's pairing logic doesn't strictly require ordering, but
    // out-of-order events can confuse downstream consumers (mirrors the
    // qwen-code-cli-hook-processor pattern at line 530-536).
    entries.sort((a, b) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });

    return entries;
  }

  private async discoverRolloutFiles(): Promise<string[]> {
    const dir = this.rolloutDir;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('model-io-sess_') && entry.name.endsWith('.jsonl')) {
        files.push(path.join(dir, entry.name));
      }
    }
    return files.sort();
  }

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }
}

function normalizeInputMessage(m: unknown): { role: string; content: string } | null {
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  const role = str(r.role);
  if (!role) return null;
  const content = str(r.content);
  if (content === undefined) return null;
  return { role, content };
}

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

function normalizeToolCall(tc: unknown): ToolCall | null {
  if (!tc || typeof tc !== 'object') return null;
  const r = tc as Record<string, unknown>;
  const id = str(r.id) ?? str(r.toolCallId) ?? str(r.tool_call_id);
  const name = str(r.name) ?? str(r.toolName) ?? str(r.tool_name);
  if (!id || !name) return null;
  const args = r.args ?? r.arguments ?? r.input ?? null;
  return { id, name, args };
}

function extractToolDefinitions(record: Record<string, unknown>, request: Record<string, unknown>): JsonValue[] {
  const body = recordValue(request.body);
  const candidates = [
    body?.tools, request.tools, body?.function_definitions, request.function_definitions,
    request.toolDefinitions, body?.toolDefinitions, record.tools,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const definitions: JsonValue[] = [];
    for (const rawDefinition of candidate) {
      const outer = recordValue(rawDefinition);
      const definition = recordValue(outer?.function) ?? outer;
      const name = str(definition?.name);
      if (!name) continue;
      const tool: Record<string, JsonValue> = { type: str(outer?.type) ?? 'function', name };
      const description = str(definition?.description);
      const parameters = definition?.parameters ?? definition?.input_schema ?? definition?.inputSchema;
      if (description) tool.description = description;
      // The native rollout is decoded from JSONL, so a schema is JSON already.
      if (recordValue(parameters)) tool.parameters = parameters as JsonValue;
      definitions.push(tool);
    }
    if (definitions.length) return definitions;
  }
  const names = Array.isArray(request.toolNames) ? request.toolNames : [];
  return names.flatMap((name: unknown) => typeof name === 'string' && name ? [{ name }] : []);
}

interface ToolResult {
  callId: string;
  content: unknown;
  toolName?: string;
  isError?: boolean;
}

interface PendingToolCall {
  sid: string;
  tid: string;
  traceId: string;
  requestId?: string;
  stepId: string;
  stepSpanId: string;
  providerId: string;
  completedAtNs: string;
  callId: string;
  toolName: string;
  args?: unknown;
  callEmitted?: boolean;
}

/**
 * Read observed tool outcomes in a later model request, including errors
 * recorded only in native history when PostToolUse did not fire.
 */
function matchToolResults(
  row: Record<string, unknown>, pending: PendingToolCall[], turnId: string, traceId: string,
): Map<PendingToolCall, ToolResult> {
  const results = new Map<PendingToolCall, ToolResult>();
  if (!pending.length) return results;
  const request = recordValue(row.request);
  const sample = Array.isArray(request?.messages_sample_truncated) ? request.messages_sample_truncated : [];
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const observed = new Map<string, ToolResult>();
  const declaredNames = new Map<string, string | null>();
  for (const rawMessage of [...sample, ...messages]) {
    const message = recordValue(rawMessage);
    if (message?.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const rawCall of message.toolCalls) {
        const call = normalizeToolCall(rawCall);
        if (!call) continue;
        const previous = declaredNames.get(call.id);
        declaredNames.set(call.id, previous === undefined || previous === call.name ? call.name : null);
      }
    }
    if (message?.role !== 'tool') continue;
    const callId = str(message.toolCallId) ?? str(message.tool_call_id) ?? str(message.toolCallID);
    if (callId) observed.set(callId, {
      callId,
      content: message.content,
      toolName: str(message.toolName) ?? str(message.tool_name),
      isError: message.isError === true || message.is_error === true,
    });
  }

  const exactOwners = new Map<string, PendingToolCall | null>();
  const sameTurnOwners = new Map<string, PendingToolCall | null>();
  for (const call of pending) {
    if (call.tid === turnId) {
      if (call.traceId !== traceId) continue;
      sameTurnOwners.set(call.callId, sameTurnOwners.has(call.callId) ? null : call);
    }
    if (observed.has(call.callId)) exactOwners.set(call.callId, exactOwners.has(call.callId) ? null : call);
  }
  const aliasResults = new Map<PendingToolCall, ToolResult | null>();
  for (const result of observed.values()) {
    if (exactOwners.has(result.callId)) {
      const exact = exactOwners.get(result.callId);
      if (exact) results.set(exact, result);
      continue;
    }
    // ZCode v0.15 may shorten a 24-hex call ID to 15 hex digits in the
    // response and assistant history. Check both sides of the same turn.
    const prefix = /^(call_[0-9a-f]{15})[0-9a-f]{9}$/.exec(result.callId)?.[1];
    if (!prefix || observed.has(prefix)) continue;
    const alias = sameTurnOwners.get(prefix);
    if (!alias || declaredNames.get(prefix) !== alias.toolName) continue;
    if (result.toolName && result.toolName !== alias.toolName) continue;
    aliasResults.set(alias, aliasResults.has(alias) ? null : result);
  }
  for (const [call, result] of aliasResults) {
    if (result) results.set(call, result);
  }
  return results;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalize a raw ZCode finish reason to the canonical validator set.
 * Raw rollout values seen in the wild: 'tool_use', 'tool-calls',
 * 'tool_calls', 'function_call' (all → 'tool_call'); 'aborted'/'interrupted'
 * (→ 'interrupted'); 'cancelled'/'canceled' (→ 'cancelled', kept distinct —
 * it is canonical itself); 'max_output_tokens' (→ 'max_tokens'). Values
 * already canonical pass through; unknown values fall back to 'stop'.
 */
function normalizeFinishReason(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  switch (v) {
    case 'tool_use':
    case 'tool_calls':
    case 'tool_call':
    case 'function_call':
    case 'function_calls':
      return 'tool_call';
    case 'aborted':
    case 'interrupted':
      return 'interrupted';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'max_output_tokens':
      return 'max_tokens';
    default:
      return VALID_FINISH_REASONS.has(v) ? v : 'stop';
  }
}
