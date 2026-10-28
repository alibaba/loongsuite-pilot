import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { CodexReadReason } from '../base/input-runtime-metrics.js';
import type { CodexFileWorkSlice } from './codex-transcript-work-scheduler.js';
import type {
  CodexJsonlProbeState, CodexRecordReadState, CodexTranscriptContentAnchor, CodexTranscriptSourceRef,
  CodexTranscriptSourceRecord, CodexTranscriptSourceSnapshot,
} from './codex-transcript-types.js';

export class CodexSourceConflictError extends Error {
  constructor(readonly reason: 'identity' | 'truncated' | 'fingerprint' | 'short-read') {
    super(`Codex transcript source conflict: ${reason}`);
    this.name = 'CodexSourceConflictError';
  }
}

export function codexSourceSnapshot(stat: {
  ino: number | bigint; size: number | bigint;
  mtimeMs: number | bigint; ctimeMs: number | bigint;
}): CodexTranscriptSourceSnapshot {
  return { inode: Number(stat.ino), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs) };
}

function assertOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid Codex source offset');
}

function assertRange(startOffset: number, endOffset: number): void {
  assertOffset(startOffset);
  assertOffset(endOffset);
  if (endOffset < startOffset) throw new RangeError('inverted Codex source range');
}

export function codexContentAnchor(bytes: Buffer, startOffset: number): CodexTranscriptContentAnchor {
  assertOffset(startOffset);
  const endOffset = startOffset + bytes.length;
  assertOffset(endOffset);
  return { startOffset, endOffset, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function codexSourceRef(
  bytes: Buffer, startOffset: number, inode: number, sourceGeneration: number,
): CodexTranscriptSourceRef {
  assertOffset(inode);
  assertOffset(sourceGeneration);
  return { ...codexContentAnchor(bytes, startOffset), inode, sourceGeneration };
}

async function checkSource(handle: FileHandle, filePath: string, inode: number, endOffset: number): Promise<void> {
  const [opened, named] = await Promise.all([handle.stat(), fs.stat(filePath)]);
  if (Number(opened.ino) !== inode || Number(named.ino) !== inode) throw new CodexSourceConflictError('identity');
  if (Number(opened.size) < endOffset || Number(named.size) < endOffset) throw new CodexSourceConflictError('truncated');
}

/** All source syscalls use a shared reservation and report exactly one fixed reason. */
async function readSourceChunk(
  handle: FileHandle, slice: CodexFileWorkSlice, position: number,
  endOffset: number, reason: CodexReadReason, bufferedBytes = 0,
): Promise<Buffer | null> {
  const requested = Math.min(endOffset - position, slice.budget.limits.maxReadChunkBytes);
  if (slice.budget.allowBufferGrowth?.(slice.filePath, bufferedBytes, requested) === false) return null;
  const reservation = slice.reserve(endOffset - position);
  if (!reservation) return null;
  const buffer = Buffer.alloc(reservation.requestedBytes);
  const runtime = slice.budget.runtime;
  const startedAt = slice.budget.now();
  let bytesRead = 0;
  try {
    const result = await handle.read(buffer, 0, buffer.length, position);
    bytesRead = result.bytesRead;
    return buffer.subarray(0, bytesRead);
  } finally {
    reservation.settle(bytesRead);
    runtime?.observeRead(bytesRead, buffer.length, slice.budget.now() - startedAt, reason);
  }
}

export interface CodexJsonLine extends CodexTranscriptSourceRecord {
  /** Digest of the raw complete record, not the normalized JSON representation. */
  sha256: string;
  headAnchor: CodexTranscriptContentAnchor;
}

export interface CodexJsonlReadStatistics {
  records: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  maxRecordBytes: number;
}

export interface CodexLineReadProgress {
  status: 'complete' | 'deferred' | 'incomplete-tail' | 'source-conflict';
  nextOffset: number;
  /** Task-cumulative complete-line statistics, not repeated read-byte counters. */
  records: number;
  parseSuccessRecords: number;
  parseFailedRecords: number;
  maxRecordBytes: number;
  conflict?: CodexSourceConflictError;
}

/** In-memory read progress is independent of the last complete JSONL consumption offset. */
export class CodexJsonlReadTask {
  readonly startOffset: number;
  private endOffset: number;
  private readOffset: number;
  private nextOffset: number;
  private inode: number | undefined;
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private chunk: Buffer | null = null;
  private cursor = 0;
  private records = 0;
  private successes = 0;
  private failures = 0;
  private maxRecordBytes = 0;
  private stopped = false;
  private atIncompleteTail = false;
  private tailBoundaryOnly = false;
  private headAnchor: CodexTranscriptContentAnchor | undefined;
  private frontierAnchor: CodexTranscriptContentAnchor | undefined;
  private conflict: CodexSourceConflictError | undefined;
  private stepStatistics: CodexJsonlReadStatistics = emptyReadStatistics();

  get lastStepStatistics(): CodexJsonlReadStatistics { return { ...this.stepStatistics }; }

  constructor(
    readonly filePath: string, startOffset: number, endOffset: number,
    readonly reason: CodexReadReason, inode?: number, firstLineOnly = false,
  ) {
    assertRange(startOffset, endOffset);
    if (inode !== undefined) assertOffset(inode);
    this.startOffset = startOffset;
    this.readOffset = this.nextOffset = startOffset;
    this.endOffset = endOffset;
    this.inode = inode;
    this.tailBoundaryOnly = firstLineOnly;
  }

  get bufferedBytes(): number { return this.partsBytes + (this.chunk?.length ?? 0); }
  get parsedOffset(): number { return this.nextOffset; }
  get observedReadOffset(): number { return this.readOffset; }
  get targetEndOffset(): number { return this.endOffset; }
  get contentAnchors(): CodexTranscriptContentAnchor[] {
    return [this.headAnchor, this.frontierAnchor].filter((anchor): anchor is CodexTranscriptContentAnchor => !!anchor)
      .map(anchor => ({ ...anchor }));
  }

  /** Only an unfinished boundary line may extend a previously fixed observation target. */
  resumeTail(endOffset: number): void {
    assertOffset(endOffset);
    if (!this.atIncompleteTail || endOffset < this.endOffset || this.stopped || this.conflict) {
      throw new Error('Codex JSONL task is not a resumable tail');
    }
    this.endOffset = endOffset;
    this.atIncompleteTail = false;
    this.tailBoundaryOnly = true;
  }

  /** Evict only unconsumed buffers. Never advance or rewind the complete-line watermark. */
  releaseBuffers(): void {
    this.parts = [];
    this.partsBytes = 0;
    this.chunk = null;
    this.cursor = 0;
    this.readOffset = this.nextOffset;
  }

  async step(
    slice: CodexFileWorkSlice,
    onLine: (line: CodexJsonLine) => void | false | Promise<void | false>,
    onRawLine?: (raw: Buffer) => void,
    retainAfterStop = false,
  ): Promise<CodexLineReadProgress> {
    if (slice.filePath !== this.filePath) throw new Error('Codex reader slice belongs to another file');
    this.stepStatistics = emptyReadStatistics();
    if (this.conflict) return this.progress('source-conflict');
    if (this.stopped) return this.progress('complete');
    // An unchanged incomplete EOF is not another eligible read attempt.
    if (this.atIncompleteTail) return this.progress('incomplete-tail');
    let handle: FileHandle | null = null;
    try {
      if (slice.timeExpired) return this.progress('deferred');
      handle = await fs.open(this.filePath, 'r');
      this.inode ??= Number((await handle.stat()).ino);
      await checkSource(handle, this.filePath, this.inode, this.endOffset);
      const defer = async (): Promise<CodexLineReadProgress> => {
        await checkSource(handle!, this.filePath, this.inode!, this.endOffset);
        return this.progress('deferred');
      };
      while (!slice.timeExpired) {
        if (this.chunk && this.cursor < this.chunk.length) {
          const newline = this.chunk.indexOf(0x0a, this.cursor);
          if (newline < 0) {
            const suffix = Buffer.from(this.chunk.subarray(this.cursor));
            this.parts.push(suffix);
            this.partsBytes += suffix.length;
            this.chunk = null;
            this.cursor = 0;
            continue;
          }
          const suffix = this.chunk.subarray(this.cursor, newline + 1);
          const parseStartedAt = slice.budget.now();
          const raw = this.partsBytes > 0
            ? Buffer.concat([...this.parts, suffix], this.partsBytes + suffix.length)
            : suffix;
          const text = raw.toString('utf8').trim();
          let record: unknown;
          if (text) {
            try { record = JSON.parse(text); } catch { /* Consume completed invalid JSON lines. */ }
          }
          slice.budget.noteParse(parseStartedAt);
          const isRecord = !!record && typeof record === 'object' && !Array.isArray(record);
          let keepGoing: void | false = undefined;
          if (isRecord) {
            keepGoing = await onLine({
              startOffset: this.nextOffset, endOffset: this.nextOffset + raw.length,
              record: record as Record<string, unknown>, sha256: createHash('sha256').update(raw).digest('hex'),
              headAnchor: codexContentAnchor(raw.subarray(0, 4096), this.nextOffset),
            });
          }
          onRawLine?.(raw);
          if (text) {
            this.records++;
            this.maxRecordBytes = Math.max(this.maxRecordBytes, raw.length);
            this.stepStatistics.records++;
            this.stepStatistics.maxRecordBytes = Math.max(this.stepStatistics.maxRecordBytes, raw.length);
            if (isRecord) { this.successes++; this.stepStatistics.parseSuccessRecords++; }
            else { this.failures++; this.stepStatistics.parseFailedRecords++; }
          }
          const tailStart = Math.max(0, raw.length - 4096);
          this.frontierAnchor = codexContentAnchor(raw.subarray(tailStart), this.nextOffset + tailStart);
          this.nextOffset += raw.length;
          this.parts = [];
          this.partsBytes = 0;
          this.cursor = newline + 1;
          if (this.cursor === this.chunk.length) { this.chunk = null; this.cursor = 0; }
          if (keepGoing === false || this.tailBoundaryOnly) {
            await checkSource(handle, this.filePath, this.inode, this.endOffset);
            // 普通扫描在 terminal 边界交付候选，后续预读字节留待下一次 dispatch。
            if (retainAfterStop && !this.tailBoundaryOnly && this.nextOffset < this.endOffset) return this.progress('deferred');
            this.stopped = true;
            this.releaseBuffers();
            return this.progress('complete');
          }
          if (raw.length > slice.budget.limits.fileQuantumBytes && this.nextOffset < this.endOffset) {
            await slice.budget.yieldIfNeeded(256);
            return await defer();
          }
          await slice.budget.yieldIfNeeded();
          continue;
        }
        if (this.readOffset >= this.endOffset) {
          await checkSource(handle, this.filePath, this.inode, this.endOffset);
          if (this.partsBytes > 0) {
            this.atIncompleteTail = true;
            return this.progress('incomplete-tail');
          }
          this.stopped = true;
          return this.progress('complete');
        }
        const chunk = await readSourceChunk(handle, slice, this.readOffset, this.endOffset, this.reason, this.bufferedBytes);
        if (chunk === null) return await defer();
        if (chunk.length === 0) throw new CodexSourceConflictError('short-read');
        if (this.readOffset === 0 && !this.headAnchor) {
          this.headAnchor = codexContentAnchor(chunk.subarray(0, 4096), 0);
        }
        this.readOffset += chunk.length;
        this.chunk = chunk;
        this.cursor = 0;
      }
      return await defer();
    } catch (error) {
      if (!(error instanceof CodexSourceConflictError)) throw error;
      this.conflict = error;
      this.releaseBuffers();
      return this.progress('source-conflict');
    } finally {
      await handle?.close();
    }
  }

  private progress(status: CodexLineReadProgress['status']): CodexLineReadProgress {
    return {
      status, nextOffset: this.nextOffset, records: this.records,
      parseSuccessRecords: this.successes, parseFailedRecords: this.failures,
      maxRecordBytes: this.maxRecordBytes,
      ...(this.conflict ? { conflict: this.conflict } : {}),
    };
  }
}

function emptyReadStatistics(): CodexJsonlReadStatistics {
  return { records: 0, parseSuccessRecords: 0, parseFailedRecords: 0, maxRecordBytes: 0 };
}

function sameSourceSnapshot(a: CodexTranscriptSourceSnapshot, b: CodexTranscriptSourceSnapshot): boolean {
  return a.inode === b.inode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function parseCodexJsonlProbeState(value: unknown): CodexJsonlProbeState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as CodexJsonlProbeState;
  const offset = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const snapshot = state.snapshot;
  if (!snapshot || !offset(snapshot.inode) || !offset(snapshot.size)
    || !Number.isFinite(snapshot.mtimeMs) || !Number.isFinite(snapshot.ctimeMs)
    || !offset(state.sourceGeneration) || !offset(state.targetSize) || !offset(state.nextCompleteOffset)
    || state.nextCompleteOffset > state.targetSize || state.targetSize > snapshot.size
    || typeof state.incompleteTail !== 'boolean' || !Array.isArray(state.anchors) || state.anchors.length > 3
    || !state.anchors.every(a => a && offset(a.startOffset) && offset(a.endOffset)
      && a.endOffset > a.startOffset && a.endOffset <= snapshot.size && typeof a.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(a.sha256))) return undefined;
  if (state.conflict && (!['identity', 'truncated', 'fingerprint', 'short-read'].includes(state.conflict.reason)
    || !offset(state.conflict.retryCount) || !Number.isFinite(state.conflict.nextRetryAtMs))) return undefined;
  return structuredClone(state);
}

/** 固定观察范围的续读器；校验完成之前不得复用旧前沿或半行。 */
export class CodexGuardedJsonlReadTask {
  private state: CodexJsonlProbeState;
  private reader: CodexJsonlReadTask | undefined;
  private validation: CodexRangeReadTask[] | undefined;
  private resetTargetSize: number | undefined;
  private stepStatistics: CodexJsonlReadStatistics = emptyReadStatistics();

  get lastStepStatistics(): CodexJsonlReadStatistics { return { ...this.stepStatistics }; }

  constructor(
    readonly filePath: string,
    snapshot: CodexTranscriptSourceSnapshot,
    readonly sourceGeneration: number,
    readonly reason: CodexReadReason,
    startOffset: number,
    restored?: CodexJsonlProbeState,
    anchors: CodexTranscriptContentAnchor[] = [],
    targetSize = snapshot.size,
    private readonly now: () => number = () => Date.now(),
  ) {
    assertRange(startOffset, targetSize);
    const reusable = restored?.snapshot.inode === snapshot.inode && restored.sourceGeneration === sourceGeneration
      && restored.snapshot.size >= startOffset;
    if (reusable && restored.nextCompleteOffset !== startOffset) this.resetTargetSize = targetSize;
    this.state = reusable && restored.nextCompleteOffset === startOffset ? structuredClone(restored) : {
      sourceGeneration, snapshot: { ...(reusable ? restored.snapshot : snapshot) },
      targetSize: reusable ? Math.min(restored.snapshot.size, targetSize) : targetSize,
      nextCompleteOffset: startOffset, incompleteTail: false,
      anchors: (reusable ? restored.anchors : anchors).map(a => ({ ...a })),
      ...(reusable && restored.conflict ? { conflict: { ...restored.conflict } } : {}),
    };
  }

  get parsedOffset(): number { return this.state.nextCompleteOffset; }
  get bufferedBytes(): number { return this.reader?.bufferedBytes ?? 0; }
  get sourceConflict(): boolean { return !!this.state.conflict; }
  get retryEligible(): boolean { return !this.state.conflict || this.now() >= this.state.conflict.nextRetryAtMs; }
  serialize(): CodexJsonlProbeState { return structuredClone(this.state); }
  releaseBuffers(): void { this.reader = undefined; }
  rejectSource(error: CodexSourceConflictError, previousRetryCount = 0): void {
    if (previousRetryCount > (this.state.conflict?.retryCount ?? 0)) {
      this.state.conflict = { reason: error.reason, retryCount: previousRetryCount, nextRetryAtMs: 0 };
    }
    this.freeze(error);
  }

  async validate(slice: CodexFileWorkSlice, snapshot: CodexTranscriptSourceSnapshot): Promise<'complete' | 'deferred' | 'source-conflict'> {
    if (slice.filePath !== this.filePath) throw new Error('Codex reader slice belongs to another file');
    if (!this.retryEligible) return 'source-conflict';
    try {
      if (snapshot.inode !== this.state.snapshot.inode) throw new CodexSourceConflictError('identity');
      if (snapshot.size < this.state.targetSize) throw new CodexSourceConflictError('truncated');
      if (!sameSourceSnapshot(this.state.snapshot, snapshot) || this.state.conflict || this.validation) {
        this.validation ??= this.state.anchors.map(anchor => new CodexRangeReadTask(this.filePath, {
          ...anchor, inode: this.state.snapshot.inode, sourceGeneration: this.sourceGeneration,
        }, 'integrity_check'));
        while (this.validation.length > 0) {
          const result = await this.validation[0]!.step(slice, this.sourceGeneration);
          if (result.status === 'source-conflict') throw result.conflict;
          if (result.status === 'deferred') return 'deferred';
          this.validation.shift();
        }
        this.validation = undefined;
        if (this.state.conflict) this.releaseBuffers();
        this.state.conflict = undefined;
        this.state.snapshot = { ...snapshot };
      }
      if (this.resetTargetSize !== undefined) {
        this.state.targetSize = this.resetTargetSize;
        this.resetTargetSize = undefined;
      }
      return 'complete';
    } catch (error) {
      if (!(error instanceof CodexSourceConflictError)) throw error;
      this.freeze(error);
      return 'source-conflict';
    }
  }

  async step(
    slice: CodexFileWorkSlice, snapshot: CodexTranscriptSourceSnapshot,
    onLine: (line: CodexJsonLine) => void | false | Promise<void | false>,
    followAppends = true,
    onRawLine?: (raw: Buffer) => void,
    retainAfterStop = false,
  ): Promise<CodexLineReadProgress> {
    this.stepStatistics = emptyReadStatistics();
    const validated = await this.validate(slice, snapshot);
    if (validated !== 'complete') return this.progress(validated);
    const before = this.serialize();
    // 静止完整 EOF 不创建空 reader，避免空 dispatch 抹掉上次真实前沿锚点。
    if (!this.reader && !this.state.incompleteTail && this.parsedOffset >= this.state.targetSize
      && (!followAppends || snapshot.size <= this.state.targetSize)) return this.progress('complete');
    if (this.state.incompleteTail) {
      if (!followAppends || snapshot.size <= this.state.targetSize) return this.progress('incomplete-tail');
      if (this.reader) this.reader.resumeTail(snapshot.size);
      else this.reader = new CodexJsonlReadTask(this.filePath, this.parsedOffset, snapshot.size,
        this.reason, snapshot.inode, true);
      this.state.targetSize = snapshot.size;
      this.state.incompleteTail = false;
    } else if (!this.reader && followAppends && this.parsedOffset >= this.state.targetSize) {
      this.state.targetSize = snapshot.size;
    }
    this.reader ??= new CodexJsonlReadTask(this.filePath, this.parsedOffset, this.state.targetSize, this.reason, snapshot.inode);
    let result: CodexLineReadProgress;
    try {
      result = await this.reader.step(slice, onLine, onRawLine, retainAfterStop);
    } catch (error) {
      // 调用方尚未提交本次候选；从原完整行水位重建，不复用部分执行的回调状态。
      this.state = before;
      this.releaseBuffers();
      throw error;
    }
    if (result.status === 'source-conflict') {
      this.state = before;
      this.freeze(result.conflict!);
      return this.progress('source-conflict');
    }
    this.stepStatistics = this.reader.lastStepStatistics;
    this.state.nextCompleteOffset = result.nextOffset;
    this.state.incompleteTail = result.status === 'incomplete-tail';
    const anchors = this.reader.contentAnchors;
    const head = this.state.anchors.find(a => a.startOffset === 0) ?? anchors.find(a => a.startOffset === 0);
    const frontier = anchors.at(-1);
    const unique = new Map<string, CodexTranscriptContentAnchor>();
    for (const anchor of [head, frontier, ...this.state.anchors.slice(-1)]) {
      if (anchor) unique.set(`${anchor.startOffset}:${anchor.endOffset}`, { ...anchor });
    }
    this.state.anchors = [...unique.values()].slice(0, 3);
    if (result.status === 'complete') {
      // 首个补齐换行或调用方的停止条件不把后续新记录并入旧观察范围。
      this.state.targetSize = result.nextOffset;
      this.reader = undefined;
    }
    return result;
  }

  private freeze(error: CodexSourceConflictError): void {
    const retryCount = (this.state.conflict?.retryCount ?? 0) + 1;
    this.state.conflict = { reason: error.reason, retryCount,
      nextRetryAtMs: this.now() + Math.min(300_000, 10_000 * 2 ** Math.min(5, retryCount - 1)) };
    this.releaseBuffers();
    this.validation = undefined;
  }

  private progress(status: CodexLineReadProgress['status']): CodexLineReadProgress {
    return { status, nextOffset: this.parsedOffset, records: 0, parseSuccessRecords: 0,
      parseFailedRecords: 0, maxRecordBytes: 0 };
  }
}

export function parseCodexSourceRef(value: unknown): CodexTranscriptSourceRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as CodexTranscriptSourceRef;
  if (![ref.inode, ref.sourceGeneration, ref.startOffset, ref.endOffset].every(n => Number.isSafeInteger(n) && n >= 0)
    || ref.endOffset <= ref.startOffset || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) return undefined;
  return { inode: ref.inode, sourceGeneration: ref.sourceGeneration, startOffset: ref.startOffset, endOffset: ref.endOffset, sha256: ref.sha256 };
}

export function parseCodexRecordReadState(value: unknown): CodexRecordReadState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as CodexRecordReadState;
  const probe = parseCodexJsonlProbeState(state.probe);
  const expectedRef = state.expectedRef ? parseCodexSourceRef(state.expectedRef) : undefined;
  if (!probe || !['recovery', 'hydrate'].includes(state.reason)
    || !Number.isSafeInteger(state.startOffset) || state.startOffset < 0 || !Number.isSafeInteger(state.endOffset)
    || state.endOffset <= state.startOffset || probe.targetSize !== state.endOffset || probe.nextCompleteOffset < state.startOffset
    || (state.expectedRef && (!expectedRef || expectedRef.startOffset !== state.startOffset || expectedRef.endOffset !== state.endOffset
      || expectedRef.inode !== probe.snapshot.inode || expectedRef.sourceGeneration !== probe.sourceGeneration))) return undefined;
  return { startOffset: state.startOffset, endOffset: state.endOffset, reason: state.reason, probe, ...(expectedRef ? { expectedRef } : {}) };
}

