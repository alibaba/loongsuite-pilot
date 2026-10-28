import { createHash, randomBytes } from 'node:crypto';
import type { JsonValue } from '../../types/index.js';
import { codexContentFromSource, createCodexTurnReducer, sessionIdFromTranscriptPath, type CodexRetainedContentKind,
  type CodexTurnReducer, type CodexTurnReducerOptions } from './codex-transcript-extractor.js';
import { CodexGuardedJsonlReadTask } from './codex-transcript-reader.js';
import type { CodexPartialTurnExtraction, CodexTranscriptContentAnchor, CodexTranscriptMeta,
  CodexTranscriptSourceRecord, CodexTranscriptSourceRef, CodexTranscriptSourceSnapshot } from './codex-transcript-types.js';

const INLINE_CONTENT_BYTES = 64 * 1024;
const AUDIT_TOOL_NAMES = new Set(['spawn_agent', 'followup_task', 'send_input', 'wait', 'wait_agent', 'wait_threads']);
interface ContentSlot { ref: CodexTranscriptSourceRef; kind: CodexRetainedContentKind; role?: string }
interface AuditSource { source?: CodexTranscriptSourceRecord; ref?: CodexTranscriptSourceRef }
export type CodexContentReader = (ref: CodexTranscriptSourceRef) => Promise<CodexTranscriptSourceRecord>;

/** 派生状态只在内存中续接；正文引用永远指向原始完整 JSONL 记录。 */
export class CodexTranscriptContinuation {
  readonly reducer: CodexTurnReducer;
  readonly guard: CodexGuardedJsonlReadTask;
  private readonly slots = new Map<string, ContentSlot>();
  private readonly audits: AuditSource[] = [];
  private readonly auditCallIds = new Set<string>();
  private readonly nonce = randomBytes(12).toString('hex');
  private readonly markerPattern: RegExp;
  private memoryBytes = 1024;
  private offset: number;
  private semanticStart: number;

  constructor(readonly filePath: string, readonly identity: string, readonly sourceGeneration: number,
    snapshot: CodexTranscriptSourceSnapshot, startOffset: number, meta: CodexTranscriptMeta | null,
    turnId: string, opts: CodexTurnReducerOptions, anchors: CodexTranscriptContentAnchor[]) {
    this.offset = this.semanticStart = startOffset;
    this.markerPattern = new RegExp(`\\u0000codex:${this.nonce}:([a-f0-9]{64})\\u0000`, 'g');
    this.guard = new CodexGuardedJsonlReadTask(filePath, snapshot, sourceGeneration, 'recovery', startOffset,
      undefined, anchors, snapshot.size);
    this.reducer = createCodexTurnReducer(meta, sessionIdFromTranscriptPath(filePath), turnId, { ...opts, blobToUri: undefined,
      retainText: (value, source, kind) => this.retain(value, source, kind) as string | undefined,
      retainValue: (value, source, kind, role) => this.retain(value, source, kind, role),
    });
  }

  get parsedOffset(): number { return this.offset; }
  get startOffset(): number { return this.semanticStart; }
  get estimatedBytes(): number { return this.memoryBytes; }
  get parsedRecords(): number { return this.reducer.parsedRecords; }

  feed(sources: CodexTranscriptSourceRecord[], endOffset: number): void {
    if (endOffset < this.offset) throw new RangeError('continuation cannot rewind');
    for (const source of sources) {
      if (source.startOffset < this.offset) continue;
      this.reducer.feed([source]);
      this.memoryBytes += 384;
      const payload = object(source.record.payload);
      const type = payload?.type;
      const name = typeof payload?.name === 'string' ? payload.name.replace(/^.*[./]/, '') : '';
      const callId = typeof payload?.call_id === 'string' ? payload.call_id : '';
      if (type === 'function_call' && AUDIT_TOOL_NAMES.has(name)) this.auditCallIds.add(callId);
      // 审计依赖保留原输入及调用/结果事实；padding、普通模型正文和 token 不复制进数组。
      const audit = source.record.type === 'turn_context'
        || (source.record.type === 'event_msg' && ['task_started', 'user_message', 'sub_agent_activity', 'task_complete', 'turn_aborted'].includes(String(type)))
        || (source.record.type === 'response_item' && (type === 'agent_message'
          || type === 'message' && payload?.role !== 'assistant' || this.auditCallIds.has(callId)));
      if (audit) {
        const ref = this.refFor(source);
        if (ref && source.endOffset - source.startOffset > INLINE_CONTENT_BYTES) {
          this.audits.push({ ref }); this.memoryBytes += 256;
        } else {
          this.audits.push({ source }); this.memoryBytes += 256 + 3 * (source.endOffset - source.startOffset);
        }
      }
      this.offset = source.endOffset;
    }
    this.offset = endOffset;
  }

  snapshot(): CodexPartialTurnExtraction | null { return this.reducer.snapshot(); }

