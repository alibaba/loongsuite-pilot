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
 *
 * Inheritance mirrors zcode-rollout-input / qoder-cli-session: per-file
 * inode-aware offset via BaseSessionInput; LISTENER_AGENT_MAP['minimax-code-rollout']
 * = 'minimax-code'.
 *
 * Round 1 scope (deferred to Round 2 — see PR description):
 *   - step.id 派生为 ${turnId}:s${stepIdx}; 不持久化 turnStepMap.
 *   - emit 单个 llm.response entry (含 input.messages 附在 response 旁),
 *     不发独立 llm.request. BaseSessionInput.processSessionLine 仍返回单个
 *     entry; 升级到 pair 需要 BaseSessionInput 改造 (与 PR #101 一致)。
 *   - interrupted 路径注入 / synthesizeOrphanToolRecords / 多路径 tool
 *     definitions 抽取等高级处理见 PR description "Future Work" 章节。
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
    // historical rollout records (mirrors zcode-rollout-input / qoder-cli-session
    // onStart).
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = `${this.id}:${filePath}`;
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      } catch {
        // File may disappear while MiniMax Code rotates session rollout data.
      }
    }
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
  ): Promise<AgentActivityEntry | null> {
    // Round 1: process only the documented `type: 'model-io'` records.
    // Future MiniMax Code rollout schema additions (other event types) are
    // intentionally skipped to keep the input narrowly scoped; expanding the
    // accepted shape will be a follow-up PR once the rollout schema stabilizes.
    if (record['type'] !== 'model-io') return null;

    const sessionId = (record['sessionId'] as string | undefined)
      ?? (record['session_id'] as string | undefined)
      ?? this.extractSessionIdFromFilePath(filePath);
    if (!sessionId) return null;

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
    const finishReasons = this.resolveFinishReasons(response);

    const traceId = this.normalizeTraceId(
      (record['traceId'] as string | undefined) ?? (record['trace_id'] as string | undefined),
    );
    const responseId = (response['responseId'] as string | undefined)
      ?? (response['response_id'] as string | undefined)
      ?? `${sessionId}:${turnId ?? 'unknown'}:${String(startedAt ?? '')}`;
    const requestId = (request['requestId'] as string | undefined)
      ?? (request['request_id'] as string | undefined)
      ?? `${sessionId}:${turnId ?? 'unknown'}:req:${String(startedAt ?? '')}`;

    // Step.id 派生: turnId + 当前文件已处理字节偏移 (不持久化, 仅 in-session stable).
    // Round 2 计划: 持久化 turnStepMap (与 PR #101 zcode-rollout 对齐).
    const stateKey = `${this.id}:${filePath}`;
    const state = this.stateStore.get(stateKey);
    const fileOffset = state.lastOffset ?? 0;
    const stepId = turnId ? `${turnId}:s${Math.max(1, fileOffset)}` : undefined;

    // Round 1: 单 entry 形式, 包含 input.messages + output.messages + usage.
    // The OTLP trace converter constructs a non-zero-duration LLM span from
    // a single llm.response entry that carries both input.messages and
    // output.messages. Round 2 will switch to paired llm.request + llm.response
    // (requires BaseSessionInput multi-entry support, mirroring PR #101).
    const combined: Record<string, unknown> = {
      'event.name': 'llm.response',
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
      'gen_ai.response.finish_reasons': finishReasons,
      'gen_ai.usage.input_tokens': this.coerceNumber((response as any).usage?.inputTokens ?? (response as any).usage?.input_tokens),
      'gen_ai.usage.output_tokens': this.coerceNumber((response as any).usage?.outputTokens ?? (response as any).usage?.output_tokens),
      'gen_ai.usage.cache_read.input_tokens': this.coerceNumber(
        (response as any).usage?.cacheReadTokens ?? (response as any).usage?.cache_read?.input_tokens,
      ),
      'gen_ai.usage.cache_creation.input_tokens': this.coerceNumber(
        (response as any).usage?.cacheCreationTokens ?? (response as any).usage?.cache_creation?.input_tokens,
      ),
      ...(traceId ? { trace_id: traceId } : {}),
      ...(toolDefinitions ? { 'gen_ai.tool.definitions': toolDefinitions } : {}),
      ...(inputMessages ? { 'gen_ai.input.messages': inputMessages } : {}),
      ...(outputMessages ? { 'gen_ai.output.messages': outputMessages } : {}),
    };
    const entry = buildAgentActivityEntry(combined as any);
    return entry;
  }

  // ─── helpers ───

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
          // best-effort passthrough for unknown part types
          return { type: ctype, content: text } as unknown as JsonValue;
        });
    }
    if (content && typeof content === 'object') {
      // Tool result object — pass through
      return [{ type: 'text', content: toJsonValue(content) } as unknown as JsonValue];
    }
    return [];
  }

  private extractToolDefinitions(request: Record<string, unknown>): JsonValue | undefined {
    // Multi-path lookup mirrors zcode-rollout-input's normalizeToolDefinitions
    // (G1 fix), accommodating both flat ({name, description, input_schema})
    // and OpenAI nested ({type:'function', function:{name, ...}}) shapes. v1
    // rollout records are likely flat; once we observe nested forms we'll
    // add `unwindFunctionWrapper` here.
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
    // OpenAI nested: {type:'function', function:{name, description, parameters}}
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
