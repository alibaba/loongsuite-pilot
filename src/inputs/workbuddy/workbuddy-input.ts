import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { FSWatcher } from 'node:fs';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import { buildWorkBuddyEvents } from './workbuddy-event-builder.js';
import type { WorkBuddyRecord } from './workbuddy-types.js';

const OFFSET_MAP_KEY = 'workbuddyTranscriptBytes';
const FILE_META_MAP_KEY = 'workbuddyTranscriptFiles';
const INITIALIZED_KEY = 'workbuddyInitialized';
const STABILITY_RETRY_MS = 5_000;

interface HookTranscriptHint {
  transcriptPath: string;
  eventName?: string;
  observedAtMs?: number;
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
  hookLogDir?: string;
}

export class WorkBuddyInput extends BaseInput {
  readonly id = 'workbuddy';
  readonly agentType = ClientType.WorkBuddy;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly root: string;
  private readonly projectsDir: string;
  private readonly hookLogDir: string;
  private watchers: FSWatcher[] = [];
  private stabilityRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WorkBuddyInputOptions) {
    super(opts);
    this.root = opts.workBuddyRoot ?? path.join(homedir(), '.workbuddy');
    this.projectsDir = path.join(this.root, 'projects');
    this.hookLogDir = opts.hookLogDir ?? path.join(homedir(), '.loongsuite-pilot', 'logs', 'workbuddy');
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
    this.watchDirectory(this.projectsDir);
    this.watchDirectory(this.hookLogDir);
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
    const hookHints = await this.readHookTranscriptHints();
    const scannedPaths = await this.scanTranscriptFiles();
    const transcriptPaths = await this.resolveTranscriptPaths([
      ...hookHints.map(hint => hint.transcriptPath),
      ...scannedPaths,
    ]);
    const stopHints = await this.resolveStopHints(hookHints);
    const nextOffsets: Record<string, number> = {};
    const nextFileMeta: Record<string, TranscriptFileMeta> = {};
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
          const built = await buildWorkBuddyEvents(parsed.records, { sessionId });
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

  private async scanTranscriptFiles(): Promise<string[]> {
    let projectDirs: string[];
    try { projectDirs = await fs.readdir(this.projectsDir); } catch { return []; }
    const files: string[] = [];
    for (const projectDir of projectDirs) {
      const fullDir = path.join(this.projectsDir, projectDir);
      let names: string[];
      try { names = await fs.readdir(fullDir); } catch { continue; }
      for (const name of names) {
        if (name.endsWith('.jsonl')) files.push(path.join(fullDir, name));
      }
    }
    return files;
  }

  private async readHookTranscriptHints(): Promise<HookTranscriptHint[]> {
    let names: string[];
    try { names = await fs.readdir(this.hookLogDir); } catch { return []; }
    const hints: HookTranscriptHint[] = [];
    for (const name of names.filter(name => /^wakeup-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-3)) {
      let text: string;
      try { text = await fs.readFile(path.join(this.hookLogDir, name), 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.transcript_path === 'string' && record.transcript_path.endsWith('.jsonl')) {
            hints.push({
              transcriptPath: record.transcript_path,
              eventName: typeof record.hook_event_name === 'string'
                ? record.hook_event_name
                : undefined,
              observedAtMs: typeof record.observed_at_ms === 'number'
                && Number.isFinite(record.observed_at_ms)
                ? record.observed_at_ms
                : undefined,
            });
          }
        } catch { /* structural hint only */ }
      }
    }
    return hints;
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