export type CodexRecordRangeResult =
  | { status: 'complete'; items: CodexJsonLine[]; nextOffset: number; sourceRef: CodexTranscriptSourceRef }
  | { status: 'deferred' | 'waiting' | 'source-conflict' };

/** 固定恢复事务：完整范围校验后才交付解析记录；重启从原范围安全重建一次。 */
export class CodexRecordRangeReadTask {
  private reader: CodexGuardedJsonlReadTask;
  private items: CodexJsonLine[] = [];
  private digest = createHash('sha256');
  private completeRef: CodexTranscriptSourceRef | undefined;
  private retainedBytes = 0;
  private conflictRetryCount: number;
  readonly expectedRef: Readonly<CodexTranscriptSourceRef> | undefined;

  constructor(
    readonly filePath: string, readonly startOffset: number, readonly endOffset: number,
    snapshot: CodexTranscriptSourceSnapshot, readonly sourceGeneration: number,
    readonly reason: 'recovery' | 'hydrate', restored?: CodexRecordReadState,
    anchors: CodexTranscriptContentAnchor[] = [], expectedRef?: CodexTranscriptSourceRef,
  ) {
    this.expectedRef = expectedRef ? Object.freeze({ ...expectedRef }) : restored?.expectedRef ? Object.freeze({ ...restored.expectedRef }) : undefined;
    this.conflictRetryCount = restored?.probe.conflict?.retryCount ?? 0;
    const probe = restored ? { ...restored.probe, nextCompleteOffset: startOffset, incompleteTail: false } : undefined;
    this.reader = new CodexGuardedJsonlReadTask(filePath, snapshot, sourceGeneration, reason, startOffset, probe, anchors, endOffset);
  }

