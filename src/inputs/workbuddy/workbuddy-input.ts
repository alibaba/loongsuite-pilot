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

const OFFSET_MAP_KEY = 'workbuddyTranscriptLines';
const INITIALIZED_KEY = 'workbuddyInitialized';

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
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const nextExtra = { ...(state.extra ?? {}) };
    nextExtra.workbuddySqliteCursor = undefined;
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const offsets = normalizeOffsetMap(state.extra?.[OFFSET_MAP_KEY]);
    const hookPaths = await this.readHookTranscriptPaths();
    const scannedPaths = await this.scanTranscriptFiles();
    const transcriptPaths = await this.resolveTranscriptPaths([...hookPaths, ...scannedPaths]);
    const nextOffsets: Record<string, number> = {};
    const entries: AgentActivityEntry[] = [];

    for (const transcriptPath of transcriptPaths) {
      const parsed = await readCompleteJsonl(transcriptPath);
      if (!parsed) continue;
      const sessionId = path.basename(transcriptPath, '.jsonl');
      const prior = offsets[transcriptPath];
      const baseline = !initialized && prior === undefined ? parsed.records.length : prior ?? 0;
      const built = await buildWorkBuddyEvents(parsed.records, {
        sessionId,
        minTerminalIndex: baseline,
      });
      entries.push(...built.map(item => item.entry));
      nextOffsets[transcriptPath] = parsed.records.length;
    }

    this.setState({
      extra: {
        ...nextExtra,
        [INITIALIZED_KEY]: true,
        [OFFSET_MAP_KEY]: nextOffsets,
      },
    });
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

  private async readHookTranscriptPaths(): Promise<string[]> {
    let names: string[];
    try { names = await fs.readdir(this.hookLogDir); } catch { return []; }
    const paths: string[] = [];
    for (const name of names.filter(name => /^wakeup-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-3)) {
      let text: string;
      try { text = await fs.readFile(path.join(this.hookLogDir, name), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          if (typeof record.transcript_path === 'string' && record.transcript_path.endsWith('.jsonl')) {
            paths.push(record.transcript_path);
          }
        } catch { /* structural hint only */ }
      }
    }
    return paths;
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
}

async function readCompleteJsonl(filePath: string): Promise<{ records: WorkBuddyRecord[] } | null> {
  let text: string;
  try { text = await fs.readFile(filePath, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  if (!text.endsWith('\n')) lines.pop();
  const records: WorkBuddyRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as WorkBuddyRecord); } catch { /* fail-open */ }
  }
  return { records };
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
