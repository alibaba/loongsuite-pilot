import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_SESSION_DIR = '~/.zcode/cli/rollout';
const DEFAULT_FILE_PATTERN = 'model-io-sess_*.jsonl';
const SOURCE = 'zcode-rollout';

/**
 * Per-file persistent state under `extra.zcodeRollout`. Mirrors the codex-
 * transcript `extra.codexTranscript` pattern: BaseSessionInput's stateStore
 * already does shallow-merge of `extra` per `${inputId}:${filePath}` key, so
 * we keep our turnStepMap under a dedicated sub-key to survive across polls
 * and restarts.
 *
 *   - inode: tracks file rotation; cleared alongside turnStepMap when the
 *     rollout file is rotated (new session file = new turnIds).
 *   - turnStepMap[turnId]: per-turn counter + requestId de-dup set. A retry
 *     record sharing the same requestId as an earlier record in the same
 *     turn reuses the same stepIdx (so attempt>1 records collapse into one
 *     STEP span).
 */
interface ZcodeRolloutFileState {
  inode: number;
  turnStepMap: Record<string, { requestSet: string[]; nextStepIdx: number }>;
}

export interface ZcodeRolloutInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/**
 * ZCode rollout JSONL tail — independent Input class per architect CP2 hard
 * constraint. Reads ~/.zcode/cli/rollout/model-io-sess_<sid>.jsonl (one file
 * per session) and emits a llm.request + llm.response pair per record, with
 * full LLM payloads (request messages/tools/system + response text/toolCalls/
 * usage) and proper start/end timestamps (startedAt / completedAt).
 *
 * 设计要点 (CP5 准出修复):
 *   - 每条 rollout 记录展开为两个事件 (llm.request at startedAt + llm.response
 *     at completedAt)，二者通过共享 gen_ai.response.id 配对。OTLP converter
 *     的 pairLlm 按 event.name 分桶后用 gen_ai.response.id 配对，单条记录
 *     携带 gen_ai.output.messages 不会被拆成两个 span。
 *   - messages 用 GenAI 约定的 {role, parts: [...]} 形式,不是 OpenAI 的
 *     {role, content: [...]}。converter 的 parseInputMessages / parseOutputMessages
 *     只识别 parts 字段,OpenAI content 会被解析为 parts:[] (空) → validator
 *     判 LLM span 缺失 input/output.messages。
 *   - traceId 去连字符转 32-hex (W3C);UUID 带连字符会被 OTLP 转换器拒并
 *     重新分配 traceId，造成事件归并错位。
 *
 * Inheritance mirrors qoder-cli-session: per-file inode-aware offset via
 * BaseSessionInput; LISTENER_AGENT_MAP['zcode-rollout'] = 'zcode'.
 */
export class ZcodeRolloutInput extends BaseSessionInput {
  readonly id = 'zcode-rollout';
  readonly agentType = ClientType.ZcodeHook;

