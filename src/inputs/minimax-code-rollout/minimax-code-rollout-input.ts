import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import {
  buildAgentActivityEntry,
  timestampToUnixNanos,
  toJsonValue,
} from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_SESSION_DIR = '~/.minimax-code/rollout';
const DEFAULT_FILE_PATTERN = 'model-io-sess_*.jsonl';

export interface MinimaxCodeRolloutInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/**
 * Per-file persistent state under `extra.minimaxCodeRollout`. Mirrors the
 * zcode-rollout `extra.zcodeRollout` pattern (PR #101): BaseSessionInput's
 * stateStore does shallow-merge of `extra` per `${inputId}:${filePath}` key,
 * so we keep our turnStepMap under a dedicated sub-key to survive across
 * polls and restarts.
 *
 *   - inode: tracks file rotation; cleared alongside turnStepMap when the
 *     rollout file is rotated (new session file = new turnIds).
 *   - turnStepMap[turnId]: per-turn counter + requestId de-dup set. A retry
 *     record sharing the same requestId as an earlier record in the same
 *     turn reuses the same stepIdx (so attempt>1 records collapse into one
 *     STEP span).
 */
interface MinimaxCodeRolloutFileState {
  inode: number;
  turnStepMap: Record<string, { requestSet: string[]; nextStepIdx: number }>;
}

/**
 * MiniMax Code rollout JSONL tail — sibling input to MinimaxCodeLogInput.
 *
 * Reads ~/.minimax-code/rollout/model-io-sess_<sid>.jsonl (one file per
 * session) and emits a llm.request + llm.response pair per record, with full
 * LLM payloads (request messages/tools/system + response text/toolCalls/usage)
 * and proper start/end timestamps (startedAt / completedAt).
 *
 * 设计要点 (与 ZCode #101 rollout input 对齐, MiniMax Code 字段命名兼容):
 *   - 每条 rollout 记录展开为两个事件 (llm.request at startedAt +
 *     llm.response at completedAt), 二者通过共享 gen_ai.response.id 配对。
 *     OTLP converter 的 pairLlm 按 event.name 分桶后用 gen_ai.response.id
 *     配对, 单条记录携带 gen_ai.output.messages 不会被拆成两个 span。
 *   - messages 用 ARMS GenAI 约定的 {role, parts: [...]} 形式, 不是 OpenAI
 *     的 {role, content: [...]}. converter 的 parseInputMessages /
 *     parseOutputMessages 只识别 parts 字段, OpenAI content 会被解析为
 *     parts:[] (空) → validator 判 LLM span 缺失 input/output.messages。
 *   - traceId 去连字符转 32-hex (W3C); UUID 带连字符会被 OTLP 转换器拒并
 *     重新分配 traceId, 造成事件归并错位。
 *   - turnStepMap 持久化 (Round 2): per-turn 计数器 + requestId 去重,
 *     跨重启 step.id 稳定。文件轮转 (inode 变化) 时清空。
 *   - interrupted 路径注入 (Round 2): completedAt 存在 + response.finishReason
 *     为 null/空 + 无 text/toolCalls → 注入 finish_reasons=['interrupted']
 *     + 占位 output.messages + 0 usage, 满足 validate-trace 强制规则。
 *
 * Round 3 (PR #233): processSessionLine now emits paired
 *   llm.request + llm.response entries (BaseSessionInput changed to
 *   multi-entry return; this input was migrated to match). Emits
 *   shared trace_id, session/turn/step, agent.type, response.id,
 *   request.id so the OTLP pairLlm can pair them into a single STEP
 *   span.
 *
 * Round 4 (PR #233): hook payload plumbing — AgentHookConfig
 *   hookContainerPath / extraSettings / hookType fields, hook-strategy
 *   honors them, hook-manager matcher omit, requestId/responseId read
 *   top-level first. See agents.d/minimax-code.json and
 *   src/deployment/hook-strategy.ts.
 *
 * Round 5 (PR #233): validate-trace and OTLP flusher now recognize
 *   'interrupted' as a terminal finish_reason (Round 2 emit path was
 *   already correct; only the downstream recognition was missing).
 *   Hook processor dispatch now writes '{}\n' to stdout in a finally
 *   block so the host command-hook protocol never blocks on an empty
 *   stdout.
 *
 * Future work (见 PR description "Future Work"):
 *   - synthesizeOrphanToolRecords flusher enhancement, deferred
 *     until real E2E traces show the orphan case.
 */
