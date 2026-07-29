import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent, FSWatcher } from 'node:fs';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildWorkBuddyEvents } from './workbuddy-event-builder.js';
import type { WorkBuddyHookEvent, WorkBuddyRecord } from './workbuddy-types.js';

const OFFSET_MAP_KEY = 'workbuddyTranscriptBytes';
const FILE_META_MAP_KEY = 'workbuddyTranscriptFiles';
const INITIALIZED_KEY = 'workbuddyInitialized';
const STABILITY_RETRY_MS = 5_000;
const HOOK_ORPHAN_GRACE_MS = 60 * 60 * 1_000;

interface HookTranscriptHint {
  transcriptPath: string;
  eventFile: string;
  sessionDir: string;
  eventName?: string;
  observedAtMs?: number;
  sessionId?: string;
  toolName?: string;
  toolCallId?: string;
}

interface TranscriptFileMeta {
  size: number;
  mtimeMs: number;
  identity?: string;
  observedStopAtMs: number;
  handledStopAtMs: number;
}

export interface WorkBuddyInputOptions extends InputOptions {
  workBuddyRoot?: string;
  hookEventDir?: string;
}

export class WorkBuddyInput extends BaseInput {
  readonly id = 'workbuddy';
  readonly agentType = ClientType.WorkBuddy;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly root: string;
  private readonly projectsDir: string;
  private readonly hookEventDir: string;
  private watchers: FSWatcher[] = [];
  private stabilityRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WorkBuddyInputOptions) {
    super(opts);
    this.root = opts.workBuddyRoot ?? path.join(homedir(), '.workbuddy');
    this.projectsDir = path.join(this.root, 'projects');
    this.hookEventDir = opts.hookEventDir
      ?? path.join(homedir(), '.loongsuite-pilot', 'state', 'workbuddy', 'hook-events');
  }

  static getWatchPaths(root = path.join(homedir(), '.workbuddy')): string[] {
    return [root, path.join(root, 'projects')];
  }

  static async checkAvailability(root = path.join(homedir(), '.workbuddy')): Promise<boolean> {
    try {
      return (await fs.stat(root)).isDirectory();
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.hookEventDir, { recursive: true });
    this.watchDirectory(this.projectsDir);
    this.watchDirectory(this.hookEventDir);
  }

  protected override async onStop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.stabilityRetry) {
      clearTimeout(this.stabilityRetry);
      this.stabilityRetry = null;
    }
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const offsets = normalizeOffsetMap(state.extra?.[OFFSET_MAP_KEY]);
    const fileMeta = normalizeFileMetaMap(state.extra?.[FILE_META_MAP_KEY]);
    const nextOffsets: Record<string, number> = { ...offsets };
    const nextFileMeta: Record<string, TranscriptFileMeta> = { ...fileMeta };
    const scan = await this.scanTranscriptFiles();
    let hookHints = await this.readHookTranscriptHints();
    hookHints = await this.removeCommittedHookEvents(hookHints, fileMeta);
    hookHints = await this.removeDeletedTranscriptSessions(
      hookHints,
      scan.complete,
      nextFileMeta,
    );
    await this.removeDeletedTranscriptCheckpoints(
      scan.complete,
      nextOffsets,
      nextFileMeta,
    );
    const transcriptPaths = await this.resolveTranscriptPaths([
      ...hookHints.map(hint => hint.transcriptPath),
      ...scan.files,
    ]);
    const stopHints = await this.resolveStopHints(hookHints);
    // Preserve checkpoints for paths that are temporarily unavailable. A scan
    // or read failure is not proof that a transcript was permanently deleted.
    const entries: AgentActivityEntry[] = [];

    for (const transcriptPath of transcriptPaths) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(transcriptPath);
      } catch {
        continue;
      }
      const priorMeta = fileMeta[transcriptPath];
      const identity = fileIdentity(stat);
      const sameSnapshot = priorMeta !== undefined
        && priorMeta.size === stat.size
        && priorMeta.mtimeMs === stat.mtimeMs
        && priorMeta.identity === identity;
      const latestStopAtMs = stopHints.get(transcriptPath) ?? 0;
      const unhandledStop = latestStopAtMs > (priorMeta?.handledStopAtMs ?? 0);
      const stableStopBoundary = sameSnapshot
        && unhandledStop
        && priorMeta?.observedStopAtMs === latestStopAtMs;
      const replacedOrTruncated = priorMeta !== undefined
        && (priorMeta.identity !== identity || stat.size < priorMeta.size);
      let committedOffset = replacedOrTruncated ? 0 : offsets[transcriptPath];

      if (!initialized && committedOffset === undefined) {
        committedOffset = stat.size;
      } else {
        committedOffset ??= 0;
      }
      if (committedOffset > stat.size) committedOffset = 0;

      nextOffsets[transcriptPath] = committedOffset;
      let handledStopAtMs = priorMeta?.handledStopAtMs ?? 0;

      if (stableStopBoundary) {
        const parsed = await readJsonlRange(transcriptPath, committedOffset, stat.size);
        if (parsed && parsed.nextOffset === stat.size) {
          const sessionId = path.basename(transcriptPath, '.jsonl');
          const hookEvents = await this.resolveHookEvents(
            hookHints,
            transcriptPath,
            sessionId,
            priorMeta?.handledStopAtMs ?? 0,
            latestStopAtMs,
          );
          const built = await buildWorkBuddyEvents(parsed.records, { sessionId, hookEvents });
          entries.push(...built);
          nextOffsets[transcriptPath] = parsed.nextOffset;
          handledStopAtMs = latestStopAtMs;
        } else {
          this.scheduleStabilityRetry();
        }
      } else if (latestStopAtMs > handledStopAtMs) {
        this.scheduleStabilityRetry();
      }

      nextFileMeta[transcriptPath] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        identity,
        observedStopAtMs: latestStopAtMs,
        handledStopAtMs,
      };
    }

    const checkpointExtra = {
      [INITIALIZED_KEY]: true,
      [OFFSET_MAP_KEY]: nextOffsets,
      [FILE_META_MAP_KEY]: nextFileMeta,
    };
    this.setState({ extra: checkpointExtra });
    return entries.sort(compareEntriesByTime);
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fsSync.watch(dir, { recursive: true }, () => this.requestCollection());
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Polling remains active when the path is absent or recursive watch is unsupported.
    }
  }

  private scheduleStabilityRetry(): void {
    if (!this.running || this.stabilityRetry) return;
    this.stabilityRetry = setTimeout(() => {
      this.stabilityRetry = null;
      this.requestCollection();
    }, STABILITY_RETRY_MS);
  }

  private async scanTranscriptFiles(): Promise<{ files: string[]; complete: boolean }> {
    let projectEntries: Dirent[];
    try {
      projectEntries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return { files: [], complete: false };
    }
    const files: string[] = [];
    let complete = true;
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      const fullDir = path.join(this.projectsDir, projectEntry.name);
      let names: string[];
      try {
        names = await fs.readdir(fullDir);
      } catch {
        complete = false;
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.jsonl')) files.push(path.join(fullDir, name));
      }
    }
    return { files, complete };
  }

  private async readHookTranscriptHints(): Promise<HookTranscriptHint[]> {
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await fs.readdir(this.hookEventDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const hints: HookTranscriptHint[] = [];
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(this.hookEventDir, sessionEntry.name);
      let eventFiles: string[];
      try {
        eventFiles = (await fs.readdir(sessionDir)).sort();
      } catch {
        continue;
      }
      for (const name of eventFiles) {
        const eventFile = path.join(sessionDir, name);
        if (name.startsWith('.') && name.endsWith('.tmp')) {
          try {
            const stat = await fs.stat(eventFile);
            if (Date.now() - stat.mtimeMs > HOOK_ORPHAN_GRACE_MS) await fs.unlink(eventFile);
          } catch {
            // A concurrent writer or another collector may have removed it.
          }
          continue;
        }
        if (!name.endsWith('.json')) continue;
        let text: string;
        try {
          text = await fs.readFile(eventFile, 'utf8');
        } catch {
          continue;
        }
        try {
          const record = JSON.parse(text) as Record<string, unknown>;
          if (typeof record.transcript_path === 'string' && record.transcript_path.endsWith('.jsonl')) {
            hints.push({
              transcriptPath: record.transcript_path,
              eventFile,
              sessionDir,
              eventName: typeof record.hook_event_name === 'string'
                ? record.hook_event_name
                : undefined,
              observedAtMs: typeof record.observed_at_ms === 'number'
                && Number.isFinite(record.observed_at_ms)
                ? record.observed_at_ms
                : undefined,
              sessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
              toolName: typeof record.tool_name === 'string' ? record.tool_name : undefined,
              toolCallId: typeof record.tool_call_id === 'string'
                ? record.tool_call_id
                : undefined,
            });
          } else {
            await fs.unlink(eventFile).catch(() => undefined);
          }
        } catch {
          // Published files are immutable and become visible only after rename,
          // so invalid JSON cannot become valid later.
          await fs.unlink(eventFile).catch(() => undefined);
        }
      }
      await fs.rmdir(sessionDir).catch(() => undefined);
    }
    return hints;
  }

  private async removeCommittedHookEvents(
    hints: HookTranscriptHint[],
    fileMeta: Record<string, TranscriptFileMeta>,
  ): Promise<HookTranscriptHint[]> {
    const retained: HookTranscriptHint[] = [];
    const touchedSessionDirs = new Set<string>();
    for (const hint of hints) {
      let canonicalTranscriptPath = path.resolve(hint.transcriptPath);
      try {
        canonicalTranscriptPath = await fs.realpath(hint.transcriptPath);
      } catch {
        // A missing transcript is handled by removeDeletedTranscriptSessions.
      }
      const meta = fileMeta[hint.transcriptPath]
        ?? fileMeta[canonicalTranscriptPath];
      const committed = hint.observedAtMs !== undefined
        && meta !== undefined
        && hint.observedAtMs <= meta.handledStopAtMs;
      if (!committed) {
        retained.push(hint);
        continue;
      }
      try {
        await fs.unlink(hint.eventFile);
        touchedSessionDirs.add(hint.sessionDir);
      } catch {
        retained.push(hint);
      }
    }
    await this.removeEmptySessionDirs(touchedSessionDirs);
    return retained;
  }

  private async removeDeletedTranscriptSessions(
    hints: HookTranscriptHint[],
    transcriptScanComplete: boolean,
    fileMeta: Record<string, TranscriptFileMeta>,
  ): Promise<HookTranscriptHint[]> {
    if (!transcriptScanComplete) return hints;

    const hintsBySessionDir = new Map<string, HookTranscriptHint[]>();
    for (const hint of hints) {
      const grouped = hintsBySessionDir.get(hint.sessionDir) ?? [];
      grouped.push(hint);
      hintsBySessionDir.set(hint.sessionDir, grouped);
    }

    const removedSessionDirs = new Set<string>();
    for (const [sessionDir, sessionHints] of hintsBySessionDir) {
      const transcriptPaths = [...new Set(sessionHints.map(hint => hint.transcriptPath))];
      const sessionIds = new Set(
        sessionHints
          .map(hint => hint.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId)),
      );
      let allMissing = transcriptPaths.length > 0;
      for (const transcriptPath of transcriptPaths) {
        try {
          await fs.stat(transcriptPath);
          allMissing = false;
          break;
        } catch (error) {
          if (!isNotFoundError(error)) {
            allMissing = false;
            break;
          }
        }
      }
      if (!allMissing) continue;
      const previouslyObserved = Object.keys(fileMeta).some(checkpointPath =>
        transcriptPaths.some(transcriptPath =>
          path.resolve(checkpointPath) === path.resolve(transcriptPath))
        || sessionIds.has(path.basename(checkpointPath, '.jsonl')));
      const latestObservedAtMs = Math.max(
        ...sessionHints.map(hint => hint.observedAtMs ?? Number.POSITIVE_INFINITY),
      );
      if (!previouslyObserved && Date.now() - latestObservedAtMs <= HOOK_ORPHAN_GRACE_MS) {
        // WorkBuddy may invoke the Hook just before it creates the transcript.
        continue;
      }

      try {
        await fs.rm(sessionDir, { recursive: true, force: true });
        removedSessionDirs.add(sessionDir);
      } catch {
        continue;
      }
    }

    return hints.filter(hint => !removedSessionDirs.has(hint.sessionDir));
  }

  private async removeDeletedTranscriptCheckpoints(
    transcriptScanComplete: boolean,
    offsets: Record<string, number>,
    fileMeta: Record<string, TranscriptFileMeta>,
  ): Promise<void> {
    if (!transcriptScanComplete) return;
    for (const transcriptPath of new Set([
      ...Object.keys(offsets),
      ...Object.keys(fileMeta),
    ])) {
      try {
        await fs.stat(transcriptPath);
      } catch (error) {
        if (!isNotFoundError(error)) continue;
        delete offsets[transcriptPath];
        delete fileMeta[transcriptPath];
      }
    }
  }

  private async removeEmptySessionDirs(sessionDirs: Set<string>): Promise<void> {
    for (const sessionDir of sessionDirs) {
      try {
        await fs.rmdir(sessionDir);
      } catch {
        // The directory still contains uncommitted events or became unavailable.
      }
    }
  }

  private async resolveTranscriptPaths(candidates: string[]): Promise<string[]> {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.root);
    } catch {
      return [];
    }

    const resolved = new Set<string>();
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate) || !candidate.endsWith('.jsonl')) continue;
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch {
        continue;
      }
      if (isPathWithin(realRoot, realCandidate)) resolved.add(realCandidate);
    }
    return [...resolved].sort();
  }

  private async resolveStopHints(hints: HookTranscriptHint[]): Promise<Map<string, number>> {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.root);
    } catch {
      return new Map();
    }

    const stops = new Map<string, number>();
    for (const hint of hints) {
      if (hint.eventName?.toLowerCase() !== 'stop' || hint.observedAtMs === undefined) continue;
      if (!path.isAbsolute(hint.transcriptPath) || !hint.transcriptPath.endsWith('.jsonl')) continue;
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(hint.transcriptPath);
      } catch {
        continue;
      }
      if (!isPathWithin(realRoot, realCandidate)) continue;
      stops.set(realCandidate, Math.max(stops.get(realCandidate) ?? 0, hint.observedAtMs));
    }
    return stops;
  }

  private async resolveHookEvents(
    hints: HookTranscriptHint[],
    transcriptPath: string,
    sessionId: string,
    afterMs: number,
    throughMs: number,
  ): Promise<WorkBuddyHookEvent[]> {
    const events: WorkBuddyHookEvent[] = [];
    for (const hint of hints) {
      if (!hint.eventName || hint.observedAtMs === undefined) continue;
      if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(hint.eventName)) {
        continue;
      }
      if (hint.observedAtMs <= afterMs || hint.observedAtMs > throughMs) continue;
      if (hint.sessionId && hint.sessionId !== sessionId) continue;
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(hint.transcriptPath);
      } catch {
        continue;
      }
      if (realCandidate !== transcriptPath) continue;
      events.push({
        eventName: hint.eventName,
        observedAtMs: hint.observedAtMs,
        sessionId: hint.sessionId,
        toolName: hint.toolName,
        toolCallId: hint.toolCallId,
      });
    }
    return events;
  }
}