  constructor(opts: ZcodeRolloutInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.ZCODE_ROLLOUT_POLL_INTERVAL) || 30_000),
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
    // historical rollout records (mirrors qoder-cli-session onStart).
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        this.stateStore.setOffset(stateKey, stat.size);
        // Initialize extra.zcodeRollout.inode so the first poll after onStart
        // doesn't false-trigger rotation clearing. turnStepMap stays empty —
        // the first record seen for each turnId allocates stepIdx=0.
        this.stateStore.update(stateKey, {
          extra: {
            zcodeRollout: {
              inode: (stat as any).ino,
              turnStepMap: {},
            } as ZcodeRolloutFileState,
          },
        });
      } catch {
        // File may disappear while ZCode rotates session rollout data.
      }
    }
  }

  /**
   * Pre-pass: detect file rotation by comparing stat.ino against
   * extra.zcodeRollout.inode. When rotation is detected, clear turnStepMap
   * (new session file = new turnIds; old counters are meaningless) before
   * delegating to super.collect() which performs its own inode check and
   * reads the new file from offset 0.
   *
   * BaseSessionInput.processFile is private and clears only `extra.inode`
   * (shallow merge leaves extra.zcodeRollout untouched), so we front-run it
   * here. See plan 1.1 "文件轮转" caveat.
   *
   * Inode seeding (CP5 fix): when prevRollout is missing (file appeared
   * after onStart) or prevRollout.inode is the 0 sentinel left by
   * allocateStepId's fresh-fileState path, we must seed inode to the real
   * stat.ino WITHOUT clearing turnStepMap. Otherwise the next poll's pre-pass
   * would see inode=0 !== stat.ino and falsely trigger rotation, wiping
   * step.id state mid-turn — which caused step.id misalignment (s1/s1/s2
   * instead of s1/s2/s3) when records arrived in separate polls.
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const currentIno = (stat as any).ino as number;
        const stateKey = this.stateKey(filePath);
        const prevState = this.stateStore.get(stateKey);
        const prevRollout = prevState.extra?.zcodeRollout as
          | ZcodeRolloutFileState
          | undefined;
        const prevInode = prevRollout?.inode;
        const prevInodeValid =
          typeof prevInode === 'number' && prevInode !== 0;
        const rotated = prevInodeValid && prevInode !== currentIno;
        // Seed inode on first sight (or after the 0-sentinel left by
        // allocateStepId), preserving any turnStepMap state accumulated
        // since the last valid inode. Only real rotation clears turnStepMap.
        if (!prevRollout || !prevInodeValid || rotated) {
          this.stateStore.update(stateKey, {
            extra: {
              zcodeRollout: {
                inode: currentIno,
                turnStepMap: rotated ? {} : (prevRollout?.turnStepMap ?? {}),
              } as ZcodeRolloutFileState,
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
    await collectFiles(this.sessionDir, this.filePattern, files);
    return files.sort();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry[] | null> {
    const type = stringValue(record.type);
    if (type && type !== 'model-io' && type !== 'model_io') {
      // ZCode rollout files may eventually carry other record types; skip.
      // Accept both hyphen and underscore forms (researcher's fixture uses
      // 'model_io'; downstream tooling may normalize).
      return null;
    }

    const sessionId = stringValue(record.sessionId) ?? sessionIdFromPath(filePath);
    const traceId = normalizeTraceId(stringValue(record.traceId));
    const turnId = stringValue(record.turnId) ?? '';
    const requestId = stringValue(record.requestId) ?? '';
    const model = asRecord(record.model);
    const modelId = stringValue(model.modelId) ?? stringValue(record.modelId) ?? 'unknown';
    const providerId = stringValue(model.providerId) ?? '';
    const startedAt = stringValue(record.startedAt);
    const completedAt = stringValue(record.completedAt);

    const request = asRecord(record.request);
    const requestBody = asRecord(request.body);
    const response = asRecord(record.response);
    const usage = asRecord(response.usage);
    const responseId = stringValue(response.responseId) ?? '';

    const startMs = isoToMs(startedAt) || Date.now();
    const endMs = isoToMs(completedAt) || startMs;

    // step.id allocation (plan 1.1): keyed by turnId, de-duped by requestId
    // so retry records (attempt>1, same requestId) collapse into one STEP.
    // Persisted in extra.zcodeRollout.turnStepMap so it survives restarts.
    const stepId = this.allocateStepId(filePath, turnId, requestId);

    const baseAttrs: Record<string, JsonValue> = {
      source: SOURCE,
      'zcode.rollout.file': path.basename(filePath),
    };
    if (providerId) baseAttrs['gen_ai.provider.name'] = providerId;
    if (completedAt) baseAttrs['zcode.rollout.completed_at'] = completedAt;

    // ZCode rollout 把 messages 放在 request.messages (与 request.body 并列),
    // 不是 request.body.messages。system 角色单独走 gen_ai.system_instructions
    // (来自 request.body.system + request.messages 中 role=system 的消息 +
    //  user 消息里嵌入的 <system-reminder> 段),其余角色进 gen_ai.input.messages。
    const inputMessages = toGenAiInputMessages(request.messages);
    const systemInstructions = mergeSystemInstructions(
      toGenAiSystemInstructions(requestBody.system),
      extractSystemFromMessages(request.messages),
    );
    // Tool definitions: try multiple paths to be robust against ZCode version
    // differences. v3.2.3 fixture puts tools at request.body.tools; v0.15.0
    // production rollout may relocate them. Normalize to ARMS GenAI
    // FunctionToolDefinition schema ({type:'function', name, description?,
    // parameters?}) so the OTLP converter's parseToolDefinitions accepts them
    // and getToolDefinitionsForSpan emits gen_ai.tool.definitions on LLM spans.
    const toolDefinitions = extractToolDefinitions(record);
    const maxTokens = finiteNumber(requestBody.max_tokens);
    const outputMessages = toGenAiOutputMessages(response);
    const finishReasons = mapFinishReason(stringValue(response.finishReason));

    // Interrupted-path detection: rollout record was finalized (completedAt
    // present) but the model never returned a finishReason — typically SIGTERM
    // / timeout mid-stream. Without intervention the synthesized LLM span
    // would lack gen_ai.response.finish_reasons, gen_ai.output.messages, and
    // gen_ai.usage.* (all gated on the response fields being present), failing
    // validate-trace MUST rules and the CLAUDE.md input/output.messages
    // non-empty high-priority invariant. Inject `interrupted` + placeholder
    // output + zero usage so the span satisfies the schema.
    const isInterrupted = !!completedAt && !stringValue(response.finishReason);
    const effectiveFinishReasons = finishReasons
      ?? (isInterrupted ? ['interrupted'] : undefined);
    const effectiveOutputMessages = outputMessages
      ?? (isInterrupted
        ? ([{
            role: 'assistant',
            parts: [{ type: 'text', content: '' }],
            finish_reason: 'interrupted',
          }] as unknown as JsonValue)
        : undefined);
    const effectiveInputTokens = finiteNumber(usage.inputTokens) ?? (isInterrupted ? 0 : undefined);
    const effectiveOutputTokens = finiteNumber(usage.outputTokens) ?? (isInterrupted ? 0 : undefined);
    const effectiveCacheRead = finiteNumber(usage.cacheReadTokens) ?? (isInterrupted ? 0 : undefined);
    const effectiveCacheWrite = finiteNumber(usage.cacheWriteTokens) ?? (isInterrupted ? 0 : undefined);
    const effectiveTotalTokens = finiteNumber(usage.totalTokens) ?? (isInterrupted ? 0 : undefined);

    // Pairing key: OTLP converter pairLlm matches by gen_ai.response.id on
    // both request and response. Mirror responseId onto the request so the
    // pair survives even if responseId arrives only on the response side.
    const pairingId = responseId || requestId;

    const requestEntry = buildAgentActivityEntry({
      timestamp: startMs,
      time_unix_nano: timestampToUnixNanos(startMs),
      'event.id': requestId || `${filePath}:req:${record.attempt ?? 1}`,
      'event.name': 'llm.request',
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.id': requestId,
      'gen_ai.response.id': pairingId,
      'gen_ai.agent.type': ClientType.ZcodeHook,
      'gen_ai.agent.name': 'ZCode',
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': stringValue(response.modelId) ?? modelId,
      ...(inputMessages ? { 'gen_ai.input.messages': inputMessages } : {}),
      ...(systemInstructions ? { 'gen_ai.system_instructions': systemInstructions } : {}),
      ...(toolDefinitions ? { 'gen_ai.tool.definitions': toolDefinitions } : {}),
      ...(maxTokens !== undefined ? { 'gen_ai.request.max_tokens': maxTokens } : {}),
      attributes: baseAttrs,
    });

    const responseEntry = buildAgentActivityEntry({
      timestamp: endMs,
      time_unix_nano: timestampToUnixNanos(endMs),
      'event.id': responseId || `${filePath}:resp:${record.attempt ?? 1}`,
      'event.name': 'llm.response',
      trace_id: traceId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.id': requestId,
      'gen_ai.response.id': pairingId,
      'gen_ai.agent.type': ClientType.ZcodeHook,
      'gen_ai.agent.name': 'ZCode',
      'gen_ai.request.model': modelId,
      'gen_ai.response.model': stringValue(response.modelId) ?? modelId,
      ...(effectiveFinishReasons ? { 'response.finish_reasons': effectiveFinishReasons } : {}),
      'gen_ai.usage.input_tokens': effectiveInputTokens,
      'gen_ai.usage.output_tokens': effectiveOutputTokens,
      'gen_ai.usage.cache_read.input_tokens': effectiveCacheRead,
      'gen_ai.usage.cache_creation.input_tokens': effectiveCacheWrite,
      'gen_ai.usage.total_tokens': effectiveTotalTokens,
      ...(effectiveOutputMessages ? { 'gen_ai.output.messages': effectiveOutputMessages } : {}),
      attributes: baseAttrs,
    });

    const out: AgentActivityEntry[] = [];
    if (requestEntry) out.push(requestEntry);
    if (responseEntry) out.push(responseEntry);
    return out.length > 0 ? out : null;
  }

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }

  /**
   * Allocate a stable step.id per (turnId, requestId). Same requestId within
   * a turn reuses the same stepIdx (so attempt>1 retries collapse into one
   * STEP). Persisted in extra.zcodeRollout.turnStepMap so it survives
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
    const prevExtra = prevState.extra?.zcodeRollout as
      | ZcodeRolloutFileState
      | undefined;

    const fileState: ZcodeRolloutFileState = prevExtra && typeof prevExtra === 'object'
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

    // Persist (shallow merge of extra replaces zcodeRollout wholesale, which
    // is what we want — we already mutated turnStepMap in place).
    this.stateStore.update(stateKey, {
      extra: { zcodeRollout: fileState },
    });

    return `${turnId}:s${stepIdx + 1}`;
  }
}

/**
 * Convert ZCode rollout request.messages to GenAI {role, parts} convention.
 * OTLP converter's parseInputMessages only reads `parts`, not `content`.
 *
 * ZCode message forms (per rollout fixture):
 *   - {role:'system', content:string}        → 跳过 (system 走 system_instructions)
 *   - {role:'user', content:string}          → parts:[{type:'text', text}]
 *   - {role:'user', content:[{type:'text', text:'...'}, ...]} → parts passthrough
 *   - {role:'assistant', content:string, toolCalls:[{id,name,input}]}
 *                                            → parts:[{type:'text', text?},
 *                                                     {type:'tool_call', id, name, input}]
 *   - {role:'tool', content:string, toolCallId, toolName, isError}
 *                                            → parts:[{type:'tool_result', id, content, isError?}]
 */
