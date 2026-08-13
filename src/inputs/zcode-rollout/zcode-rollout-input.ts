import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ClientType, CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

// Import the shared helpers from the .mjs file so the AGENT span_id (derived
// in assets/hooks/zcode-hook-processor.mjs) and the STEP parent_span_id
// (derived here) come from the SAME function. Per architect de8a29fe
// implementation reminder: "派生 span_id helper 须为单一 shared 函数，严禁
// 两边各写一份公式——否则跨源拼接静默失败".
//
// The .mjs also reuses hashJson from agent-event-normalizer.mjs, keeping the
// sha256 derivation formula in exactly one place end-to-end.
//
// @ts-expect-error — .mjs has no type declarations; runtime ESM import works
// under NodeNext module resolution.
import { toW3CTraceId, deriveSpanId } from '../../../assets/hooks/shared/event-emitter.mjs';

const DEFAULT_ROLLOUT_DIR = '~/.zcode/cli/rollout';
const AGENT_ID = 'zcode';

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
 * yet seen, initialize byteOffset to current EOF (state store key
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
    // Baseline skip: for each rollout file we haven't seen yet, initialize
    // the byteOffset to the current EOF so pilot doesn't replay history on
    // first install. Spec §1.4 + §1.5 (test: baseline skip).
    //
    // Use a sentinel flag (extra.initialized) rather than relying on
    // lastOffset > 0, because a file can legitimately have lastOffset = 0
    // after inode rotation reset. Without the sentinel, a restart would
    // treat such a file as "never seen" and skip to EOF, dropping data.
    const files = await this.discoverRolloutFiles();
    for (const filePath of files) {
      const stateKey = this.stateKey(filePath);
      const existing = this.stateStore.get(stateKey);
      if (existing.extra?.initialized === true) {
        continue; // already tracking this file
      }
      try {
        const stat = await fs.promises.stat(filePath);
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino), initialized: true } });
      } catch {
        // file may disappear — skip silently
      }
    }
  }

  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverRolloutFiles();
    const allEntries: AgentActivityEntry[] = [];

    for (const filePath of files) {
      const entries = await this.processFile(filePath);
      allEntries.push(...entries);
    }
    return allEntries;
  }

  private async processFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = this.stateKey(filePath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return [];
    }

    const prevState = this.stateStore.get(stateKey);
    const prevInode = prevState.extra?.inode as number | undefined;

    if (prevInode !== undefined && prevInode !== Number((stat as any).ino)) {
      // Inode changed → file rotated, reset to 0 to re-read the new file.
      this.stateStore.setOffset(stateKey, 0);
    }

    let offset = this.stateStore.getOffset(stateKey);
    if (offset > 0 && stat.size < offset) {
      // File truncated (e.g. zcode compaction reset). Reset to 0.
      this.logger.info('rollout file truncated, resetting offset', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
    }
    if (stat.size <= offset) return [];

    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');

      // P1 fix: only commit offset to the LAST COMPLETE NEWLINE, not stat.size.
      // If ZCode writes a partial final line (no trailing \n), we must NOT
      // advance past it — the next poll will re-read from the last \n and
      // pick up the completed line. Without this, a half-written JSONL line
      // is parsed as invalid, offset jumps to EOF, and the rest of the line
      // arriving in the next poll is permanently lost.
      const lastNewline = text.lastIndexOf('\n');
      const committedBytes = lastNewline >= 0
        ? offset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf-8')
        : offset;
      if (committedBytes > offset) {
        this.stateStore.setOffset(stateKey, committedBytes);
      }
      this.stateStore.update(stateKey, { extra: { inode: Number((stat as any).ino) } });

      // Parse only complete lines (up to and including the last \n).
      const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
      const lines: Record<string, unknown>[] = [];
      for (const line of completeText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch (err) {
          this.logger.warn('invalid rollout JSONL line', { file: filePath, error: String(err) });
          continue;
        }
        lines.push(parsed);
      }
      return this.buildEntriesFromRolloutLines(lines);
    } finally {
      await handle.close();
    }
  }

  /**
   * Convert a batch of rollout `model_io` lines into AgentActivityEntry records.
   *
   * Batch (not per-line) because tool.result pairing requires cross-batch state:
   * tool results for line N's toolCalls live in line N+1's
   * request.messages[role=tool]. When line N is the last line of a batch (no
   * nextRecord), the toolCalls are buffered to state and paired when the next
   * batch's first line arrives.
   *
   * STEP↔LLM 1:1 attribution (iter 6 fix):
   *   - Each rollout line carries a unique `requestId` per LLM call within a
   *     turn. We derive `gen_ai.step.id` = `<turnId>:<requestId>` and
   *     `stepSpanId` = `deriveSpanId('step', sid, tid, requestId)` directly
   *     from this stable per-line identifier — NO state-dependent counter.
   *     The previous approach (synthesizing an attempt index via
   *     `nextTurnIndex` persisted in stateStore) was fragile: if the daemon
   *     was restarted between collect() cycles and the in-memory `extra.idx`
   *     had not yet been persisted to disk, the next cycle reset to 1 and
   *     collided with earlier lines, producing merged STEPs with 2+ LLM
   *     children (validate-trace `structure.step_has_one_llm` ERROR).
   *     Using `requestId` removes the state dependency entirely.
   *
   * Pending toolCalls are persisted in stateStore keyed by
   * `pending-tool-calls:<sid>+<tid>` so a toolCall emitted in batch K can
   * be paired with a tool result message arriving in batch K+1.
   */
  buildEntriesFromRolloutLines(lines: Record<string, unknown>[]): AgentActivityEntry[] {
    const allEntries: AgentActivityEntry[] = [];

    // Flush pending toolCalls from previous batches using this batch's first
    // line. The first line's request.messages[role=tool] holds tool results
    // produced for the previous batch's last-line toolCalls.
    if (lines.length > 0) {
      const first = lines[0];
      const fsid = str(first.sessionId) ?? str(first.session_id);
      const ftid = str(first.turnId) ?? str(first.turn_id);
      if (fsid && ftid && first.type === 'model_io') {
        allEntries.push(...this.flushPendingToolCalls(fsid, ftid, first));
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const record = lines[i];
      if (record.type !== 'model_io') continue;
      const sid = str(record.sessionId) ?? str(record.session_id) ?? '';
      const tid = str(record.turnId) ?? str(record.turn_id) ?? '';
      const isLastInBatch = i + 1 >= lines.length;
      const nextRecord = !isLastInBatch ? lines[i + 1] : undefined;

      if (isLastInBatch && this.lineHasToolCalls(record)) {
        // Last line of batch with toolCalls: emit STEP+LLM but buffer the
        // toolCalls to state — they'll be paired with the next batch's first
        // line (or emitted as placeholders if no next batch arrives).
        allEntries.push(...this.buildEntriesFromRolloutLine(record, undefined, { skipToolCalls: true }));
        // Guard: only buffer when sid+tid are valid. Malformed/partial records
        // with empty sid/tid would otherwise share a single `:+` state key,
        // corrupting pairing across sessions/turns.
        if (sid && tid) {
          this.bufferPendingToolCalls(sid, tid, record);
        }
      } else {
        allEntries.push(...this.buildEntriesFromRolloutLine(record, nextRecord));
      }
    }
    return allEntries;
  }

  private lineHasToolCalls(record: Record<string, unknown>): boolean {
    const response = (record.response && typeof record.response === 'object' ? record.response : {}) as Record<string, unknown>;
    return Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
  }

  /**
   * Buffer a line's toolCalls to state for cross-batch pairing. Stores enough
   * metadata to emit tool.call + tool.result records in a future batch without
   * re-reading the source line.
   */
  private bufferPendingToolCalls(
    sid: string, tid: string,
    record: Record<string, unknown>,
  ): void {
    const key = `zcode-rollout:pending-tool-calls:${sid}+${tid}`;
    const existing = (this.stateStore.get(key).extra?.pending as PendingToolCall[] | undefined) ?? [];
    const response = (record.response && typeof record.response === 'object' ? record.response : {}) as Record<string, unknown>;
    const toolCallsRaw = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const requestId = str(record.requestId) ?? str(record.request_id) ?? crypto.randomUUID();
    const responseId = str(response.responseId) ?? str(response.response_id) ?? requestId;
    const traceIdRaw = str(record.traceId) ?? str(record.trace_id) ?? '';
    const traceId = toW3CTraceId(traceIdRaw);
    const completedAt = str(record.completedAt) ?? str(record.completed_at);
    const completedAtNs = timestampToUnixNanos(completedAt || str(record.startedAt) || Date.now());
    const model = (record.model && typeof record.model === 'object' ? record.model : {}) as Record<string, unknown>;
    const providerId = str(model.providerId) ?? str(model.provider_id) ?? 'unknown';
    const modelId = str(model.modelId) ?? str(model.model_id) ?? 'unknown';
    const responseModelId = str(response.modelId) ?? str(response.model_id) ?? modelId;
    const stepId = `${tid}:${requestId}`;
    const stepSpanId = deriveSpanId('step', sid, tid, requestId);
    const stepParentSpanId = deriveSpanId('agent', sid, tid);

    const pending: PendingToolCall[] = [...existing];
    for (const tc of toolCallsRaw as unknown[]) {
      if (!tc || typeof tc !== 'object') continue;
      const r = tc as Record<string, unknown>;
      const callId = str(r.id) ?? str(r.toolCallId) ?? str(r.tool_call_id);
      const toolName = str(r.name) ?? str(r.toolName) ?? str(r.tool_name);
      if (!callId || !toolName) continue;
      const args = r.args ?? r.arguments ?? r.input ?? null;
      pending.push({
        sid, tid, traceId, requestId, responseId,
        stepId, stepSpanId, stepParentSpanId,
        providerId, modelId, responseModelId,
        completedAtNs, callId, toolName, args,
      });
    }
    this.stateStore.update(key, { extra: { pending } });
  }

  /**
   * Pair pending toolCalls (buffered in previous batches) with the current
   * line's request.messages[role=tool]. Emits tool.call + tool.result records
   * for matched pairs. Unmatched pending toolCalls are emitted as
   * tool.call + 1ms placeholder tool.result (EOF/abort fallback per task #3).
   * Clears the state key after flushing.
   */
  private flushPendingToolCalls(
    sid: string, tid: string,
    currentLine: Record<string, unknown>,
  ): AgentActivityEntry[] {
    const key = `zcode-rollout:pending-tool-calls:${sid}+${tid}`;
    const pending = (this.stateStore.get(key).extra?.pending as PendingToolCall[] | undefined) ?? [];
    if (pending.length === 0) return [];

    const toolResultsByCallId = collectToolResults(currentLine);
    const nextStartedAtNs = timestampToUnixNanos(
      str(currentLine.startedAt) ?? str(currentLine.started_at) ?? '',
    );
    const oneNs = 1n;
    const oneMsNs = 1_000_000n;
    const out: AgentActivityEntry[] = [];

    for (const p of pending) {
      const toolSpanId = deriveSpanId('tool', p.sid, p.tid, p.requestId ?? 'r', p.callId);
      const callTimeNs = p.completedAtNs;
      const result = toolResultsByCallId.get(p.callId);
      // tool.result time: pick a time strictly inside (callTime, nextStartedAt)
      // so that the tool span has non-zero duration AND its STEP does not
      // overlap the next STEP (which starts at nextStartedAt). When there is
      // no next line (EOF), fall back to callTime + 1ms so the span is still
      // non-zero. This fixes iter5 `time.non_zero_duration` (0ms TOOL) and
      // `time.no_step_overlap` (STEP N end == STEP N+1 start) errors.
      let resultTimeNs: string;
      if (nextStartedAtNs && BigInt(nextStartedAtNs) > BigInt(callTimeNs) + oneNs) {
        resultTimeNs = (BigInt(nextStartedAtNs) - oneNs).toString();
      } else {
        resultTimeNs = (BigInt(callTimeNs) + oneMsNs).toString();
      }

      out.push(buildAgentActivityEntry({
        time_unix_nano: callTimeNs,
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
        span_id: toolSpanId,
        parent_span_id: p.stepSpanId,
      }));

      if (result) {
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
          'tool.result.status': isError ? 'error' : 'ok',
          ...(isError && result.content
            ? { 'error.type': 'ToolError', 'error.message': String(result.content).slice(0, 500) }
            : {}),
          trace_id: p.traceId,
          span_id: toolSpanId,
          parent_span_id: p.stepSpanId,
        }));
      } else {
        // Placeholder tool.result (1ms duration) — paired result never arrived
        // (e.g. LLM aborted before consuming tool output, or session was
        // interrupted). Use 'interrupted' status to indicate this is NOT a
        // real successful completion; the previous 'ok' was incorrectly
        // normalized to 'unknown' and produced false audit semantics.
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
          'gen_ai.tool.name': p.toolName,
          'gen_ai.tool.call.id': p.callId,
          'gen_ai.tool.call.exec.id': p.callId,
          'tool.result.status': 'interrupted',
          trace_id: p.traceId,
          span_id: toolSpanId,
          parent_span_id: p.stepSpanId,
        }));
      }
    }

    // Clear pending — they've all been emitted (paired or placeholder).
    this.stateStore.update(key, { extra: { pending: [] } });

    // Sort flushed tool records by time so the flusher sees them in order.
    out.sort((a, b) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
    return out;
  }

  /**
   * Convert one rollout `model_io` line into multiple AgentActivityEntry records:
   * STEP envelope + llm.request + llm.response + tool.call/result per toolCalls[].
   *
   * `nextRecord` is the next rollout line in the same file, used to pair
   * tool.call → tool.result (from next line's request.messages[role=tool]) and
   * to derive non-zero TOOL span duration (end = next line startedAt - 1ns).
   *
   * `options.skipToolCalls = true` skips tool.call/tool.result emission entirely
   * — used by the batch caller when the line is the last of a batch and its
   * toolCalls need to be buffered for cross-batch pairing.
   *
   * STEP↔LLM 1:1 attribution (iter 6 fix):
   *   - `gen_ai.step.id` = `<turnId>:<requestId>` and `stepSpanId` =
   *     `deriveSpanId('step', sessionId, turnId, requestId)`. `requestId` is
   *     unique per LLM call within a turn in ZCode rollout data, so each LLM
   *     call gets its own STEP without depending on a state-persisted counter.
   *
   * Public so tests can drive it directly with fixture lines.
   */
  buildEntriesFromRolloutLine(
    record: Record<string, unknown>,
    nextRecord?: Record<string, unknown>,
    options: { skipToolCalls?: boolean } = {},
  ): AgentActivityEntry[] {
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

    // P1 fix: extract system_instructions (role=="system" messages) and
    // tool_definitions (request.toolNames — names only, no
    // description/parameters; ZCode rollout does not log full tool schemas,
    // so we emit name-only definitions and document the gap as P2 follow-up
    // for downstream consumers needing full JSON schemas).
    const systemInstructions: JsonValue[] = (rawInputMessages as unknown[])
      .map((m) => normalizeInputMessage(m))
      .filter(Boolean)
      .filter((m) => m!.role === 'system')
      .map((m) => ({ type: 'text', content: String(m!.content ?? '') })) as JsonValue[];
    const toolNamesRaw = Array.isArray(request.toolNames) ? request.toolNames : [];
    const toolDefinitions: JsonValue[] = (toolNamesRaw as unknown[])
      .map((n) => (typeof n === 'string' ? { name: n } : null))
      .filter(Boolean) as JsonValue[];

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
    const rawFinishReason = str(response.finishReason) ?? str(response.finish_reason);
    const hasCompletedAt = !!(str(record.completedAt) ?? str(record.completed_at));
    const finishReason = rawFinishReason
      ?? (hasCompletedAt ? 'interrupted' : 'end_turn');
    const responseId = str(response.responseId) ?? str(response.response_id) ?? requestId;
    const responseModelId = str(response.modelId) ?? str(response.model_id) ?? modelId;
    const toolCallsRaw = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const toolCalls = (toolCallsRaw as unknown[])
      .map((tc) => normalizeToolCall(tc))
      .filter(Boolean) as { id: string; name: string; args: unknown }[];

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

    entries.push(buildAgentActivityEntry({
      time_unix_nano: responseTimeNs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
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

    // tool.call + tool.result per response.toolCalls[].
    //
    // Rollout's `model_io` record carries toolCalls definitions on the
    // response side, but tool results only appear in the NEXT line's
    // request.messages[role=tool] (since the next LLM call's input includes
    // the prior tool's output). We pair them here using `nextRecord`.
    //
    // TOOL span duration: rollout has no independent tool execution timestamp.
    // We derive the tool execution window as [current LLM completedAt, next
    // LLM startedAt). When there is no next line (last LLM in turn), fall back
    // to a 1ms placeholder so the span is non-zero (validator rule
    // time.non_zero_duration).
    //
    // When `options.skipToolCalls` is set, the caller is buffering toolCalls
    // for cross-batch pairing — don't emit tool.call/result here. The batch
    // caller (buildEntriesFromRolloutLines) handles emission via
    // flushPendingToolCalls in the next batch.
    if (options.skipToolCalls) {
      return this.sortEntries(entries);
    }

    const toolResultsByCallId = collectToolResults(nextRecord);
    const nextStartedAtNs = nextRecord
      ? timestampToUnixNanos(str(nextRecord.startedAt) ?? str(nextRecord.started_at) ?? completedAt)
      : undefined;
    const oneNs = 1n;
    const oneMsNs = 1_000_000n;
    // tool.result time: pick a time strictly inside (responseTime, nextStartedAt)
    // so that the tool span has non-zero duration AND its STEP does not overlap
    // the next STEP (which starts at nextStartedAt). When there is no next line
    // (EOF), fall back to responseTime + 1ms so the span is still non-zero.
    // This fixes iter5 `time.non_zero_duration` (0ms TOOL) and
    // `time.no_step_overlap` (STEP N end == STEP N+1 start) errors.
    const toolResultTimeNs = nextStartedAtNs && BigInt(nextStartedAtNs) > BigInt(responseTimeNs) + oneNs
      ? (BigInt(nextStartedAtNs) - oneNs).toString()
      : (BigInt(responseTimeNs) + oneMsNs).toString();
    for (const tc of toolCalls) {
      const toolSpanId = deriveSpanId('tool', sessionId, turnId, requestId, tc.id);
      entries.push(buildAgentActivityEntry({
        time_unix_nano: responseTimeNs,
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        'gen_ai.session.id': sessionId,
        'gen_ai.turn.id': turnId,
        'gen_ai.step.id': stepId,
        'gen_ai.agent.type': ClientType.ZCode,
        'gen_ai.agent.id': sessionId,
        'gen_ai.agent.name': 'ZCode',
        'agent.source': 'zcode-rollout',
        'gen_ai.provider.name': providerId,
        'gen_ai.tool.name': tc.name,
        'gen_ai.tool.call.id': tc.id,
        'gen_ai.tool.call.exec.id': tc.id,
        ...(tc.args !== undefined && tc.args !== null
          ? { 'gen_ai.tool.call.arguments': tc.args as JsonValue }
          : {}),
        trace_id: traceId,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
      }));

      const result = toolResultsByCallId.get(tc.id);
      if (result) {
        const isError = result.isError === true;
        entries.push(buildAgentActivityEntry({
          time_unix_nano: toolResultTimeNs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.agent.type': ClientType.ZCode,
          'gen_ai.agent.id': sessionId,
          'gen_ai.agent.name': 'ZCode',
          'agent.source': 'zcode-rollout',
          'gen_ai.provider.name': providerId,
          'gen_ai.tool.name': result.toolName ?? tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          ...(result.content !== undefined
            ? { 'gen_ai.tool.call.result': result.content as JsonValue }
            : {}),
          'tool.result.status': isError ? 'error' : 'ok',
          ...(isError && result.content
            ? { 'error.type': 'ToolError', 'error.message': String(result.content).slice(0, 500) }
            : {}),
          trace_id: traceId,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
        }));
      } else {
        // Placeholder tool.result (1ms duration) — paired result not found in
        // nextRecord (nextRecord absent or no matching tool msg). Use
        // 'interrupted' status to indicate this is NOT a real completion.
        entries.push(buildAgentActivityEntry({
          time_unix_nano: toolResultTimeNs,
          'event.id': crypto.randomUUID(),
          'event.name': 'tool.result',
          'gen_ai.session.id': sessionId,
          'gen_ai.turn.id': turnId,
          'gen_ai.step.id': stepId,
          'gen_ai.agent.type': ClientType.ZCode,
          'gen_ai.agent.id': sessionId,
          'gen_ai.agent.name': 'ZCode',
          'agent.source': 'zcode-rollout',
          'gen_ai.provider.name': providerId,
          'gen_ai.tool.name': tc.name,
          'gen_ai.tool.call.id': tc.id,
          'gen_ai.tool.call.exec.id': tc.id,
          'tool.result.status': 'interrupted',
          trace_id: traceId,
          span_id: toolSpanId,
          parent_span_id: stepSpanId,
        }));
      }
    }

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

function normalizeToolCall(tc: unknown): { id: string; name: string; args: unknown } | null {
  if (!tc || typeof tc !== 'object') return null;
  const r = tc as Record<string, unknown>;
  const id = str(r.id) ?? str(r.toolCallId) ?? str(r.tool_call_id);
  const name = str(r.name) ?? str(r.toolName) ?? str(r.tool_name);
  if (!id || !name) return null;
  const args = r.args ?? r.arguments ?? r.input ?? null;
  return { id, name, args };
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
  responseId?: string;
  stepId: string;
  stepSpanId: string;
  stepParentSpanId: string;
  providerId: string;
  modelId: string;
  responseModelId: string;
  completedAtNs: string;
  callId: string;
  toolName: string;
  args: unknown;
}

/**
 * Scan the NEXT rollout line's request.messages for `role:"tool"` entries and
 * index them by tool call id. ZCode rollout stores tool results as top-level
 * messages with `role:"tool"` + `toolCallId` + `content` + optional `toolName`
 * + `isError` — they appear in the next LLM call's input because that call
 * consumes the prior tool's output. Returns a Map keyed by toolCallId.
 */
function collectToolResults(nextRecord?: Record<string, unknown>): Map<string, ToolResult> {
  const out = new Map<string, ToolResult>();
  if (!nextRecord || typeof nextRecord !== 'object') return out;
  const req = (nextRecord.request && typeof nextRecord.request === 'object'
    ? nextRecord.request : {}) as Record<string, unknown>;
  const msgs = Array.isArray(req.messages_sample_truncated)
    ? req.messages_sample_truncated
    : Array.isArray(req.messages) ? req.messages : [];
  for (const m of msgs as unknown[]) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (r.role !== 'tool') continue;
    const callId = str(r.toolCallId) ?? str(r.tool_call_id) ?? str(r.toolCallID);
    if (!callId) continue;
    out.set(callId, {
      callId,
      content: r.content,
      toolName: str(r.toolName) ?? str(r.tool_name),
      isError: r.isError === true,
    });
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