  /** 所有必需原始范围先校验完整，再执行多模态转换和候选正文替换。 */
  async materialize(extraction: CodexPartialTurnExtraction, read: CodexContentReader,
    opts: CodexTurnReducerOptions, terminal = false): Promise<{ extraction: CodexPartialTurnExtraction; items: CodexTranscriptSourceRecord[] }> {
    // 全部正文都内联时仍隔离可变候选，但不逐个字段执行 ref 正则匹配和替换。
    if (this.slots.size === 0 && this.audits.every(audit => audit.source !== undefined)) {
      return { extraction: structuredClone(extraction), items: this.audits.map(audit => audit.source!) };
    }
    const required = new Map<string, CodexTranscriptSourceRef>();
    const referenced = new Set<string>();
    const discover = (value: unknown): void => {
      if (typeof value === 'string') {
        this.markerPattern.lastIndex = 0;
        for (const match of value.matchAll(this.markerPattern)) {
          const slot = this.slots.get(match[1]!);
          if (!slot) throw new Error('missing retained Codex content');
          referenced.add(match[1]!); required.set(refKey(slot.ref), slot.ref);
        }
      } else if (Array.isArray(value)) value.forEach(discover);
      else if (object(value)) Object.values(value as Record<string, unknown>).forEach(discover);
    };
    const committed = terminal ? extraction.turn.steps.length : extraction.committedStepCount;
    discover({ ...extraction.turn, steps: extraction.turn.steps.slice(0, committed) });
    for (const step of extraction.turn.steps.slice(committed)) {
      for (const tool of step.tools) if (AUDIT_TOOL_NAMES.has(tool.name.replace(/^.*[./]/, ''))) discover(tool);
    }
    for (const audit of this.audits) if (audit.ref) required.set(refKey(audit.ref), audit.ref);
    const hydrated = new Map<string, CodexTranscriptSourceRecord>();
    for (const [key, ref] of required) hydrated.set(key, await read(ref));
    const values = new Map<string, JsonValue | null | undefined>();
    for (const key of referenced) {
      const slot = this.slots.get(key)!;
      values.set(key, codexContentFromSource(hydrated.get(refKey(slot.ref))!, slot.kind, opts, slot.role));
    }
    const restore = (value: unknown): unknown => {
      if (typeof value === 'string') {
        this.markerPattern.lastIndex = 0;
        const matches = [...value.matchAll(this.markerPattern)];
        if (matches.length === 1 && matches[0]![0] === value) {
          const key = matches[0]![1]!;
          return values.has(key) ? values.get(key) : value;
        }
        this.markerPattern.lastIndex = 0;
        return value.replace(this.markerPattern, (_marker, key: string) => {
          if (!values.has(key)) return _marker;
          const content = values.get(key);
          if (typeof content !== 'string') throw new Error('Codex text slot is not text');
          return content;
        });
      }
      if (Array.isArray(value)) return value.map(restore).filter(item => item !== undefined);
      const record = object(value);
      if (!record) return value;
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, restore(item)])
        .filter(([, item]) => item !== undefined));
    };
    const turn = restore(extraction.turn) as CodexPartialTurnExtraction['turn'];
    const items = this.audits.map(audit => audit.source ?? hydrated.get(refKey(audit.ref!))!);
    return { extraction: { ...extraction, turn }, items };
  }

  commit(stepCount: number, endOffset: number): void {
    this.reducer.commit(stepCount, endOffset);
    this.semanticStart = endOffset;
    for (let index = this.audits.length - 1; index >= 0; index--) {
      const end = this.audits[index]!.source?.endOffset ?? this.audits[index]!.ref!.endOffset;
      if (end <= endOffset) this.audits.splice(index, 1);
    }
    // 回收已提交 refs；活动 envelope 必须参与可达性判断，不能只检查部分 snapshot。
    const live = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === 'string') {
        this.markerPattern.lastIndex = 0;
        for (const match of value.matchAll(this.markerPattern)) live.add(match[1]!);
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (object(value)) Object.values(value as Record<string, unknown>).forEach(visit);
    };
    const state = this.reducer.retainedState();
    visit(state);
    for (const key of this.slots.keys()) if (!live.has(key)) this.slots.delete(key);
    this.memoryBytes = 1024 + JSON.stringify(state).length * 2 + this.slots.size * 512
      + this.auditCallIds.size * 128 + this.audits.reduce((sum, audit) => sum + (audit.ref ? 256
        : 256 + 3 * (audit.source!.endOffset - audit.source!.startOffset)), 0);
  }

  private refFor(source: CodexTranscriptSourceRecord): CodexTranscriptSourceRef | undefined {
    if (!source.sha256) return undefined;
    return { inode: this.guard.serialize().snapshot.inode, sourceGeneration: this.sourceGeneration,
      startOffset: source.startOffset, endOffset: source.endOffset, sha256: source.sha256 };
  }

  private retain(value: JsonValue | null | undefined, source: CodexTranscriptSourceRecord,
    kind: CodexRetainedContentKind, role?: string): JsonValue | null | undefined {
    const ref = this.refFor(source);
    const payload = object(source.record.payload);
    const parts = payload?.content ?? payload?.output;
    const images = (kind === 'input-message' || kind === 'tool-output') && Array.isArray(parts)
      && parts.some(part => object(part)?.type === 'input_image');
    const encoded = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    if (!ref || (!images && Buffer.byteLength(encoded) <= INLINE_CONTENT_BYTES)) {
      this.memoryBytes += encoded.length * 2;
      return value;
    }
    const text = kind === 'prompt' || kind === 'reasoning' || kind === 'final';
    const key = createHash('sha256').update(text ? encoded : `${ref.startOffset}:${kind}:${role ?? ''}:${encoded}`).digest('hex');
    if (!this.slots.has(key)) { this.slots.set(key, { ref, kind, ...(role ? { role } : {}) }); this.memoryBytes += 512; }
    return `\u0000codex:${this.nonce}:${key}\u0000`;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function refKey(ref: CodexTranscriptSourceRef): string { return `${ref.startOffset}:${ref.endOffset}:${ref.sha256}`; }