function toGenAiInputMessages(raw: unknown): JsonValue | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: JsonValue[] = [];
  for (const m of raw) {
    const rec = asRecord(m);
    const role = stringValue(rec.role);
    if (!role || role === 'system') continue;
    const parts = messageToParts(rec);
    if (parts.length === 0) continue;
    out.push({ role, parts } as unknown as JsonValue);
  }
  return out.length > 0 ? (out as unknown as JsonValue) : undefined;
}

function messageToParts(rec: Record<string, unknown>): unknown[] {
  const parts: unknown[] = [];
  const content = rec.content;

  // String content → text part (covers user/assistant/tool string payloads).
  // ARMS GenAI TextPart schema requires `content` (not `text`).
  if (typeof content === 'string' && content.length > 0) {
    parts.push({ type: 'text', content });
  } else if (Array.isArray(content)) {
    // Array content (OpenAI-style [{type:'text', text}, ...]) → canonicalize to content field
    for (const c of content) {
      const cRec = asRecord(c);
      const t = stringValue(cRec.type) ?? '';
      if (t === 'text' && cRec.text !== undefined) {
        parts.push({ type: 'text', content: cRec.text });
      } else if (t === 'text' && cRec.content !== undefined) {
        parts.push({ type: 'text', content: cRec.content });
      } else if (t === 'tool_use' || t === 'function_call') {
        parts.push({
          type: 'tool_call',
          id: stringValue(cRec.id) ?? '',
          name: stringValue(cRec.name) ?? '',
          input: cRec.input,
        });
      } else if (Object.keys(cRec).length > 0) {
        parts.push(cRec);
      }
    }
  }

  // Assistant toolCalls → tool_call parts (ZCode carries them alongside content)
  const toolCalls = rec.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const t = asRecord(tc);
      const id = stringValue(t.id) ?? '';
      const name = stringValue(t.name);
      if (name) {
        parts.push({ type: 'tool_call', id, name, input: t.input });
      }
    }
  }

  // Tool role message: toolCallId identifies which tool_call this result answers.
  // ARMS GenAI semconv VALID_PART_TYPES = ['text', 'tool_call', 'tool_call_response',
  // 'reasoning'] — 'tool_result' is not recognized and triggers schema WARN per LLM span.
  const toolCallId = stringValue(rec.toolCallId);
  if (toolCallId) {
    const resultPart: Record<string, unknown> = {
      type: 'tool_call_response',
      id: toolCallId,
      content,
    };
    if (rec.isError === true) resultPart.isError = true;
    if (rec.toolName) resultPart.toolName = rec.toolName;
    parts.unshift(resultPart as unknown);
  }

  return parts;
}