export class MinimaxCodeRolloutInput extends BaseSessionInput {
  readonly id = 'minimax-code-rollout';
  readonly agentType = ClientType.MiniMaxCode;

  constructor(opts: MinimaxCodeRolloutInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.MINIMAX_CODE_ROLLOUT_POLL_INTERVAL) || 30_000),
    });
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    // Pre-seed offsets for existing files so a fresh install doesn't replay
    // historical rollout records (mirrors zcode-rollout-input onStart).
    // Also initialize extra.minimaxCodeRollout.{inode,turnStepMap} so the
    // first poll's pre-pass doesn't false-trigger rotation clearing.
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, {
          extra: {
            minimaxCodeRollout: {
              inode: (stat as any).ino,
              turnStepMap: {},
            } as MinimaxCodeRolloutFileState,
          },
        });
      } catch {
        // File may disappear while MiniMax Code rotates session rollout data.
      }
    }
  }

  /**
   * Pre-pass: detect file rotation by comparing stat.ino against
   * extra.minimaxCodeRollout.inode. When rotation is detected, clear
   * turnStepMap (new session file = new turnIds; old counters are
   * meaningless) before delegating to super.collect().
   *
   * BaseSessionInput.processFile is private and clears only `extra.inode`
   * (shallow merge leaves extra.minimaxCodeRollout untouched), so we
   * front-run it here. Mirrors zcode-rollout-input pre-pass (PR #101).
   *
   * Inode=0 sentinel (CP5 fix): when prevRollout is missing (file appeared
   * after onStart) or prevRollout.inode is 0, seed inode to the real
   * stat.ino WITHOUT clearing turnStepMap. Otherwise the next poll's
   * pre-pass would see inode=0 !== stat.ino and falsely trigger rotation,
   * wiping step.id state mid-turn → step.id misalignment.
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const currentIno = (stat as any).ino as number;
        const stateKey = this.stateKey(filePath);
        const prevState = this.stateStore.get(stateKey);
        const prevRollout = prevState.extra?.minimaxCodeRollout as
          | MinimaxCodeRolloutFileState
          | undefined;
        const prevInode = prevRollout?.inode;
        const prevInodeValid = typeof prevInode === 'number' && prevInode !== 0;
        const rotated = prevInodeValid && prevInode !== currentIno;
        // Seed inode on first sight (or after the 0-sentinel), preserving any
        // turnStepMap state accumulated since the last valid inode. Only
        // real rotation clears turnStepMap.
        if (!prevRollout || !prevInodeValid || rotated) {
          this.stateStore.update(stateKey, {
            extra: {
              minimaxCodeRollout: {
                inode: currentIno,
                turnStepMap: rotated ? {} : (prevRollout?.turnStepMap ?? {}),
              } as MinimaxCodeRolloutFileState,
            },
          });
        }
      } catch {
        // File may disappear between discoverSessionFiles and stat; base
        // class will skip it. Non-blocking.
      }
    }
    return super.collect();
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    let entries: string[];
    try {
      entries = await fs.readdir(this.sessionDir);
    } catch {
      return [];
    }
    // Simple glob: prefix + suffix. Node's fs.glob landed in v22 (2024); we
    // use a manual match to keep the input compatible with Node >= 18.
    const prefix = this.filePattern.split('*')[0] ?? '';
    const suffix = this.filePattern.split('*')[1] ?? '';
    for (const name of entries) {
      if (name.startsWith(prefix) && name.endsWith(suffix) && name.length > prefix.length + suffix.length) {
        files.push(path.join(this.sessionDir, name));
      }
    }
    return files;
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry[]> {
    // Round 1: process only the documented `type: 'model-io'` records.
    // Future MiniMax Code rollout schema additions (other event types) are
    // intentionally skipped to keep the input narrowly scoped; expanding the
    // accepted shape will be a follow-up PR once the rollout schema stabilizes.
    if (record['type'] !== 'model-io') return [];

    const sessionId = (record['sessionId'] as string | undefined)
      ?? (record['session_id'] as string | undefined)
      ?? this.extractSessionIdFromFilePath(filePath);
    if (!sessionId) return [];

    const turnId = (record['turnId'] as string | undefined) ?? (record['turn_id'] as string | undefined);
    const request = (record['request'] as Record<string, unknown> | undefined) ?? {};
    const response = (record['response'] as Record<string, unknown> | undefined) ?? {};
    const startedAt = (record['startedAt'] as string | number | undefined);
    const completedAt = (record['completedAt'] as string | number | undefined);
    const modelId = (response['modelId'] as string | undefined)
      ?? (response['model_id'] as string | undefined)
      ?? (request['body'] as any)?.model
      ?? (request['body'] as any)?.modelId;
    const providerName = (response['providerId'] as string | undefined)
      ?? (response['provider_id'] as string | undefined)
      ?? (request['body'] as any)?.provider;

    const inputMessages = this.buildInputMessages(request);
    const outputMessages = this.buildOutputMessages(response);
    const toolDefinitions = this.extractToolDefinitions(request);

    // Interrupted path detection (Round 2): completedAt present but the
    // response has no finishReason / no text / no toolCalls. This is the
    // typical SIGTERM / timeout / Ctrl+C pattern — the LLM call was
    // terminated mid-flight. Without placeholder fields, the LLM span is
    // missing gen_ai.output.messages / finish_reasons / usage, which
    // validate-trace flags as ERROR (CLAUDE.md "semantic.llm_has_input_output"
    // MUST rule).
    const isInterrupted = this.detectInterruptedResponse(response, completedAt);

    const finishReasons = isInterrupted
      ? ['interrupted']
      : this.resolveFinishReasons(response);

    const traceId = this.normalizeTraceId(
      (record['traceId'] as string | undefined) ?? (record['trace_id'] as string | undefined),
    );
    // requestId / responseId: read top-level first (canonical location per
    // MiniMax Code rollout schema; stable across retries — e.g. attempt 2
    // keeps the same id even if startedAt shifts), then fall back to the
    // nested request/response object, then to a synthetic string. This
    // mirrors PR #101 zcode-rollout-input behavior and keeps OTLP pair key
    // stable across retry records.
    const responseId = (record['responseId'] as string | undefined)
      ?? (record['response_id'] as string | undefined)
      ?? (response['responseId'] as string | undefined)
      ?? (response['response_id'] as string | undefined)
      ?? `${sessionId}:${turnId ?? 'unknown'}:${String(startedAt ?? '')}`;
    const requestId = (record['requestId'] as string | undefined)
      ?? (record['request_id'] as string | undefined)
      ?? (request['requestId'] as string | undefined)
      ?? (request['request_id'] as string | undefined)
      ?? `${sessionId}:${turnId ?? 'unknown'}:req:${String(startedAt ?? '')}`;

    // step.id 派生 (Round 2): persistent per-turn counter, de-duped by
    // requestId. Same requestId within a turn reuses the same stepIdx (so
    // attempt>1 retries collapse into one STEP span). Persisted across
    // restarts. Cleared on file rotation (see collect() pre-pass).
    const stepId = this.allocateStepId(filePath, turnId ?? '', requestId);

    // Round 3 (PR #233): emit paired llm.request + llm.response entries
    // instead of the Round 1 combined single entry. The OTLP trace
    // converter's pairLlm uses gen_ai.response.id to pair the two events
    // into a single STEP span; emitting them as two separate entries
    // produces a cleaner span tree (request side carries tool definitions
    // and input.messages; response side carries output.messages and
    // usage) and matches the zcode-rollout-input (PR #101) shape.
    //
    // Common fields shared by both entries (trace_id, session/turn/step,
    // agent type, model, response.id, request.id) ensure pairing works.
    const sharedFields: Record<string, unknown> = {
      'gen_ai.agent.type': ClientType.MiniMaxCode,
      'gen_ai.agent.name': 'MiniMax Code',
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.provider.name': providerName,
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': modelId,
      'gen_ai.response.id': responseId,
      'gen_ai.request.id': requestId,
      ...(traceId ? { trace_id: traceId } : {}),
    };

    const requestRecord: Record<string, unknown> = {
      ...sharedFields,
      'event.name': 'llm.request',
      time_unix_nano: timestampToUnixNanos(startedAt) ?? '0',
      ...(inputMessages ? { 'gen_ai.input.messages': inputMessages } : {}),
      ...(toolDefinitions ? { 'gen_ai.tool.definitions': toolDefinitions } : {}),
    };

    const responseRecord: Record<string, unknown> = {
      ...sharedFields,
      'event.name': 'llm.response',
      time_unix_nano: timestampToUnixNanos(completedAt) ?? timestampToUnixNanos(startedAt) ?? '0',
      'gen_ai.response.finish_reasons': finishReasons,
      'gen_ai.usage.input_tokens': isInterrupted
        ? 0
        : this.coerceNumber((response as any).usage?.inputTokens ?? (response as any).usage?.input_tokens),
      'gen_ai.usage.output_tokens': isInterrupted
        ? 0
        : this.coerceNumber((response as any).usage?.outputTokens ?? (response as any).usage?.output_tokens),
      'gen_ai.usage.cache_read.input_tokens': isInterrupted
        ? 0
        : this.coerceNumber(
          (response as any).usage?.cacheReadTokens ?? (response as any).usage?.cache_read?.input_tokens,
        ),
      'gen_ai.usage.cache_creation.input_tokens': isInterrupted
        ? 0
        : this.coerceNumber(
          (response as any).usage?.cacheCreationTokens ?? (response as any).usage?.cache_creation?.input_tokens,
        ),
      ...(outputMessages
        ? { 'gen_ai.output.messages': outputMessages }
        : isInterrupted
          ? { 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: '' }], finish_reason: 'interrupted' }] as unknown as JsonValue }
          : {}),
    };

    const requestEntry = buildAgentActivityEntry(requestRecord as any);
    const responseEntry = buildAgentActivityEntry(responseRecord as any);
    return [requestEntry, responseEntry];
  }

  // ─── helpers ───

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }

  private extractSessionIdFromFilePath(filePath: string): string | null {
    // model-io-sess_<sid>.jsonl
    const base = path.basename(filePath);
    const match = base.match(/^model-io-sess_(.+)\.jsonl$/);
    return match ? match[1] : null;
  }

  private normalizeTraceId(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return hex.length === 32 ? hex : undefined;
  }

  private detectInterruptedResponse(
    response: Record<string, unknown>,
    completedAt: string | number | undefined,
  ): boolean {
    if (!completedAt) return false;
    const finishReason = (response['finishReason'] as string | undefined)
      ?? (response['finish_reason'] as string | undefined);
    if (typeof finishReason === 'string' && finishReason.length > 0) return false;
    const text = (response['text'] as string | undefined) ?? '';
    const toolCalls = (response['toolCalls'] as unknown[]) ?? (response['tool_calls'] as unknown[]) ?? [];
    if (typeof text === 'string' && text.length > 0) return false;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return false;
    return true;
  }

  /**
   * Allocate a stable step.id per (turnId, requestId). Same requestId within
   * a turn reuses the same stepIdx (so attempt>1 retries collapse into one
   * STEP). Persisted in extra.minimaxCodeRollout.turnStepMap so it survives
   * restarts and per-file inode rotation (cleared in collect() pre-pass).
   *
   * Returns `${turnId}:s${stepIdx+1}` when turnId is non-empty, otherwise
   * undefined (no step.id - the entry floats outside any STEP, validator
   * surfaces this as structure.step_has_one_llm for diagnosis).
   */
  private allocateStepId(filePath: string, turnId: string, requestId: string): string | undefined {
    if (!turnId) return undefined;
    const stateKey = this.stateKey(filePath);
    const prevState = this.stateStore.get(stateKey);
    const prevExtra = prevState.extra?.minimaxCodeRollout as
      | MinimaxCodeRolloutFileState
      | undefined;

    const fileState: MinimaxCodeRolloutFileState = prevExtra && typeof prevExtra === 'object'
      ? prevExtra
      : { inode: 0, turnStepMap: {} };

    let turnState = fileState.turnStepMap[turnId];
    if (!turnState) {
      turnState = { requestSet: [], nextStepIdx: 0 };
      fileState.turnStepMap[turnId] = turnState;
    }

    let stepIdx: number;
    const reqIdx = turnState.requestSet.indexOf(requestId);
    if (reqIdx >= 0) {
      stepIdx = reqIdx;
    } else {
      stepIdx = turnState.nextStepIdx;
      turnState.requestSet.push(requestId);
      turnState.nextStepIdx++;
    }

    // Persist (shallow merge of extra replaces minimaxCodeRollout wholesale,
    // which is what we want — we already mutated turnStepMap in place).
    this.stateStore.update(stateKey, {
      extra: { minimaxCodeRollout: fileState },
    });

    return `${turnId}:s${stepIdx + 1}`;
  }

  private buildInputMessages(request: Record<string, unknown>): JsonValue | undefined {
    const messages = (request['messages'] as unknown[]) ?? (request['body'] as any)?.messages;
    if (!Array.isArray(messages)) return undefined;
    const out = messages
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map((m): JsonValue => {
        const role = (m['role'] as string | undefined) ?? 'user';
        const content = m['content'];
        const parts = this.toParts(role, content, m);
        return { role, parts } as JsonValue;
      });
    return out.length > 0 ? (out as JsonValue) : undefined;
  }

  private buildOutputMessages(response: Record<string, unknown>): JsonValue | undefined {
    const text = (response['text'] as string | undefined) ?? '';
    const toolCalls = (response['toolCalls'] as unknown[]) ?? (response['tool_calls'] as unknown[]) ?? [];
    const finish = (response['finishReason'] as string | undefined)
      ?? (response['finish_reason'] as string | undefined)
      ?? 'stop';
    const parts: JsonValue[] = [];
    if (typeof text === 'string' && text.length > 0) {
      parts.push({ type: 'text', content: text });
    }
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const callId = (tc as any).callId ?? (tc as any).id ?? (tc as any).tool_call_id;
        const name = (tc as any).name ?? (tc as any).toolName;
        const args = (tc as any).input ?? (tc as any).arguments;
        parts.push({
          type: 'tool_call',
          id: typeof callId === 'string' ? callId : undefined,
          name: typeof name === 'string' ? name : undefined,
          arguments: args !== undefined ? toJsonValue(args) : undefined,
        } as JsonValue);
      }
    }
    if (parts.length === 0) return undefined;
    return [{ role: 'assistant', parts, finish_reason: finish } as unknown as JsonValue];
  }

  private toParts(role: string, content: unknown, msg: Record<string, unknown>): JsonValue[] {
    if (role === 'tool') {
      const callId = (msg['toolCallId'] as string | undefined) ?? (msg['tool_call_id'] as string | undefined);
      const resp = content ?? msg['content'];
      const part: Record<string, unknown> = { type: 'tool_call_response' };
      if (typeof callId === 'string') part['id'] = callId;
      if (resp !== undefined) part['response'] = toJsonValue(resp);
      return [part as unknown as JsonValue];
    }
    if (typeof content === 'string') {
      return [{ type: 'text', content } as unknown as JsonValue];
    }
    if (Array.isArray(content)) {
      return content
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c): JsonValue => {
          const text = (c['text'] as string | undefined) ?? '';
          const ctype = (c['type'] as string | undefined) ?? 'text';
          if (ctype === 'text') return { type: 'text', content: text } as unknown as JsonValue;
          return { type: ctype, content: text } as unknown as JsonValue;
        });
    }
    if (content && typeof content === 'object') {
      return [{ type: 'text', content: toJsonValue(content) } as unknown as JsonValue];
    }
    return [];
  }

  private extractToolDefinitions(request: Record<string, unknown>): JsonValue | undefined {
    // Multi-path lookup accommodates both flat ({name, description,
    // input_schema}) and OpenAI nested ({type:'function', function:{name, ...}})
    // shapes. v1 rollout records are likely flat; once we observe nested
    // forms we'll add `unwindFunctionWrapper` here.
    const candidates: unknown[] = [
      (request['body'] as any)?.tools,
      (request as any).tools,
      (request['body'] as any)?.function_definitions,
      (request as any).function_definitions,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        const out = c
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t): JsonValue => this.normalizeToolDef(t));
        if (out.length > 0) return out;
      }
    }
    return undefined;
  }

  private normalizeToolDef(rec: Record<string, unknown>): JsonValue {
    const flat: Record<string, unknown> = { ...rec };
    if (rec['function'] && typeof rec['function'] === 'object') {
      Object.assign(flat, rec['function'] as Record<string, unknown>);
    }
    const out: Record<string, unknown> = { type: 'function' };
    if (typeof flat['name'] === 'string') out['name'] = flat['name'];
    if (typeof flat['description'] === 'string' && flat['description'].length > 0) {
      out['description'] = flat['description'];
    }
    if (flat['input_schema'] !== undefined) out['parameters'] = toJsonValue(flat['input_schema']);
    else if (flat['parameters'] !== undefined) out['parameters'] = toJsonValue(flat['parameters']);
    return out as JsonValue;
  }

  private resolveFinishReasons(response: Record<string, unknown>): string[] {
    const raw = (response['finishReason'] as string | undefined)
      ?? (response['finish_reason'] as string | undefined);
    if (typeof raw !== 'string' || raw.length === 0) return ['stop'];
    return [raw];
  }

  private coerceNumber(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
}