  get sourceConflict(): boolean { return this.reader.sourceConflict; }
  get retryEligible(): boolean { return this.reader.retryEligible; }
  get bufferedBytes(): number { return this.reader.bufferedBytes + this.retainedBytes; }
  get assemblyBytes(): number { return this.reader.bufferedBytes; }
  /** 仅回收可重建内存，保留固定范围、原锚点及完整 fingerprint 期望。 */
  releaseBuffers(): void { this.discardConflictedRecords(); }
  serialize(): CodexRecordReadState {
    return { startOffset: this.startOffset, endOffset: this.endOffset, reason: this.reason, probe: this.reader.serialize(),
      ...(this.expectedRef ? { expectedRef: { ...this.expectedRef } } : {}) };
  }

  async step(slice: CodexFileWorkSlice, snapshot: CodexTranscriptSourceSnapshot): Promise<CodexRecordRangeResult> {
    // 超过普通暂停容量的完整事务在首读前取得巨大槽位，避免多个范围循环互相淘汰。
    if ((this.endOffset - this.startOffset) * 3 > 32 * 1024 * 1024
      && slice.budget.allowBufferGrowth?.(this.filePath, (this.endOffset - this.startOffset) * 3, 0) === false) {
      return { status: 'deferred' };
    }
    if (this.completeRef) {
      const status = await this.reader.validate(slice, snapshot);
      if (status === 'complete') return { status, items: this.items, nextOffset: this.endOffset, sourceRef: { ...this.completeRef } };
      if (status === 'source-conflict') this.discardConflictedRecords();
      return { status };
    }
    const beforeLength = this.items.length;
    const beforeBytes = this.retainedBytes;
    const beforeDigest = this.digest.copy();
    let result: CodexLineReadProgress;
    try {
      result = await this.reader.step(slice, snapshot, line => { this.items.push(line); this.retainedBytes += 256 + 3 * (line.endOffset - line.startOffset); }, false, raw => { this.digest.update(raw); });
    } catch (error) {
      this.items.length = beforeLength;
      this.retainedBytes = beforeBytes;
      this.digest = beforeDigest;
      throw error;
    }
    if (result.status === 'source-conflict') {
      this.discardConflictedRecords();
      return { status: 'source-conflict' };
    }
    if (result.status !== 'complete') return { status: result.status === 'deferred' ? 'deferred' : 'waiting' };
    const sourceRef = { inode: snapshot.inode, sourceGeneration: this.sourceGeneration, startOffset: this.startOffset,
      endOffset: this.endOffset, sha256: this.digest.copy().digest('hex') };
    if (this.expectedRef && (this.expectedRef.inode !== sourceRef.inode || this.expectedRef.sourceGeneration !== sourceRef.sourceGeneration
      || this.expectedRef.startOffset !== sourceRef.startOffset || this.expectedRef.endOffset !== sourceRef.endOffset || this.expectedRef.sha256 !== sourceRef.sha256)) {
      this.reader.rejectSource(new CodexSourceConflictError('fingerprint'), this.conflictRetryCount);
      this.discardConflictedRecords();
      return { status: 'source-conflict' };
    }
    this.conflictRetryCount = 0;
    this.completeRef = sourceRef;
    return { status: 'complete', items: this.items, nextOffset: result.nextOffset, sourceRef: { ...sourceRef } };
  }