/**
 * Convert ZCode rollout response (text + toolCalls) to GenAI output.messages
 * with {role:'assistant', parts:[...]} and a finishReason per message.
 */
function toGenAiOutputMessages(response: Record<string, unknown>): JsonValue | undefined {
  const text = stringValue(response.text);
  const toolCalls = response.toolCalls;
  const finishReason = stringValue(response.finishReason) ?? 'stop';
  if (!text && !toolCalls) return undefined;
  const parts: unknown[] = [];
  if (text) parts.push({ type: 'text', content: text });
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const t = asRecord(tc);
      const id = stringValue(t.id);
      const name = stringValue(t.name);
      if (name) {
        parts.push({ type: 'tool_call', id: id ?? '', name, input: t.input });
      }
    }
  }
  if (parts.length === 0) return undefined;
  return [{ role: 'assistant', parts, finish_reason: mapFinishReasonSingle(finishReason) }] as unknown as JsonValue;
}

/**
 * Extract tool definitions from a ZCode rollout record. Tries multiple paths
 * to be robust against version differences in the rollout record structure.
 *
 * v3.2.3 fixture (researcher CP1): request.body.tools = [{name, description,
 * input_schema}, ...]
 * v0.15.0 production: tools may be at request.body.tools, request.tools, or
 * request.body.function_definitions — try all candidates, return the first
 * non-empty array.
 */
