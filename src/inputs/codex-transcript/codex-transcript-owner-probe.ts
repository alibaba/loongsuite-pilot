import {
  CodexJsonlReadTask, CodexRangeReadTask, CodexSourceConflictError, type CodexJsonLine,
} from './codex-transcript-reader.js';
import { extractCodexTranscriptMeta, sessionIdFromTranscriptPath } from './codex-transcript-extractor.js';
import type { CodexFileWorkSlice, CodexWorkStepResult } from './codex-transcript-work-scheduler.js';
import type {
  CodexOwnerProbeState, CodexOwnerResolution, CodexTranscriptContentAnchor,
  CodexTranscriptMeta, CodexTranscriptSourceRef, CodexTranscriptSourceSnapshot,
} from './codex-transcript-types.js';

function sameSnapshot(a: CodexTranscriptSourceSnapshot, b: CodexTranscriptSourceSnapshot): boolean {
  return a.inode === b.inode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function copyState(state: CodexOwnerProbeState): CodexOwnerProbeState {
  return {
    ...state, probe: { ...state.probe }, snapshot: { ...state.snapshot },
    anchors: state.anchors.map(anchor => ({ ...anchor })),
    ...(state.ownerRef ? { ownerRef: { ...state.ownerRef } } : {}),
    ...(state.conflict ? { conflict: { ...state.conflict } } : {}),
  };
}

function offset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validAnchor(value: unknown): value is CodexTranscriptContentAnchor {
  const anchor = object(value);
  return !!anchor && offset(anchor.startOffset) && offset(anchor.endOffset)
    && anchor.endOffset > anchor.startOffset && typeof anchor.sha256 === 'string' && /^[a-f0-9]{64}$/.test(anchor.sha256);
}

export function parseCodexOwnerProbeState(value: unknown): CodexOwnerProbeState | undefined {
  const state = object(value);
  const probe = object(state?.probe);
  const snapshot = object(state?.snapshot);
  if (!state || !probe || !snapshot || !['searching', 'resolved', 'absent-at-watermark'].includes(String(state.kind))
    || !offset(probe.inode) || !offset(probe.sourceGeneration) || !offset(probe.targetSize)
    || !offset(probe.nextCompleteOffset) || !(probe.candidateOwnerOffset === null || offset(probe.candidateOwnerOffset))
    || typeof probe.sawSessionMeta !== 'boolean' || typeof probe.headerClosed !== 'boolean'
    || !offset(snapshot.inode) || snapshot.inode !== probe.inode || !offset(snapshot.size)
    || typeof snapshot.mtimeMs !== 'number' || !Number.isFinite(snapshot.mtimeMs)
    || typeof snapshot.ctimeMs !== 'number' || !Number.isFinite(snapshot.ctimeMs)
    || !Array.isArray(state.anchors) || state.anchors.length > 3 || !state.anchors.every(validAnchor)) return undefined;
  const ref = object(state.ownerRef);
  if (ref && (!validAnchor(ref) || ref.inode !== probe.inode || ref.sourceGeneration !== probe.sourceGeneration
    || ref.startOffset !== probe.candidateOwnerOffset)) return undefined;
  if (state.kind === 'resolved' && (!ref || probe.candidateOwnerOffset === null)) return undefined;
  const conflict = object(state.conflict);
  if (conflict && (!['identity', 'truncated', 'fingerprint', 'short-read'].includes(String(conflict.reason))
    || !offset(conflict.retryCount) || typeof conflict.nextRetryAtMs !== 'number' || !Number.isFinite(conflict.nextRetryAtMs))) return undefined;
  return copyState(state as unknown as CodexOwnerProbeState);
}

export function codexOwnerSummary(meta: CodexTranscriptMeta): CodexTranscriptMeta {
  const { baseInstructions: _instructions, toolDefinitions: _tools, ...summary } = meta;
  return summary;
}

export class CodexTranscriptOwnerProbe {
  private state: CodexOwnerProbeState;
  private reader: CodexJsonlReadTask | undefined;
  private incomplete = false;
  private meta: CodexTranscriptMeta | null;
  private fullMeta: CodexTranscriptMeta | null = null;
  private validation: CodexRangeReadTask[] | undefined;
  private hydration: CodexRangeReadTask | undefined;

  constructor(
    readonly filePath: string,
    snapshot: CodexTranscriptSourceSnapshot,
    restored?: CodexOwnerProbeState,
    cachedMeta?: CodexTranscriptMeta | null,
    private readonly now: () => number = () => Date.now(),
    sourceGeneration = 0,
  ) {
    this.state = restored ? copyState(restored) : {
      kind: 'searching', probe: {
        inode: snapshot.inode, sourceGeneration, targetSize: snapshot.size,
        nextCompleteOffset: 0, candidateOwnerOffset: null, sawSessionMeta: false, headerClosed: false,
      }, snapshot: { ...snapshot }, anchors: [],
    };
    this.meta = cachedMeta ? codexOwnerSummary(cachedMeta) : null;
    this.fullMeta = cachedMeta ?? null;
  }

  get inode(): number { return this.state.probe.inode; }
  get sourceGeneration(): number { return this.state.probe.sourceGeneration; }
  get ownerMeta(): CodexTranscriptMeta | null { return this.meta; }
  get completeMeta(): CodexTranscriptMeta | null { return this.fullMeta; }
  releaseCompleteMeta(): void { this.fullMeta = null; }
  releaseBuffers(): void { this.reader?.releaseBuffers(); this.hydration?.releaseBuffers(); }
  get sourceConflict(): boolean { return !!this.state.conflict; }
  get bufferedBytes(): number { return (this.reader?.bufferedBytes ?? 0) + (this.hydration?.bufferedBytes ?? 0); }
  get resolution(): CodexOwnerResolution {
    if (this.state.conflict || this.state.kind === 'searching' || (this.state.kind === 'resolved' && !this.meta)) {
      return { kind: 'searching', probe: { ...this.state.probe } };
    }
    return this.state.kind === 'resolved'
      ? { kind: 'resolved', ownerOffset: this.state.probe.candidateOwnerOffset!, verifiedThroughOffset: this.state.probe.nextCompleteOffset }
      : { kind: 'absent-at-watermark', verifiedThroughOffset: this.state.probe.nextCompleteOffset };
  }

  serialize(): CodexOwnerProbeState { return copyState(this.state); }

  eligible(snapshot: CodexTranscriptSourceSnapshot): boolean {
    if (this.state.conflict && this.now() < this.state.conflict.nextRetryAtMs) return false;
    if (!sameSnapshot(this.state.snapshot, snapshot) || this.state.conflict) return true;
    if (this.state.kind !== 'searching' && !this.state.probe.headerClosed && snapshot.size > this.state.probe.nextCompleteOffset) return true;
    if (this.state.kind === 'resolved') return !this.meta;
    return this.state.kind === 'searching' && !this.incomplete;
  }

  readyFor(snapshot: CodexTranscriptSourceSnapshot): boolean {
    return sameSnapshot(this.state.snapshot, snapshot) && this.resolution.kind !== 'searching'
      && (this.state.probe.headerClosed || snapshot.size <= this.state.probe.nextCompleteOffset);
  }

  acceptOwner(line: CodexJsonLine, meta: CodexTranscriptMeta, snapshot: CodexTranscriptSourceSnapshot): void {
    this.meta = codexOwnerSummary(meta);
    this.fullMeta = meta;
    this.state.ownerRef = {
      startOffset: line.startOffset, endOffset: line.endOffset, sha256: line.sha256,
      inode: this.inode, sourceGeneration: this.sourceGeneration,
    };
    this.state.probe.candidateOwnerOffset = line.startOffset;
    this.state.probe.sawSessionMeta = true;
    this.state.probe.nextCompleteOffset = Math.max(this.state.probe.nextCompleteOffset, line.endOffset);
    this.state.probe.targetSize = Math.max(this.state.probe.targetSize, line.endOffset);
    this.state.kind = 'resolved';
    this.state.snapshot = { ...snapshot };
    this.keepAnchors(this.state.anchors.slice(0, 2), line.headAnchor);
  }

  async step(slice: CodexFileWorkSlice, snapshot: CodexTranscriptSourceSnapshot): Promise<CodexWorkStepResult> {
    if (this.state.conflict && this.now() < this.state.conflict.nextRetryAtMs) return { status: 'waiting' };
    const oldOffset = this.reader?.observedReadOffset ?? this.state.probe.nextCompleteOffset;
    try {
      if (snapshot.inode !== this.inode) throw new CodexSourceConflictError('identity');
      if (snapshot.size < this.state.probe.nextCompleteOffset) throw new CodexSourceConflictError('truncated');
      if (!sameSnapshot(this.state.snapshot, snapshot) || this.state.conflict || this.validation) {
        this.validation ??= this.state.anchors.map(anchor => new CodexRangeReadTask(this.filePath, {
          ...anchor, inode: this.inode, sourceGeneration: this.sourceGeneration,
        }, 'integrity_check'));
        while (this.validation.length > 0) {
          const result = await this.validation[0]!.step(slice, this.sourceGeneration);
          if (result.status === 'source-conflict') throw result.conflict;
          if (result.status === 'deferred') return { status: 'deferred', progressed: slice.readBytes > 0 };
          this.validation.shift();
        }
        this.validation = undefined;
        if (this.state.conflict) {
          this.reader = undefined;
          this.incomplete = false;
          this.hydration = undefined;
          this.state.conflict = undefined;
        }
        this.state.snapshot = { ...snapshot };
      }
      if (this.state.kind !== 'searching' && !this.state.probe.headerClosed && snapshot.size > this.state.probe.nextCompleteOffset) {
        this.state.kind = 'searching';
        this.state.probe.targetSize = snapshot.size;
        this.reader = undefined;
      }
      if (this.state.kind !== 'searching') return await this.finishHydration(slice);
      this.reader ??= new CodexJsonlReadTask(this.filePath, this.state.probe.nextCompleteOffset,
        this.state.probe.targetSize, 'owner_probe', this.inode);
      if (this.incomplete) {
        if (snapshot.size <= this.reader.targetEndOffset) return { status: 'waiting' };
        this.reader.resumeTail(snapshot.size);
        this.incomplete = false;
      }
      const next = { ...this.state.probe };
      let ownerAnchor = this.state.anchors.find(anchor => anchor.startOffset === next.candidateOwnerOffset);
      let ownerRef = this.state.ownerRef;
      let nextMeta = this.meta;
      let nextFullMeta = this.fullMeta;
      const result = await this.reader.step(slice, line => {
        if (line.record.type !== 'session_meta') {
          if (next.sawSessionMeta) { next.headerClosed = true; return false; }
          return;
        }
        next.sawSessionMeta = true;
        const meta = extractCodexTranscriptMeta(line.record);
        if (!meta) return;
        if (meta.threadId === sessionIdFromTranscriptPath(this.filePath) || next.candidateOwnerOffset === null) {
          next.candidateOwnerOffset = line.startOffset;
          ownerRef = { startOffset: line.startOffset, endOffset: line.endOffset, sha256: line.sha256,
            inode: this.inode, sourceGeneration: this.sourceGeneration };
          ownerAnchor = line.headAnchor;
          nextMeta = codexOwnerSummary(meta);
          nextFullMeta = meta;
        }
      });
      if (result.status === 'source-conflict') throw result.conflict!;
      next.nextCompleteOffset = result.nextOffset;
      this.state.probe = next;
      this.state.ownerRef = ownerRef;
      this.meta = nextMeta;
      this.fullMeta = nextFullMeta;
      this.keepAnchors(this.reader.contentAnchors, ownerAnchor);
      this.incomplete = result.status === 'incomplete-tail';
      if (result.status === 'complete') {
        this.state.kind = next.candidateOwnerOffset === null ? 'absent-at-watermark' : 'resolved';
        this.reader = undefined;
        return await this.finishHydration(slice);
      }
      return { status: this.incomplete ? 'waiting' : 'deferred', progressed: this.reader.observedReadOffset > oldOffset };
    } catch (error) {
      if (!(error instanceof CodexSourceConflictError)) throw error;
      const retryCount = (this.state.conflict?.retryCount ?? 0) + 1;
      this.state.conflict = { reason: error.reason, retryCount,
        nextRetryAtMs: this.now() + Math.min(300_000, 10_000 * 2 ** Math.min(5, retryCount - 1)) };
      this.reader?.releaseBuffers();
      this.hydration?.releaseBuffers();
      this.validation = undefined;
      this.meta = null;
      this.fullMeta = null;
      return { status: 'waiting' };
    }
  }

  private keepAnchors(anchors: CodexTranscriptContentAnchor[], owner?: CodexTranscriptContentAnchor): void {
    const head = this.state.anchors.find(anchor => anchor.startOffset === 0) ?? anchors.find(anchor => anchor.startOffset === 0);
    const frontier = anchors[anchors.length - 1];
    const unique = new Map<string, CodexTranscriptContentAnchor>();
    for (const anchor of [head, frontier, owner]) if (anchor) unique.set(`${anchor.startOffset}:${anchor.endOffset}`, { ...anchor });
    this.state.anchors = [...unique.values()];
  }

  async hydrateCompleteMeta(slice: CodexFileWorkSlice): Promise<CodexWorkStepResult> {
    if (this.fullMeta || this.state.kind !== 'resolved') return { status: 'complete' };
    const ref = this.state.ownerRef;
    if (!ref) throw new Error('resolved Codex owner lacks its original source reference');
    this.hydration ??= new CodexRangeReadTask(this.filePath, ref);
    const result = await this.hydration.step(slice, this.sourceGeneration);
    if (result.status === 'source-conflict') {
      this.hydration = undefined;
      this.meta = null;
      this.state.conflict = { reason: result.conflict.reason,
        retryCount: (this.state.conflict?.retryCount ?? 0) + 1, nextRetryAtMs: this.now() + 10_000 };
      return { status: 'waiting' };
    }
    if (result.status === 'deferred') return { status: 'deferred', progressed: slice.readBytes > 0 };
    this.fullMeta = extractCodexTranscriptMeta(JSON.parse(result.bytes.toString('utf8')));
    if (!this.fullMeta) throw new CodexSourceConflictError('fingerprint');
    this.meta = codexOwnerSummary(this.fullMeta);
    this.hydration = undefined;
    return { status: 'complete' };
  }

  private async finishHydration(slice: CodexFileWorkSlice): Promise<CodexWorkStepResult> {
    return this.state.kind === 'resolved' && !this.meta ? this.hydrateCompleteMeta(slice) : { status: 'complete' };
  }
}