  private discardConflictedRecords(): void {
    const state = this.serialize();
    this.conflictRetryCount = state.probe.conflict?.retryCount ?? this.conflictRetryCount;
    this.items = [];
    this.retainedBytes = 0;
    this.digest = createHash('sha256');
    this.completeRef = undefined;
    this.reader = new CodexGuardedJsonlReadTask(this.filePath, state.probe.snapshot, this.sourceGeneration, this.reason,
      this.startOffset, { ...state.probe, nextCompleteOffset: this.startOffset, incompleteTail: false }, [], this.endOffset);
  }
}

export type CodexRangeReadResult =
  | { status: 'complete'; bytes: Buffer }
  | { status: 'deferred' }
  | { status: 'source-conflict'; conflict: CodexSourceConflictError };

/** Fixed-range hydration uses the exact bytes that passed the fingerprint check. */
export class CodexRangeReadTask {
  private offset: number;
  private parts: Buffer[] = [];
  private bytes: Buffer | null = null;
  private conflict: CodexSourceConflictError | undefined;

  constructor(
    readonly filePath: string,
    readonly ref: Readonly<CodexTranscriptSourceRef>,
    readonly reason: CodexReadReason = 'hydrate',
  ) {
    assertRange(ref.startOffset, ref.endOffset);
    assertOffset(ref.inode);
    assertOffset(ref.sourceGeneration);
    if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new RangeError('invalid Codex source fingerprint');
    // Keep a copy so callers cannot rewrite the expectation during a paused task.
    this.ref = Object.freeze({ ...ref });
    this.offset = ref.startOffset;
  }