function extractToolDefinitions(record: Record<string, unknown>): JsonValue | undefined {
  const request = asRecord(record.request);
  const requestBody = asRecord(request.body);
  const candidates: unknown[] = [
    requestBody.tools,
    request.tools,
    requestBody.function_definitions,
    request.function_definitions,
    request.toolDefinitions,
    requestBody.toolDefinitions,
    record.tools,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      const normalized = normalizeToolDefinitions(c);
      if (normalized && Array.isArray(normalized) && normalized.length > 0) {
        return normalized as unknown as JsonValue;
      }
    }
  }
  return undefined;
}

/**
 * Normalize ZCode tool definitions to ARMS GenAI FunctionToolDefinition schema
 * (tests/schemas/gen-ai-tool-definitions.json):
 *   {type:'function', name, description?, parameters?}
 *
 * ZCode tools carry {name, description, input_schema} — input_schema is the
 * JSON Schema for parameters. Rename input_schema → parameters and inject
 * type='function' so the OTLP converter's getToolDefinitionsForSpan emits
 * gen_ai.tool.definitions on LLM spans.
 */
function normalizeToolDefinitions(tools: unknown): JsonValue | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: JsonValue[] = [];
  for (const t of tools) {
    const rec = asRecord(t);
    const name = stringValue(rec.name);
    if (!name) continue;
    const def: Record<string, unknown> = {
      type: stringValue(rec.type) ?? 'function',
      name,
    };
    const desc = stringValue(rec.description);
    if (desc) def.description = desc;
    // ZCode uses input_schema; ARMS GenAI uses parameters
    const params = rec.parameters ?? rec.input_schema ?? rec.inputSchema;
    if (params !== undefined && params !== null) def.parameters = params;
    out.push(def as unknown as JsonValue);
  }
  return out.length > 0 ? (out as unknown as JsonValue) : undefined;
}

function toGenAiSystemInstructions(raw: unknown): JsonValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    return [{ type: 'text', content: raw }] as unknown as JsonValue;
  }
  if (Array.isArray(raw)) {
    const parts: unknown[] = [];
    for (const s of raw) {
      const sRec = asRecord(s);
      const t = stringValue(sRec.type) ?? 'text';
      const text = stringValue(sRec.text) ?? stringValue(sRec.content);
      if (text !== undefined) {
        parts.push({ type: t, content: text });
      } else if (Object.keys(sRec).length > 0) {
        parts.push(sRec);
      }
    }
    return parts.length > 0 ? (parts as unknown as JsonValue) : undefined;
  }
  return toJsonValue(raw);
}

