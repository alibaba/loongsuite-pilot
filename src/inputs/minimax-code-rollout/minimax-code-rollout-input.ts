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
const DEFAULT_SESSION_DIR_WINDOWS = '%APPDATA%/MiniMax/rollout';
const DEFAULT_FILE_PATTERN = 'model-io-sess_*.jsonl';

export interface MinimaxCodeRolloutInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  /**
   * Round 8 fix (PR #233, addressing fangxiu-wf review): the official
   * MiniMax Code 3.0.60 Windows desktop client writes its native rollout
   * to `%APPDATA%\MiniMax\rollout\`, not the POSIX `~/.minimax-code/rollout/`.
   * Use this override on Windows; falls back to `sessionDir` if absent.
   */
  sessionDirWindows?: string;
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
 *   - interrupted 路径注入 (Round 2) — REVERTED in Round 8: 之前会注入
 *     finish_reasons=['interrupted'] + 占位 output.messages + 0 usage,
 *     但这跟真实 SIGTERM/长度上限截断/拒绝回答无法区分, 制造了假 GenAI
 *     语义。Round 8 改为 source-faithful: 缺字段就不 emit, 单独 emit 一个
 *     event.name='diagnostic' 的事件来标记"response 结构不完整" (见下方
 *     Round 8 段落)。
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
 * Round 6 (PR #233): buildOutputMessages initially forced a placeholder
 *   assistant message on every empty-text / empty-toolCalls response so
 *   validate-trace would not flag it as ERROR. This was superseded by
 *   Round 8 — see below.
 *
 * Round 8 (PR #233): source-faithful output. The previous Round 2/6
 *   behavior synthesized finish_reasons, output.messages, and usage
 *   fields whenever the response was structurally incomplete, which
 *   fabricated GenAI semantics (a refusal and a SIGTERM became
 *   indistinguishable). The new behavior: buildOutputMessages returns
 *   JsonValue | undefined and is omitted from the entry when the source
 *   has no recoverable content; resolveFinishReasons returns
 *   string[] | undefined (no ['stop'] default); optionalUsageField only
 *   emits a field when the source actually has a numeric value. A
 *   separate event.name='diagnostic' entry (carrying
 *   gen_ai.diagnostic.{reason, missing_fields, ...}) is appended when
 *   the response is structurally incomplete (no text + no toolCalls +
 *   no finishReason), so operators have a single grep target
 *   (event.name='diagnostic' AND gen_ai.diagnostic.reason) for
 *   follow-up. validate-trace WILL now flag missing output.messages /
 *   finish_reasons as ERROR by design — that is the correct signal
 *   that the source data is incomplete. See fangxiu-wf review
 *   finding #4.
 *
 * Round 9 (PR #233): diagnostic event now carries the same correlation
 *   keys (gen_ai.session.id / turn.id / step.id / response.id / trace_id)
 *   as the paired llm.request / llm.response entries. Previously the
 *   diagnostic read sessionId / session_id from the nested `response`
 *   object, but in the MiniMax Code rollout schema these live at the
 *   TOP-LEVEL record, so every diagnostic came out with an empty
 *   gen_ai.session.id and lost correlation. buildIncompleteResponseDiagnostic
 *   now accepts sharedFields from processSessionLine scope and copies
 *   them verbatim.
 *
 * Future work (见 PR description "Future Work"):
 *   - synthesizeOrphanToolRecords flusher enhancement, deferred
 *     until real E2E traces show the orphan case.
 */
export class MinimaxCodeRolloutInput extends BaseSessionInput {
  readonly id = 'minimax-code-rollout';
  readonly agentType = ClientType.MiniMaxCode;

  constructor(opts: MinimaxCodeRolloutInputOptions) {
    // Round 12 fix (PR #233, copilot suppressed comment): the previous
    // logic only honored `opts.sessionDirWindows` on Windows; if the
    // caller did NOT pass it, the constructor fell back to
    // `opts.sessionDir ?? DEFAULT_SESSION_DIR` (which is the POSIX
    // path `~/.minimax-code/rollout`). The Orchestrator calls
    // `new MinimaxCodeRolloutInput({ stateStore })` with no Windows
    // override, so on Windows the input would have tried to read
    // `~/.minimax-code/rollout` (which does not exist on the official
    // MiniMax Code 3.0.60 Windows desktop client) and missed all
    // rollout records.
    //
    // Round 14 fix (PR #233, copilot suppressed comment): the Round 12
    // fix overcorrected — it gave `sessionDirWindows` absolute
    // priority on Windows and IGNORED `opts.sessionDir`, which
    // contradicts the option comment ("falls back to `sessionDir`
    // if absent"). A test or special-purpose caller that sets
    // `sessionDir` on Windows (e.g. a unit test using TMPDIR, or
    // a custom data dir) would be silently overridden. Now the
    // precedence is consistent on both platforms:
    //   1. opts.sessionDirWindows (Windows-specific override, wins)
    //   2. opts.sessionDir (cross-platform override, second)
    //   3. DEFAULT_SESSION_DIR_WINDOWS on win32, else DEFAULT_SESSION_DIR
    // The only behavior change from Round 12 is that `opts.sessionDir`
    // once again overrides the Windows default when no
    // `sessionDirWindows` is provided. The Round 12 Orchestrator
    // scenario (no overrides at all) still gets
    // DEFAULT_SESSION_DIR_WINDOWS on Windows, which was the
    // original fix.
    super({
      stateStore: opts.stateStore,
      sessionDir: resolveHome(
        opts.sessionDirWindows
          ?? opts.sessionDir
          ?? (process.platform === 'win32'
            ? DEFAULT_SESSION_DIR_WINDOWS
            : DEFAULT_SESSION_DIR),
      ),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.MINIMAX_CODE_ROLLOUT_POLL_INTERVAL) || 30_000),
    });
  }

  static getWatchPaths(): string[] {
    return [resolveHome(
      process.platform === 'win32'
        ? DEFAULT_SESSION_DIR_WINDOWS
        : DEFAULT_SESSION_DIR,
    )];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(
      process.platform === 'win32'
        ? DEFAULT_SESSION_DIR_WINDOWS
        : DEFAULT_SESSION_DIR,
    ));
  }

  protected override async onStart(): Promise<void> {
    // Baseline new files only; resume files with existing checkpoint state.
    //
    // Round 8 fix (PR #233, addressing fangxiu-wf review): the previous
    // implementation unconditionally set offset = stat.size and reset
    // turnStepMap for every existing file, which silently discarded any
    // records appended while Pilot was stopped (Pilot restart would not
    // see them). The new logic:
    //
    //   - Files with no prior state (newly observed since last start):
    //     set offset = stat.size, init turnStepMap = {}. This is the
    //     "fresh install" path — we don't replay historical rollout on
    //     first install.
    //   - Files with prior state (offset > 0 OR extra.minimaxCodeRollout
    //     already initialized): leave offset and turnStepMap alone.
    //     processFile will resume from the saved offset on the next
    //     collect() cycle, recovering any records appended while Pilot
    //     was stopped. If the file rotated (inode change), the pre-pass
    //     in collect() clears turnStepMap and resets offset to 0 before
    //     delegating to super.collect(), so rotation is still detected.
    //
    // The inode is initialized for new files so the pre-pass in collect()
    // doesn't false-trigger rotation clearing on the first poll.
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        const prevState = this.stateStore.get(stateKey);
        const prevOffset = this.stateStore.getOffset(stateKey);
        const prevRollout = prevState.extra?.minimaxCodeRollout as
          | MinimaxCodeRolloutFileState
          | undefined;
        const hasCheckpoint =
          prevOffset > 0 || (prevRollout !== undefined && prevRollout.inode !== 0);
        if (hasCheckpoint) {
          // Existing file with persisted state — resume from saved offset
          // on next collect(). Do not touch offset or turnStepMap.
          continue;
        }
        // New file (or first sight after a state wipe): baseline to EOF
        // and init turnStepMap so the pre-pass doesn't false-trigger
        // rotation clearing on the first poll.
        //
        // Round 18 fix (PR #233, copilot suppressed comment): the
        // previous implementation only set
        // `extra.minimaxCodeRollout.inode` (the rollout-specific
        // inode used by the input's own rotation pre-pass below).
        // BaseSessionInput.processFile, however, reads the
        // TOP-LEVEL `extra.inode` field for its own rotation
        // detection (line 55 of base-session-input.ts). Without
        // setting `extra.inode` here, the first collect() after
        // onStart() sees `prevInode === undefined`, so the base
        // class's `if (prevInode !== undefined && prevInode !==
        // stat.ino)` rotation guard is bypassed. If the file
        // rotated between onStart() and the first collect(), the
        // base class would NOT reset offset, and would read from
        // the old offset (potentially past the start of the new
        // file → data loss). Setting both inode fields keeps the
        // two rotation guards (input-level pre-pass + base-class
        // file-level check) consistent.
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, {
          extra: {
            inode: (stat as any).ino,
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
    const toolDefinitions = this.extractToolDefinitions(request);

    // Source-faithful output (Round 8 fix, PR #233, addressing fangxiu-wf
    // review finding #4): the previous Round 2/6 implementation
    // synthesized `interrupted` finish_reasons + a placeholder output
    // message + 0-token usage whenever the response was structurally
    // incomplete (completedAt present but no finishReason / text /
    // toolCalls). This "fixed" validate-trace's missing-output check
    // but fabricated GenAI semantics: an empty refusal, a length-cap
    // termination, or a schema drift all got reported as "interrupted"
    // with synthesized content, indistinguishable from a real SIGTERM.
    //
    // The new behavior:
    //   - output.messages is built source-faithfully from response.text
    //     and response.toolCalls. If both are missing, output.messages
    //     is omitted from the entry (no placeholder, no inference).
    //   - finish_reasons is read from response.finishReason / finish_reason
    //     when present, otherwise omitted.
    //   - usage tokens are read from response.usage.* when present,
    //     otherwise omitted.
    //   - A separate `event.name: 'diagnostic'` entry is appended when
    //     the response is structurally incomplete, so downstream tooling
    //     can still surface the issue without the entry itself carrying
    //     fabricated values.
    //
    // validate-trace WILL now flag these entries as ERROR (by design —
    // incomplete source data is incomplete source data). The diagnostic
    // entry gives operators a single grep target for follow-up
    // (event.name = "diagnostic" AND gen_ai.diagnostic.reason).
    const outputMessages = this.buildOutputMessages(response);
    const finishReasons = this.resolveFinishReasons(response);

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

    // Round 9 fix (PR #233, copilot suppressed comment): compute the
    // diagnostic BEFORE building sharedFields, but pass sharedFields
    // (session/turn/step/response id + trace_id) into it so the
    // diagnostic event can be correlated with the paired llm.request /
    // llm.response. The previous implementation read
    // response.sessionId / response.session_id, but in the MiniMax Code
    // rollout schema sessionId lives at the top-level record (not in
    // the nested `response` object), so the diagnostic came out with
    // an empty `gen_ai.session.id` and lost correlation.
    const diagnostic = this.buildIncompleteResponseDiagnostic({
      response,
      completedAt,
      outputMessages,
      finishReasons,
      sharedFields: {
        sessionId,
        turnId,
        stepId,
        responseId,
        traceId,
      },
    });

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
      // Source-faithful finish_reasons: only present when the response
      // declares a finishReason. Round 8 fix (PR #233) — see the comment
      // block above for rationale. validate-trace will flag missing
      // finish_reasons as ERROR, which is the correct signal that
      // the source data is incomplete.
      ...(finishReasons ? { 'gen_ai.response.finish_reasons': finishReasons } : {}),
      // Source-faithful usage: only set when the response actually has
      // numeric usage fields. Do NOT default to 0 (that synthesized
      // "0 tokens used" and masked incomplete source data — see
      // fangxiu-wf review finding #4).
      ...this.optionalUsageField('gen_ai.usage.input_tokens',
          (response as any).usage?.inputTokens ?? (response as any).usage?.input_tokens),
      ...this.optionalUsageField('gen_ai.usage.output_tokens',
          (response as any).usage?.outputTokens ?? (response as any).usage?.output_tokens),
      ...this.optionalUsageField('gen_ai.usage.cache_read.input_tokens',
          (response as any).usage?.cacheReadTokens ?? (response as any).usage?.cache_read?.input_tokens),
      ...this.optionalUsageField('gen_ai.usage.cache_creation.input_tokens',
          (response as any).usage?.cacheCreationTokens ?? (response as any).usage?.cache_creation?.input_tokens),
      // Source-faithful output.messages: only set when text or toolCalls
      // produced actual content. Missing when both are empty, so downstream
      // can distinguish "truncated refusal" from "synthesized empty".
      ...(outputMessages ? { 'gen_ai.output.messages': outputMessages } : {}),
    };

    const requestEntry = buildAgentActivityEntry(requestRecord as any);
    const responseEntry = buildAgentActivityEntry(responseRecord as any);
    const entries: AgentActivityEntry[] = [requestEntry, responseEntry];
    if (diagnostic) entries.push(diagnostic);
    return entries;
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

  private detectIncompleteResponse(
    response: Record<string, unknown>,
  ): { isIncomplete: boolean; missingFields: string[] } {
    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #4):
    // we DO NOT classify incomplete responses as "interrupted" anymore.
    // A real SIGTERM / Ctrl+C case is best detected by the host hook
    // (see assets/hooks/minimax-code-hook-processor.mjs cmdStop),
    // not by guessing from missing response fields. This helper now
    // only reports WHICH fields are missing, so the diagnostic event
    // can carry an accurate reason code.
    //
    // Threshold: a response is "incomplete" if BOTH the finishReason
    // AND the content-bearing fields (text + toolCalls) are missing.
    // The original Round 2/6 SIGTERM heuristic also required
    // completedAt to be present, but Round 8 dropped that requirement
    // because the strict content-based threshold is enough on its own
    // to avoid the false-positive "interrupted" classification (a
    // normal pure-chat response with no tool calls and no usage would
    // also have satisfied the old heuristic, since completedAt is
    // usually present on a successful response). The content-based
    // threshold generalizes: a response missing finishReason + text +
    // toolCalls is genuinely broken regardless of whether completedAt
    // is set; a response missing only usage or only toolCalls is fine
    // and we stay quiet.
    const missing: string[] = [];
    const finishReason = (response['finishReason'] as string | undefined)
      ?? (response['finish_reason'] as string | undefined);
    if (typeof finishReason !== 'string' || finishReason.length === 0) {
      missing.push('finishReason');
    }
    const text = (response['text'] as string | undefined) ?? '';
    const hasText = typeof text === 'string' && text.length > 0;
    if (!hasText) {
      missing.push('text');
    }
    const toolCalls = (response['toolCalls'] as unknown[]) ?? (response['tool_calls'] as unknown[]) ?? [];
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    if (!hasToolCalls) {
      missing.push('toolCalls');
    }
    const usage = (response as any).usage;
    if (!usage || typeof usage !== 'object') {
      missing.push('usage');
    }
    // Strict: missing finishReason AND missing (text + toolCalls).
    // This is the genuine SIGTERM-like pattern. A normal pure-chat
    // response has text + finishReason but no toolCalls/usage, and
    // should NOT fire a diagnostic.
    const isIncomplete = !hasText && !hasToolCalls && missing.includes('finishReason');
    return { isIncomplete, missingFields: missing };
  }

  private buildIncompleteResponseDiagnostic(opts: {
    response: Record<string, unknown>;
    completedAt: string | number | undefined;
    outputMessages: JsonValue | undefined;
    finishReasons: string[] | undefined;
    sharedFields: {
      sessionId: string;
      turnId: string | undefined;
      stepId: string | undefined;
      responseId: string;
      traceId: string | undefined;
    };
  }): AgentActivityEntry | null {
    const { response, completedAt, outputMessages, finishReasons, sharedFields } = opts;
    // Round 13 fix (PR #233, copilot suppressed comment): the previous
    // detectIncompleteResponse accepted a completedAt parameter but
    // never used it (Round 8 dropped the completedAt-based heuristic in
    // favor of a strict content-based threshold — see the comment in
    // detectIncompleteResponse for the rationale). The unused parameter
    // is now removed to reduce cognitive overhead and prevent future
    // callers from assuming completedAt affects the classification.
    const { isIncomplete, missingFields } = this.detectIncompleteResponse(
      response,
    );
    if (!isIncomplete) return null;

    // The diagnostic event is a separate AgentActivityEntry so consumers
    // can surface "this response was incomplete" without the llm.response
    // entry itself carrying fabricated values. The event.name distinguishes
    // it from normal llm.request / llm.response, and gen_ai.diagnostic.*
    // attributes carry the reason + missing-field list.
    //
    // Round 9 fix (PR #233, copilot suppressed comment): the previous
    // implementation read session/turn/step/trace_id from
    // `response.sessionId` / `response.session_id`, but in the MiniMax
    // Code rollout schema these fields live at the TOP-LEVEL record
    // (sessionId / turnId on the record; responseId / requestId on the
    // record or nested request/response), not on the nested `response`
    // object. As a result the diagnostic event came out with an empty
    // `gen_ai.session.id` and lost correlation with the paired
    // llm.response entry. Now we receive the already-computed
    // sharedFields from the outer processSessionLine scope and copy
    // them verbatim so the diagnostic and the response entries share
    // the exact same correlation key.
    const diagnosticRecord: Record<string, unknown> = {
      'event.name': 'diagnostic',
      time_unix_nano: timestampToUnixNanos(completedAt) ?? timestampToUnixNanos(Date.now()) ?? '0',
      'gen_ai.agent.type': ClientType.MiniMaxCode,
      'gen_ai.agent.name': 'MiniMax Code',
      'gen_ai.session.id': sharedFields.sessionId,
      ...(sharedFields.turnId !== undefined ? { 'gen_ai.turn.id': sharedFields.turnId } : {}),
      ...(sharedFields.stepId !== undefined ? { 'gen_ai.step.id': sharedFields.stepId } : {}),
      'gen_ai.response.id': sharedFields.responseId,
      ...(sharedFields.traceId ? { trace_id: sharedFields.traceId } : {}),
      'gen_ai.diagnostic.reason': 'incomplete_response',
      'gen_ai.diagnostic.missing_fields': missingFields,
      'gen_ai.diagnostic.completed_at_present': completedAt !== undefined,
      // Flag the source-faithful outcome of the corresponding llm.response
      // entry so operators can correlate diagnostic -> llm.response without
      // parsing the JSONL.
      'gen_ai.diagnostic.llm_response_has_output_messages': outputMessages !== undefined,
      'gen_ai.diagnostic.llm_response_has_finish_reasons': finishReasons !== undefined,
    };
    return buildAgentActivityEntry(diagnosticRecord as any);
  }

  private optionalUsageField(field: string, raw: unknown): Record<string, unknown> {
    const n = this.coerceNumber(raw);
    return n !== undefined ? { [field]: n } : {};
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
      ?? (response['finish_reason'] as string | undefined);

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
    // Source-faithful output: emit nothing when the response has no
    // recoverable content. The previous Round 6 behavior synthesized a
    // placeholder assistant message so validate-trace's
    // semantic.llm_has_input_output rule would not ERROR — but that
    // fabrication hid incomplete source data (refusals, length-cap
    // terminations, schema drift) behind a fake "stop" finish_reason.
    //
    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #4):
    // omit the entry when nothing is recoverable, and let the
    // separate `event.name: 'diagnostic'` entry (built by
    // buildIncompleteResponseDiagnostic) surface the issue.
    if (parts.length === 0) return undefined;

    const message: Record<string, JsonValue | undefined> = { role: 'assistant', parts };
    if (typeof finish === 'string' && finish.length > 0) {
      message.finish_reason = finish;
    }
    return [message as unknown as JsonValue];
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
      // Round 17 fix (PR #233, copilot suppressed comment): the previous
      // implementation emitted `{ type: 'text', content: toJsonValue(content) }`
      // for non-string non-array object content. validate-trace's schema
      // requires `TextPart.content` to be a string (scripts/validate-trace.mjs
      // `requireString` check), so passing an object would produce
      // `schema.input_messages` errors if MiniMax Code ever logs
      // object-shaped message content. Stringify the object to a JSON
      // string so the data is preserved in a string field that downstream
      // consumers can re-parse if needed. The trace-validation rules
      // explicitly allow this (a stringified JSON is still a string).
      return [{ type: 'text', content: JSON.stringify(content) } as unknown as JsonValue];
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

  private resolveFinishReasons(response: Record<string, unknown>): string[] | undefined {
    // Source-faithful: only return a finish_reasons array when the source
    // actually declares one. Round 8 fix (PR #233, addressing fangxiu-wf
    // review finding #4): the previous implementation defaulted to
    // `['stop']` when no finishReason was present, which fabricated a
    // termination signal for incomplete source data.
    const raw = (response['finishReason'] as string | undefined)
      ?? (response['finish_reason'] as string | undefined);
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
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