  get bufferedBytes(): number { return this.offset - this.ref.startOffset; }

  releaseBuffers(): void {
    this.parts = [];
    this.bytes = null;
    this.offset = this.ref.startOffset;
  }

  async step(slice: CodexFileWorkSlice, sourceGeneration: number): Promise<CodexRangeReadResult> {
    if (slice.filePath !== this.filePath) throw new Error('Codex reader slice belongs to another file');
    if (this.conflict) return { status: 'source-conflict', conflict: this.conflict };
    if (sourceGeneration !== this.ref.sourceGeneration) {
      this.conflict = new CodexSourceConflictError('identity');
      this.releaseBuffers();
      return { status: 'source-conflict', conflict: this.conflict };
    }
    let handle: FileHandle | null = null;
    try {
      if (slice.timeExpired) return { status: 'deferred' };
      handle = await fs.open(this.filePath, 'r');
      await checkSource(handle, this.filePath, this.ref.inode, this.ref.endOffset);
      while (!this.bytes && this.offset < this.ref.endOffset) {
        const chunk = await readSourceChunk(handle, slice, this.offset, this.ref.endOffset, this.reason, this.bufferedBytes);
        if (chunk === null) return { status: 'deferred' };
        if (chunk.length === 0) throw new CodexSourceConflictError('short-read');
        this.parts.push(chunk);
        this.offset += chunk.length;
      }
      if (slice.timeExpired) return { status: 'deferred' };
      this.bytes ??= Buffer.concat(this.parts, this.ref.endOffset - this.ref.startOffset);
      this.parts = [];
      const digest = createHash('sha256').update(this.bytes).digest('hex');
      if (digest !== this.ref.sha256) throw new CodexSourceConflictError('fingerprint');
      await checkSource(handle, this.filePath, this.ref.inode, this.ref.endOffset);
      return { status: 'complete', bytes: this.bytes };
    } catch (error) {
      if (!(error instanceof CodexSourceConflictError)) throw error;
      this.conflict = error;
      this.releaseBuffers();
      return { status: 'source-conflict', conflict: error };
    } finally {
      await handle?.close();
    }
  }
}