/**
 * Extract system instructions from request.messages:
 *   - All messages with role='system' (ZCode puts 2-3 system messages here)
 *   - <system-reminder>...</system-reminder> blocks embedded in user messages
 *     (ZCode injects context like currentDate, available skills, etc.)
 *
 * Returns GenAI parts array [{type:'text', content}].
 */
function extractSystemFromMessages(raw: unknown): JsonValue | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts: unknown[] = [];
  for (const m of raw) {
    const rec = asRecord(m);
    const role = stringValue(rec.role);
    if (role === 'system') {
      const content = rec.content;
      if (typeof content === 'string' && content.length > 0) {
        parts.push({ type: 'text', content });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const cRec = asRecord(c);
          const text = stringValue(cRec.text) ?? stringValue(cRec.content);
          if (text !== undefined) parts.push({ type: 'text', content: text });
        }
      }
    } else if (role === 'user') {
      const content = rec.content;
      if (typeof content === 'string') {
        for (const block of extractSystemReminderBlocks(content)) {
          parts.push({ type: 'text', content: block });
        }
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const cRec = asRecord(c);
          const text = stringValue(cRec.text) ?? stringValue(cRec.content);
          if (text !== undefined) {
            for (const block of extractSystemReminderBlocks(text)) {
              parts.push({ type: 'text', content: block });
            }
          }
        }
      }
    }
  }
  return parts.length > 0 ? (parts as unknown as JsonValue) : undefined;
}

const SYSTEM_REMINDER_RE = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

function extractSystemReminderBlocks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SYSTEM_REMINDER_RE.lastIndex = 0;
  while ((m = SYSTEM_REMINDER_RE.exec(text)) !== null) {
    const block = m[1].trim();
    if (block.length > 0) out.push(block);
  }
  return out;
}

function mergeSystemInstructions(
  a: JsonValue | undefined,
  b: JsonValue | undefined,
): JsonValue | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  const aArr = Array.isArray(a) ? a : [a];
  const bArr = Array.isArray(b) ? b : [b];
  return [...aArr, ...bArr] as unknown as JsonValue;
}

function mapFinishReason(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  // ZCode uses 'tool-calls' / 'stop' / 'length' / 'content-filter'.
  // Normalize to OTel GenAI convention ('tool_calls' instead of 'tool-calls').
  const normalized = raw.replace(/-/g, '_');
  return [normalized];
}

/**
 * Single-value variant for per-message finish_reason inside gen_ai.output.messages.
 * ARMS GenAI FinishReason enum rejects hyphenated forms like 'tool-calls';
 * normalize to underscore form ('tool_calls', 'content_filter', etc.).
 */
function mapFinishReasonSingle(raw: string | undefined): string {
  if (!raw) return 'stop';
  return raw.replace(/-/g, '_');
}

/**
 * W3C trace_id 必须是 32-hex 不带连字符。ZCode rollout 记录的 traceId 是
 * UUID (8-4-4-4-12 带连字符)，直接传 OTLP 转换器会被拒并重新分配 traceId，
 * 造成 hook 侧事件与 rollout 侧事件归不到同一 trace。
 */
function normalizeTraceId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 32 ? hex : undefined;
}

function stringValue(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
}

function toJsonValue(v: unknown): JsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v) || typeof v === 'object') {
    try { return JSON.parse(JSON.stringify(v)) as JsonValue; } catch { return undefined; }
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v as JsonValue;
  }
  return undefined;
}

function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath);
  const m = base.match(/^model-io-sess_(.+)\.jsonl$/);
  return m ? m[1] : base;
}

function isoToMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function collectFiles(dir: string, pattern: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const re = globToRegex(pattern);
  for (const ent of entries) {
    if (ent.isFile() && re.test(ent.name)) {
      out.push(path.join(dir, ent.name));
    }
  }
}

function globToRegex(pattern: string): RegExp {
  // Translate simple glob (* and ?) to RegExp. Sufficient for
  // `model-io-sess_*.jsonl`-style patterns; not a full glob impl.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if ('.+^$(){}[]|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