async function readJsonlRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Promise<{ records: WorkBuddyRecord[]; nextOffset: number } | null> {
  if (startOffset >= endOffset) return { records: [], nextOffset: startOffset };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let content: Buffer;
  try {
    handle = await fs.open(filePath, 'r');
    content = Buffer.alloc(endOffset - startOffset);
    const { bytesRead } = await handle.read(content, 0, content.length, startOffset);
    content = content.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const records: WorkBuddyRecord[] = [];
  let lineStart = 0;
  let nextOffset = startOffset;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== 0x0a) continue;
    parseJsonlLine(content.subarray(lineStart, index), records);
    lineStart = index + 1;
    nextOffset = startOffset + lineStart;
  }
  if (lineStart < content.length) {
    const trailing = content.subarray(lineStart);
    if (parseJsonlLine(trailing, records)) {
      nextOffset = startOffset + content.length;
    }
  }
  return { records, nextOffset };
}

function parseJsonlLine(line: Buffer, records: WorkBuddyRecord[]): boolean {
  const text = line.toString('utf8').replace(/\r$/, '').trim();
  if (!text) return true;
  try {
    records.push(JSON.parse(text) as WorkBuddyRecord);
    return true;
  } catch {
    return false;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function compareEntriesByTime(a: AgentActivityEntry, b: AgentActivityEntry): number {
  const left = BigInt(a.time_unix_nano);
  const right = BigInt(b.time_unix_nano);
  if (left < right) return -1;
  if (left > right) return 1;
  // Supported Node.js versions provide a stable sort; preserve semantic builder order on ties.
  return 0;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizeOffsetMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [file, offset] of Object.entries(value as Record<string, unknown>)) {
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) out[file] = offset;
  }
  return out;
}

function normalizeFileMetaMap(value: unknown): Record<string, TranscriptFileMeta> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, TranscriptFileMeta> = {};
  for (const [file, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const meta = raw as Record<string, unknown>;
    if (
      typeof meta.size !== 'number'
      || !Number.isFinite(meta.size)
      || typeof meta.mtimeMs !== 'number'
      || !Number.isFinite(meta.mtimeMs)
    ) {
      continue;
    }
    out[file] = {
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      identity: typeof meta.identity === 'string' ? meta.identity : undefined,
      observedStopAtMs: typeof meta.observedStopAtMs === 'number'
        && Number.isFinite(meta.observedStopAtMs)
        ? meta.observedStopAtMs
        : 0,
      handledStopAtMs: typeof meta.handledStopAtMs === 'number'
        && Number.isFinite(meta.handledStopAtMs)
        ? meta.handledStopAtMs
        : 0,
    };
  }
  return out;
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${stat.dev}:${stat.ino}`;
}
