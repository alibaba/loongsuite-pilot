import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, readJsonFile, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { scanJsonlTail } from './jsonl-tail-reader.js';
import { LOCAL_LOG_EMERGENCY_FILE_BYTES } from '../utils/segmented-jsonl-writer.js';

const logger = createLogger('MetricsSummaryWriter');

const STARTUP_DELAY_MS = 5_000;
const DIGEST_MAX_DAYS = 200;
// Digests written before the breakdowns were persisted are rebuilt from their
// segments, but only inside retention's default window: older days are
// unlikely to still have every segment, and a bounded window keeps an upgrade
// from rescanning months of history.
const DIGEST_BACKFILL_DAYS = 7;
// Closed days keep per-file statistics (including session identities) for this
// many days, so late appends and rescans stay exact while segments are still
// on disk. Older days fold them into the day totals and keep only file
// identities and offsets.
const DIGEST_DETAIL_DAYS = 7;
const FILE_NAME_PATTERN = /^(.+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ── Public types (metrics-summary.json shape) ──

export interface MetricsSummaryRangeData {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalSessions: number;
  totalRequests: number;
  totalToolCalls: number;
  totalEvents: number;
  modelShares: ModelShareEntry[];
  agentShares: AgentShareEntry[];
  providerShares: ProviderShareEntry[];
  repoShares: RepoShareEntry[];
  /**
   * Days inside this range whose totals are known but whose per-dimension
   * breakdowns could not be reconstructed (the raw segment was removed before
   * the breakdowns were persisted). Present only when such a day exists.
   */
  incompleteBreakdownDays?: string[];
}

export interface ModelShareEntry {
  model: string;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  share: number;
}

export interface AgentShareEntry {
  agentType: string;
  sessions: number;
  events: number;
  tokens: number;
  share: number;
}

export interface ProviderShareEntry {
  provider: string;
  totalTokens: number;
  share: number;
}

export interface RepoShareEntry {
  repo: string;
  sessions: number;
  events: number;
}

export interface DailyPoint {
  day: string;
  value: number;
}

export interface MetricsSummary {
  version: number;
  generatedAt: string;
  packageVersion: string;
  ranges: {
    today: MetricsSummaryRangeData;
    sevenDays: MetricsSummaryRangeData;
    thirtyDays: MetricsSummaryRangeData;
  };
  dailyTokens: DailyPoint[];
  dailySessions: DailyPoint[];
}

// ── Internal types ──

interface DayStats {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessions: Set<string>;
  requests: number;
  toolCalls: number;
  events: number;
  modelTokens: Map<string, { total: number; input: number; cacheRead: number }>;
  agentStats: Map<string, { sessions: Set<string>; events: number; tokens: number }>;
  providerTokens: Map<string, number>;
  repoStats: Map<string, { sessions: Set<string>; events: number }>;
}

interface DayTotals {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessions: number;
  requests: number;
  toolCalls: number;
  events: number;
  /**
   * Per-dimension breakdowns, persisted so that multi-day ranges keep their
   * model / agent / provider / repository distribution after the raw JSONL
   * segments are dropped by log retention. Optional: digests written by older
   * versions do not carry them and are still readable.
   */
  modelTokens?: Record<string, ModelTokenDigest>;
  agentStats?: Record<string, AgentDigest>;
  providerTokens?: Record<string, number>;
  repoStats?: Record<string, RepoDigest>;
}

/**
 * A closed day. The top-level totals are always the whole day. They are the
 * sum of `base` and of every file that still carries `stats`:
 *
 * - `files` tracks each output segment by inode identity and offset, exactly
 *   like the current-day state. Rescanning a segment replaces only that
 *   segment's contribution, and a segment removed by retention keeps the
 *   contribution it already made.
 * - `base` holds what cannot be attributed to a tracked file: totals written
 *   by an older version, or files whose stats were folded in once the day left
 *   the detail window. When no file carries stats, `base` is the whole day
 *   and is not stored separately.
 *
 * A day without `files` was written by an older version and is migrated the
 * next time one of its segments is seen.
 */
interface DayDigest extends DayTotals {
  base?: DayTotals;
  files?: TrackedFileState[];
  /**
   * Set when a day written by an older version could not be rebuilt from its
   * remaining segments. The totals stay correct but the per-dimension
   * breakdowns for that day are knowingly incomplete.
   */
  breakdownsIncomplete?: true;
}

interface ModelTokenDigest {
  total: number;
  input: number;
  cacheRead: number;
}

interface AgentDigest {
  sessions: number;
  events: number;
  tokens: number;
}

interface RepoDigest {
  sessions: number;
  events: number;
}

interface DigestFile {
  version: number;
  days: Record<string, DayDigest>;
}

interface ScanState {
  files: Record<string, { offset: number; size: number; ino: number }>;
}

interface SerializedDayStats {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessions: string[];
  requests: number;
  toolCalls: number;
  events: number;
  modelTokens: Array<[string, { total: number; input: number; cacheRead: number }]>;
  agentStats: Array<[string, { sessions: string[]; events: number; tokens: number }]>;
  providerTokens: Array<[string, number]>;
  repoStats: Array<[string, { sessions: string[]; events: number }]>;
}

interface TrackedFileState {
  fileName: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  offset: number;
  size: number;
  /** Absent when this file's contribution lives in the day's `base`. */
  stats?: SerializedDayStats;
}

interface CurrentDayFileState extends TrackedFileState {
  stats: SerializedDayStats;
}

interface CurrentDayState {
  version: 1;
  day: string;
  files: CurrentDayFileState[];
}

// ── Class ──

export class MetricsSummaryWriter {
  private readonly dataDir: string;
  private readonly config: StatusBarConfig;
  private readonly outputDir: string;
  private readonly summaryPath: string;
  private readonly digestPath: string;
  private readonly scanStatePath: string;
  private readonly currentDayStatePath: string;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    dataDir: string,
    config: StatusBarConfig,
    outputDir: string = path.join(dataDir, 'logs', 'output'),
  ) {
    this.dataDir = dataDir;
    this.config = config;
    this.outputDir = outputDir;
    this.summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
    this.digestPath = path.join(dataDir, 'cache', 'metrics-daily-digest.json');
    this.scanStatePath = path.join(dataDir, 'cache', 'metrics-scan-state.json');
    this.currentDayStatePath = path.join(dataDir, 'cache', 'metrics-current-day-state.json');
  }

  start(): void {
    this.stopped = false;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.refresh();
      this.intervalTimer = setInterval(
        () => void this.refresh(),
        this.config.metricsSummaryIntervalMs,
      );
    }, STARTUP_DELAY_MS);

    logger.info('metrics summary writer scheduled', {
      intervalMs: this.config.metricsSummaryIntervalMs,
      outputDir: this.outputDir,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    await this.refreshPromise;
    logger.info('metrics summary writer stopped');
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.aggregate()
      .catch(err => {
        logger.warn('metrics summary refresh failed', { error: String(err) });
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async aggregate(): Promise<void> {
    const today = getTodayDateString();
    const scanState = await this.loadScanState();
    const digest = await this.loadDigest();
    const files = await this.listOutputFiles();
    let currentDayState = await this.loadCurrentDayState();

    // Finish the previous active day before starting a new one. The replacement
    // write is idempotent, so a crash between digest and state persistence cannot
    // double-count the day on restart. The per-file state moves into the digest
    // as is, so later appends to that day keep resuming from the same offsets.
    if (currentDayState && currentDayState.day !== today) {
      currentDayState = await this.refreshCurrentDayState(currentDayState, files);
      digest.days[currentDayState.day] = composeDay(undefined, currentDayState.files, false);
      this.copyCurrentDayOffsetsToScanState(currentDayState, scanState);
      currentDayState = null;
    }

    const filesByDay = new Map<string, string[]>();
    for (const file of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(file));
      if (!match || match[2] === today) continue;
      const dayFiles = filesByDay.get(match[2]);
      if (dayFiles) dayFiles.push(file);
      else filesByDay.set(match[2], [file]);
    }

    // Closed days resume each segment from its own offset; a segment seen for
    // the first time (new file, rotation into a new inode) is read from the
    // start and added, so neither a retired nor an untouched segment is lost.
    const listedDays = new Set<string>();
    for (const [day, dayFiles] of filesByDay) {
      listedDays.add(day);
      let entry: DayDigest | undefined = digest.days[day];
      if (entry && !entry.files) {
        entry = await this.migrateUntrackedDay(day, entry, dayFiles, scanState, today);
        digest.days[day] = entry;
      }
      const refreshed = await this.refreshTrackedFiles(day, entry?.files ?? [], dayFiles, true);
      if (entry && !refreshed.changed) continue;

      let base = entry ? baseOf(entry) : undefined;
      if (refreshed.detached) base = addTotals(base, dayStatsToTotals(refreshed.detached));
      digest.days[day] = composeDay(base, refreshed.files, entry?.breakdownsIncomplete);
      for (const file of refreshed.files) {
        if (file.fileName.startsWith('retired:')) continue;
        scanState.files[file.fileName] = { offset: file.offset, size: file.size, ino: file.ino };
      }
    }

    this.compactDigest(digest, listedDays, today);

    currentDayState ??= {
      version: 1,
      day: today,
      files: [],
    };
    currentDayState = await this.refreshCurrentDayState(currentDayState, files);
    const todayLive = mergeCurrentDayStats(currentDayState);

    // Prune old digest entries
    this.pruneDigest(digest, today);

    // Build summary from digest + live data
    const summary = this.buildSummary(digest, todayLive, today);

    // Persist source-of-truth before the derived summary. Each state file is
    // written atomically; after a crash, replay starts from the last committed
    // offset and produces the same summary without double-counting.
    await ensureDir(path.dirname(this.digestPath));
    await ensureDir(path.dirname(this.summaryPath));
    await writeJsonFile(this.digestPath, digest);
    await writeJsonFile(this.scanStatePath, scanState);
    await writeJsonFile(this.currentDayStatePath, currentDayState);
    await writeJsonFile(this.summaryPath, summary);

    logger.debug('metrics summary written', {
      totalTokensToday: summary.ranges.today.totalTokens,
      sessionsToday: summary.ranges.today.totalSessions,
    });
  }

  private async listOutputFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.outputDir);
      return entries
        .filter(e => e.endsWith('.jsonl'))
        .map(e => path.join(this.outputDir, e));
    } catch {
      return [];
    }
  }

  private async safeStat(filePath: string): Promise<fsSync.Stats | null> {
    try {
      return await fs.stat(filePath);
    } catch {
      return null;
    }
  }

  private skipOversizedOutput(filePath: string, stat: fsSync.Stats): boolean {
    if (stat.size <= LOCAL_LOG_EMERGENCY_FILE_BYTES) return false;
    // Avoid holding an unlinked legacy giant open while retention reclaims it.
    // Already-observed current-day state and historical digests stay intact.
    logger.warn('metrics summary skipped oversized output file', {
      file: path.basename(filePath), bytes: stat.size, maxBytes: LOCAL_LOG_EMERGENCY_FILE_BYTES,
    });
    return true;
  }

  /**
   * Resume every listed segment of `day` from the state tracked for its inode.
   * A file whose identity is unknown is read from the start as a new
   * contribution. Entries that are not listed this time are kept: their
   * contribution was already observed and must not be retracted.
   *
   * Entries without `stats` belong to the day's `base`; whatever is read for
   * them is returned as `detached` so the caller can add it to that base.
   */
  private async refreshTrackedFiles(
    day: string,
    tracked: TrackedFileState[],
    files: string[],
    skipUnchanged: boolean,
  ): Promise<{
    files: TrackedFileState[];
    detached: DayStats | null;
    bytesRead: number;
    changed: boolean;
  }> {
    const existingByIdentity = new Map(tracked.map(file => [fileIdentity(file), file]));
    const nextByIdentity = new Map(existingByIdentity);
    let detached: DayStats | null = null;
    let bytesRead = 0;
    let changed = false;

    for (const filePath of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(filePath));
      if (!match || match[2] !== day) continue;

      const fileStat = await this.safeStat(filePath);
      if (!fileStat) continue;
      if (this.skipOversizedOutput(filePath, fileStat)) continue;

      const fileName = path.basename(filePath);
      const identity = fileIdentity(fileStat);
      // Keep previously counted data even if retention removed the rotated
      // inode before this refresh could observe its archive name. A later
      // reappearance of that inode still resumes the same cached statistics.
      const existing = existingByIdentity.get(identity);
      for (const [key, previous] of nextByIdentity) {
        if (key !== identity && previous.fileName === fileName) {
          nextByIdentity.set(key, { ...previous, fileName: `retired:${key}` });
          changed = true;
        }
      }
      const canResume = existing !== undefined
        && sameFileIdentity(existing, fileStat)
        && existing.offset <= fileStat.size
        && existing.size <= fileStat.size;
      if (skipUnchanged && canResume && existing.offset === fileStat.size) {
        if (existing.fileName !== fileName || existing.size !== fileStat.size) {
          nextByIdentity.set(identity, { ...existing, fileName, size: fileStat.size });
          changed = true;
        }
        continue;
      }
      const startOffset = canResume ? existing.offset : 0;
      // In-place truncation starts a new read range without retracting events
      // already observed, just as deleting a closed segment does not.
      const attached = !existing || existing.stats !== undefined;
      let stats: DayStats;
      if (attached) {
        stats = existing?.stats ? deserializeDayStats(existing.stats) : createDayStats();
      } else {
        detached ??= createDayStats();
        stats = detached;
      }
      const result = await scanJsonlTail(filePath, startOffset, fileStat.size, {
        expectedFileIdentity: fileStat,
        onRecord: record => {
          this.applyRecord(record as Record<string, string>, stats);
        },
      });
      bytesRead += result.bytesRead;
      changed = true;

      const next: TrackedFileState = {
        fileName,
        dev: fileStat.dev,
        ino: fileStat.ino,
        birthtimeMs: fileStat.birthtimeMs,
        offset: result.nextOffset,
        size: fileStat.size,
      };
      if (attached) next.stats = serializeDayStats(stats);
      nextByIdentity.set(identity, next);
    }

    return {
      files: Array.from(nextByIdentity.values())
        .sort((left, right) => left.fileName.localeCompare(right.fileName)),
      detached,
      bytesRead,
      changed,
    };
  }

  /**
   * Convert a day written by an older version (totals, maybe breakdowns, but no
   * per-file state) into a tracked day without losing or double counting
   * anything.
   *
   * The old scan state says how far each segment had been folded into the
   * legacy totals. Bytes past that offset are new and always added. When the
   * day lacks breakdowns and is recent, the bytes before the offset are read
   * too: if they reproduce the legacy totals exactly, no segment was retired
   * and the rebuilt per-file state replaces the day. Otherwise the legacy
   * totals stay as the day's base and the breakdown is flagged incomplete.
   */
  private async migrateUntrackedDay(
    day: string,
    legacy: DayDigest,
    files: string[],
    scanState: ScanState,
    today: string,
  ): Promise<DayDigest> {
    const legacyTotals = totalsOf(legacy);
    const incompleteBefore = !!legacy.breakdownsIncomplete
      || (legacy.tokens > 0 && !legacy.modelTokens && !legacy.agentStats);

    // Scan-state entries of this day, including segments retention already
    // removed. Their presence means the scan state covered this day, so a
    // listed segment it does not know is genuinely new rather than forgotten.
    const cachedByName = new Map<string, ScanState['files'][string]>();
    const cachedByIno = new Map<number, ScanState['files'][string]>();
    for (const [name, cached] of Object.entries(scanState.files)) {
      if (FILE_NAME_PATTERN.exec(name)?.[2] !== day) continue;
      cachedByName.set(name, cached);
      cachedByIno.set(cached.ino, cached);
    }
    const trustScanState = cachedByName.size > 0;
    const rebuild = trustScanState
      && incompleteBefore
      && day >= dateDaysAgo(DIGEST_BACKFILL_DAYS, today);

    const head = createDayStats();
    const whole = createDayStats();
    const scanned: Array<{ file: TrackedFileState; head: DayStats; tail: DayStats }> = [];
    for (const filePath of files) {
      const fileStat = await this.safeStat(filePath);
      if (!fileStat) continue;
      if (this.skipOversizedOutput(filePath, fileStat)) continue;
      const fileName = path.basename(filePath);

      // A rotated segment keeps its inode under its archive name.
      const byName = cachedByName.get(fileName);
      const candidate = byName && byName.ino === fileStat.ino ? byName : cachedByIno.get(fileStat.ino);
      const cached = candidate && candidate.offset <= fileStat.size && candidate.size <= fileStat.size
        ? candidate
        : undefined;
      // Without a trusted scan state every byte may already be in the legacy
      // totals, so the whole file is read and compared below.
      const knownOffset = trustScanState ? (cached?.offset ?? 0) : 0;

      const fileHead = createDayStats();
      const fileTail = createDayStats();
      const scan = (start: number, end: number, stats: DayStats) => scanJsonlTail(filePath, start, end, {
        expectedFileIdentity: fileStat,
        onRecord: record => this.applyRecord(record as Record<string, string>, stats),
      });
      let tailStart = knownOffset;
      if (rebuild && knownOffset > 0) tailStart = (await scan(0, knownOffset, fileHead)).nextOffset;
      const result = await scan(tailStart, fileStat.size, fileTail);
      mergeDayStats(head, fileHead);
      mergeDayStats(whole, fileHead);
      mergeDayStats(whole, fileTail);

      scanned.push({
        file: {
          fileName,
          dev: fileStat.dev,
          ino: fileStat.ino,
          birthtimeMs: fileStat.birthtimeMs,
          offset: result.nextOffset,
          size: fileStat.size,
        },
        head: fileHead,
        tail: fileTail,
      });
    }

    const withStats = (pick: (item: typeof scanned[number]) => DayStats | null) => scanned.map(item => {
      const stats = pick(item);
      return stats && stats.events > 0 ? { ...item.file, stats: serializeDayStats(stats) } : item.file;
    });
    const wholeFile = (item: typeof scanned[number]) => {
      const stats = createDayStats();
      mergeDayStats(stats, item.head);
      mergeDayStats(stats, item.tail);
      return stats;
    };

    if (!trustScanState) {
      // Nothing says which bytes the legacy totals already include. A rescan
      // that reaches them covers the day; one that falls short means segments
      // were retired, and only the legacy totals are known to be right.
      if (whole.tokens >= legacy.tokens && whole.events >= legacy.events) {
        logger.info('metrics digest day rebuilt from its segments', { day });
        return composeDay(undefined, withStats(wholeFile), false);
      }
      logger.info('metrics digest day kept with incomplete breakdowns', { day });
      return composeDay(legacyTotals, withStats(() => null), incompleteBefore);
    }

    if (rebuild && head.tokens === legacy.tokens && head.events === legacy.events) {
      logger.info('metrics digest day rebuilt from its segments', { day });
      return composeDay(undefined, withStats(wholeFile), false);
    }
    if (rebuild) logger.info('metrics digest day kept with incomplete breakdowns', { day });
    return composeDay(legacyTotals, withStats(item => item.tail), incompleteBefore);
  }

  /**
   * Days that left the detail window keep their totals and breakdowns but drop
   * per-file stats, which carry every session identity. File identities stay,
   * so a late append still resumes from its offset. Once none of a day's
   * segments is listed any more, the identities go too.
   */
  private compactDigest(digest: DigestFile, listedDays: Set<string>, today: string): void {
    const cutoff = dateDaysAgo(DIGEST_DETAIL_DAYS, today);
    for (const [day, entry] of Object.entries(digest.days)) {
      if (day >= cutoff || !entry.files) continue;
      const files = listedDays.has(day) ? entry.files : [];
      if (files.length === entry.files.length && !entry.files.some(file => file.stats)) continue;
      const compacted: DayDigest = {
        ...totalsOf(entry),
        files: files.map(({ stats: _stats, ...file }) => file),
      };
      if (entry.breakdownsIncomplete) compacted.breakdownsIncomplete = true;
      digest.days[day] = compacted;
    }
  }

  private async refreshCurrentDayState(
    state: CurrentDayState,
    files: string[],
  ): Promise<CurrentDayState> {
    const refreshed = await this.refreshTrackedFiles(state.day, state.files, files, false);

    logger.debug('metrics current-day files refreshed', {
      day: state.day,
      fileCount: refreshed.files.length,
      bytesRead: refreshed.bytesRead,
    });

    return {
      version: 1,
      day: state.day,
      // Current-day entries are never detached from their stats.
      files: refreshed.files as CurrentDayFileState[],
    };
  }

  private copyCurrentDayOffsetsToScanState(
    state: CurrentDayState,
    scanState: ScanState,
  ): void {
    for (const file of state.files) {
      scanState.files[file.fileName] = {
        offset: file.offset,
        size: file.size,
        ino: file.ino,
      };
    }
  }

  private applyRecord(record: Record<string, string>, stats: DayStats): void {
    stats.events++;

    const eventName = record['event.name'] ?? '';
    const sessionId = record['gen_ai.session.id'];
    const agentType = record['gen_ai.agent.type'] ?? 'unknown';

    if (sessionId) {
      stats.sessions.add(sessionId);
    }

    // Agent stats
    let agent = stats.agentStats.get(agentType);
    if (!agent) {
      agent = { sessions: new Set(), events: 0, tokens: 0 };
      stats.agentStats.set(agentType, agent);
    }
    agent.events++;
    if (sessionId) agent.sessions.add(sessionId);

    // Repo stats
    const repo = record['git.repo'];
    if (repo) {
      let repoEntry = stats.repoStats.get(repo);
      if (!repoEntry) {
        repoEntry = { sessions: new Set(), events: 0 };
        stats.repoStats.set(repo, repoEntry);
      }
      repoEntry.events++;
      if (sessionId) repoEntry.sessions.add(sessionId);
    }

    if (eventName === 'llm.request' || eventName === 'gen_ai.model.request') {
      stats.requests++;
    }

    if (eventName === 'tool.call' || eventName === 'gen_ai.tool.call') {
      stats.toolCalls++;
    }

    if (eventName === 'llm.response' || eventName === 'gen_ai.model.response') {
      const inputTokens = toNumber(record['gen_ai.usage.input_tokens']);
      const outputTokens = toNumber(record['gen_ai.usage.output_tokens']);
      const cacheReadTokens = toNumber(record['gen_ai.usage.cache_read.input_tokens']);
      const cacheCreationTokens = toNumber(record['gen_ai.usage.cache_creation.input_tokens']);
      const totalTokens = toNumber(record['gen_ai.usage.total_tokens']);

      // input_tokens already includes cache_read and cache_creation (they are subsets, not additive)
      // total_tokens = input_tokens + output_tokens
      const effectiveTotal = totalTokens > 0
        ? totalTokens
        : inputTokens + outputTokens;

      stats.tokens += effectiveTotal;
      stats.inputTokens += inputTokens;
      stats.outputTokens += outputTokens;
      stats.cacheReadTokens += cacheReadTokens;
      stats.cacheCreationTokens += cacheCreationTokens;

      agent.tokens += effectiveTotal;

      // Model breakdown
      const model = record['gen_ai.request.model'] ?? record['gen_ai.response.model'] ?? 'unknown';
      let modelEntry = stats.modelTokens.get(model);
      if (!modelEntry) {
        modelEntry = { total: 0, input: 0, cacheRead: 0 };
        stats.modelTokens.set(model, modelEntry);
      }
      modelEntry.total += effectiveTotal;
      modelEntry.input += inputTokens;
      modelEntry.cacheRead += cacheReadTokens;

      // Provider breakdown
      const provider = record['gen_ai.provider.name'] ?? 'unknown';
      stats.providerTokens.set(provider, (stats.providerTokens.get(provider) ?? 0) + effectiveTotal);
    }
  }

  private pruneDigest(digest: DigestFile, today: string): void {
    const cutoff = dateDaysAgo(DIGEST_MAX_DAYS, today);
    for (const day of Object.keys(digest.days)) {
      if (day < cutoff) {
        delete digest.days[day];
      }
    }
  }

  private buildSummary(
    digest: DigestFile,
    todayLive: DayStats | undefined,
    today: string,
  ): MetricsSummary {
    const todayDigest = digest.days[today];
    const packageVersion = this.readPackageVersion();

    const rangeToday = this.buildRangeData(
      [today],
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );
    const range7 = this.buildRangeData(
      daysInRange(7, today),
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );
    const range30 = this.buildRangeData(
      daysInRange(30, today),
      digest,
      todayLive ? new Map([[today, todayLive]]) : new Map(),
      today,
    );

    const dailyTokens = this.buildDailyPoints(daysInRange(30, today), digest, todayLive, today, 'tokens');
    const dailySessions = this.buildDailyPoints(daysInRange(30, today), digest, todayLive, today, 'sessions');

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      packageVersion,
      ranges: {
        today: rangeToday,
        sevenDays: range7,
        thirtyDays: range30,
      },
      dailyTokens,
      dailySessions,
    };
  }

  private buildRangeData(
    days: string[],
    digest: DigestFile,
    liveStats: Map<string, DayStats>,
    today: string,
  ): MetricsSummaryRangeData {
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let totalSessions = 0;
    let totalRequests = 0;
    let totalToolCalls = 0;
    let totalEvents = 0;
    const modelMap = new Map<string, { total: number; input: number; cacheRead: number }>();
    const agentMap = new Map<string, { sessions: number; events: number; tokens: number }>();
    const providerMap = new Map<string, number>();
    const repoMap = new Map<string, { sessions: number; events: number }>();
    // Days whose totals are counted but whose breakdown could not be rebuilt.
    // Surfaced to callers instead of pretending the shares are complete.
    const incompleteBreakdownDays: string[] = [];

    for (const day of days) {
      const live = liveStats.get(day);
      if (day === today && live) {
        totalTokens += live.tokens;
        inputTokens += live.inputTokens;
        outputTokens += live.outputTokens;
        cacheReadTokens += live.cacheReadTokens;
        cacheCreationTokens += live.cacheCreationTokens;
        totalSessions += live.sessions.size;
        totalRequests += live.requests;
        totalToolCalls += live.toolCalls;
        totalEvents += live.events;

        for (const [model, data] of live.modelTokens) {
          const m = modelMap.get(model) ?? { total: 0, input: 0, cacheRead: 0 };
          m.total += data.total;
          m.input += data.input;
          m.cacheRead += data.cacheRead;
          modelMap.set(model, m);
        }

        for (const [at, data] of live.agentStats) {
          const a = agentMap.get(at) ?? { sessions: 0, events: 0, tokens: 0 };
          a.sessions += data.sessions.size;
          a.events += data.events;
          a.tokens += data.tokens;
          agentMap.set(at, a);
        }

        for (const [provider, tokens] of live.providerTokens) {
          providerMap.set(provider, (providerMap.get(provider) ?? 0) + tokens);
        }

        for (const [repo, data] of live.repoStats) {
          const r = repoMap.get(repo) ?? { sessions: 0, events: 0 };
          r.sessions += data.sessions.size;
          r.events += data.events;
          repoMap.set(repo, r);
        }
      } else {
        const d = digest.days[day];
        if (!d) continue;
        // A day with tokens but no persisted breakdown cannot contribute its
        // per-dimension share — say so instead of silently shrinking the shares.
        if (d.breakdownsIncomplete || (!d.files && d.tokens > 0 && !d.modelTokens && !d.agentStats)) {
          incompleteBreakdownDays.push(day);
        }
        totalTokens += d.tokens;
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        cacheReadTokens += d.cacheReadTokens;
        cacheCreationTokens += d.cacheCreationTokens;
        totalSessions += d.sessions;
        totalRequests += d.requests;
        totalToolCalls += d.toolCalls;
        totalEvents += d.events;

        // Replay the persisted breakdowns of an already-closed day so that
        // 7-day / 30-day ranges keep their distribution, not just the totals.
        for (const [model, data] of Object.entries(d.modelTokens ?? {})) {
          const m = modelMap.get(model) ?? { total: 0, input: 0, cacheRead: 0 };
          m.total += data.total;
          m.input += data.input;
          m.cacheRead += data.cacheRead;
          modelMap.set(model, m);
        }

        for (const [agentType, data] of Object.entries(d.agentStats ?? {})) {
          const a = agentMap.get(agentType) ?? { sessions: 0, events: 0, tokens: 0 };
          a.sessions += data.sessions;
          a.events += data.events;
          a.tokens += data.tokens;
          agentMap.set(agentType, a);
        }

        for (const [provider, tokens] of Object.entries(d.providerTokens ?? {})) {
          providerMap.set(provider, (providerMap.get(provider) ?? 0) + tokens);
        }

        for (const [repo, data] of Object.entries(d.repoStats ?? {})) {
          const r = repoMap.get(repo) ?? { sessions: 0, events: 0 };
          r.sessions += data.sessions;
          r.events += data.events;
          repoMap.set(repo, r);
        }
      }
    }

    const modelShares = buildModelShares(modelMap, totalTokens);
    const agentShares = buildAgentShares(agentMap, totalEvents);
    const providerShares = buildProviderShares(providerMap, totalTokens);
    const repoShares = buildRepoShares(repoMap);

    return {
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalSessions,
      totalRequests,
      totalToolCalls,
      totalEvents,
      modelShares,
      agentShares,
      providerShares,
      repoShares,
      ...(incompleteBreakdownDays.length > 0
        ? { incompleteBreakdownDays: incompleteBreakdownDays.sort() }
        : {}),
    };
  }

  private buildDailyPoints(
    days: string[],
    digest: DigestFile,
    todayLive: DayStats | undefined,
    today: string,
    metric: 'tokens' | 'sessions',
  ): DailyPoint[] {
    return days.map(day => {
      if (day === today && todayLive) {
        return {
          day,
          value: metric === 'tokens' ? todayLive.tokens : todayLive.sessions.size,
        };
      }
      const d = digest.days[day];
      return {
        day,
        value: d ? (metric === 'tokens' ? d.tokens : d.sessions) : 0,
      };
    });
  }

  private readPackageVersion(): string {
    try {
      const versionFile = path.join(this.dataDir, 'package', 'VERSION');
      if (fsSync.existsSync(versionFile)) {
        const content = fsSync.readFileSync(versionFile, 'utf8');
        const match = content.match(/^version=(.+)$/m);
        if (match) return match[1].trim();
      }

      const currentFile = path.join(this.dataDir, 'current');
      if (fsSync.existsSync(currentFile)) {
        const current = fsSync.readFileSync(currentFile, 'utf8').trim();
        if (current) {
          const vf = path.join(this.dataDir, 'versions', current, 'VERSION');
          if (fsSync.existsSync(vf)) {
            const content = fsSync.readFileSync(vf, 'utf8');
            const match = content.match(/^version=(.+)$/m);
            if (match) return match[1].trim();
          }
        }
      }
    } catch {
      // ignore
    }
    return 'unknown';
  }

  private async loadScanState(): Promise<ScanState> {
    const data = await readJsonFile<ScanState>(this.scanStatePath);
    return data && data.files ? data : { files: {} };
  }

  private async loadDigest(): Promise<DigestFile> {
    const data = await readJsonFile<DigestFile>(this.digestPath);
    if (!data || !data.days || typeof data.days !== 'object') return { version: 1, days: {} };
    for (const [day, entry] of Object.entries(data.days)) {
      if (!entry || typeof entry !== 'object') {
        delete data.days[day];
        continue;
      }
      if (entry.files !== undefined) data.days[day] = sanitizeDayDigest(entry);
    }
    return data;
  }

  private async loadCurrentDayState(): Promise<CurrentDayState | null> {
    const data = await readJsonFile<CurrentDayState>(this.currentDayStatePath);
    if (!data
      || data.version !== 1
      || typeof data.day !== 'string'
      || !Array.isArray(data.files)) {
      return null;
    }

    try {
      for (const file of data.files) {
        if (!file
          || typeof file.fileName !== 'string'
          || !Number.isFinite(file.dev)
          || !Number.isFinite(file.ino)
          || !Number.isFinite(file.birthtimeMs)
          || !Number.isFinite(file.offset)
          || file.offset < 0
          || !Number.isFinite(file.size)
          || file.size < 0) {
          return null;
        }
        deserializeDayStats(file.stats);
      }
      return data;
    } catch {
      logger.warn('metrics current-day state is invalid; rebuilding');
      return null;
    }
  }
}

// ── Helpers ──

function createDayStats(): DayStats {
  return {
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    sessions: new Set(),
    requests: 0,
    toolCalls: 0,
    events: 0,
    modelTokens: new Map(),
    agentStats: new Map(),
    providerTokens: new Map(),
    repoStats: new Map(),
  };
}

function serializeDayStats(stats: DayStats): SerializedDayStats {
  return {
    tokens: stats.tokens,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    sessions: Array.from(stats.sessions).sort(),
    requests: stats.requests,
    toolCalls: stats.toolCalls,
    events: stats.events,
    modelTokens: Array.from(stats.modelTokens.entries())
      .sort(([left], [right]) => left.localeCompare(right)),
    agentStats: Array.from(stats.agentStats.entries())
      .map(([agentType, data]) => [
        agentType,
        {
          sessions: Array.from(data.sessions).sort(),
          events: data.events,
          tokens: data.tokens,
        },
      ] as [string, { sessions: string[]; events: number; tokens: number }])
      .sort(([left], [right]) => left.localeCompare(right)),
    providerTokens: Array.from(stats.providerTokens.entries())
      .sort(([left], [right]) => left.localeCompare(right)),
    repoStats: Array.from(stats.repoStats.entries())
      .map(([repo, data]) => [
        repo,
        {
          sessions: Array.from(data.sessions).sort(),
          events: data.events,
        },
      ] as [string, { sessions: string[]; events: number }])
      .sort(([left], [right]) => left.localeCompare(right)),
  };
}

function deserializeDayStats(serialized: SerializedDayStats): DayStats {
  if (!serialized
    || !Array.isArray(serialized.sessions)
    || !Array.isArray(serialized.modelTokens)
    || !Array.isArray(serialized.agentStats)
    || !Array.isArray(serialized.providerTokens)
    || !Array.isArray(serialized.repoStats)) {
    throw new Error('invalid serialized day stats');
  }

  const stats = createDayStats();
  stats.tokens = finiteNumber(serialized.tokens);
  stats.inputTokens = finiteNumber(serialized.inputTokens);
  stats.outputTokens = finiteNumber(serialized.outputTokens);
  stats.cacheReadTokens = finiteNumber(serialized.cacheReadTokens);
  stats.cacheCreationTokens = finiteNumber(serialized.cacheCreationTokens);
  stats.sessions = new Set(serialized.sessions.filter(value => typeof value === 'string'));
  stats.requests = finiteNumber(serialized.requests);
  stats.toolCalls = finiteNumber(serialized.toolCalls);
  stats.events = finiteNumber(serialized.events);

  for (const item of serialized.modelTokens) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[1]) continue;
    stats.modelTokens.set(item[0], {
      total: finiteNumber(item[1].total),
      input: finiteNumber(item[1].input),
      cacheRead: finiteNumber(item[1].cacheRead),
    });
  }
  for (const item of serialized.agentStats) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[1]) continue;
    stats.agentStats.set(item[0], {
      sessions: new Set(
        Array.isArray(item[1].sessions)
          ? item[1].sessions.filter(value => typeof value === 'string')
          : [],
      ),
      events: finiteNumber(item[1].events),
      tokens: finiteNumber(item[1].tokens),
    });
  }
  for (const item of serialized.providerTokens) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
    stats.providerTokens.set(item[0], finiteNumber(item[1]));
  }
  for (const item of serialized.repoStats) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[1]) continue;
    stats.repoStats.set(item[0], {
      sessions: new Set(
        Array.isArray(item[1].sessions)
          ? item[1].sessions.filter(value => typeof value === 'string')
          : [],
      ),
      events: finiteNumber(item[1].events),
    });
  }
  return stats;
}

function mergeCurrentDayStats(state: CurrentDayState): DayStats {
  const merged = createDayStats();
  for (const file of state.files) {
    mergeDayStats(merged, deserializeDayStats(file.stats));
  }
  return merged;
}

function mergeDayStats(target: DayStats, source: DayStats): void {
  target.tokens += source.tokens;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.requests += source.requests;
  target.toolCalls += source.toolCalls;
  target.events += source.events;
  for (const session of source.sessions) target.sessions.add(session);

  for (const [model, data] of source.modelTokens) {
    const current = target.modelTokens.get(model) ?? { total: 0, input: 0, cacheRead: 0 };
    current.total += data.total;
    current.input += data.input;
    current.cacheRead += data.cacheRead;
    target.modelTokens.set(model, current);
  }
  for (const [agentType, data] of source.agentStats) {
    const current = target.agentStats.get(agentType) ?? {
      sessions: new Set<string>(),
      events: 0,
      tokens: 0,
    };
    current.events += data.events;
    current.tokens += data.tokens;
    for (const session of data.sessions) current.sessions.add(session);
    target.agentStats.set(agentType, current);
  }
  for (const [provider, tokens] of source.providerTokens) {
    target.providerTokens.set(provider, (target.providerTokens.get(provider) ?? 0) + tokens);
  }
  for (const [repo, data] of source.repoStats) {
    const current = target.repoStats.get(repo) ?? {
      sessions: new Set<string>(),
      events: 0,
    };
    current.events += data.events;
    for (const session of data.sessions) current.sessions.add(session);
    target.repoStats.set(repo, current);
  }
}

function sameFileIdentity(file: TrackedFileState, stat: fsSync.Stats): boolean {
  return file.dev === stat.dev
    && file.ino === stat.ino
    && file.birthtimeMs === stat.birthtimeMs;
}

function fileIdentity(file: Pick<TrackedFileState, 'dev' | 'ino' | 'birthtimeMs'>): string {
  return `${file.dev}:${file.ino}:${file.birthtimeMs}`;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function dateDaysAgo(days: number, reference: string): string {
  const d = new Date(reference + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return formatDate(d);
}

function daysInRange(count: number, today: string): string[] {
  const result: string[] = [];
  const base = new Date(today + 'T00:00:00');
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    result.push(formatDate(d));
  }
  return result;
}

function formatDate(d: Date): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Accumulators keyed by strings that come straight from telemetry, so they must
 * not inherit object properties: a model called `constructor` would otherwise
 * resolve to `Object` and turn a numeric accumulator into a function.
 */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function mapToRecord<V, T>(map: Map<string, V>, convert: (value: V) => T): Record<string, T> | undefined {
  if (map.size === 0) return undefined;
  const record = emptyRecord<T>();
  for (const [key, value] of map) record[key] = convert(value);
  return record;
}

function mergeRecords<T>(
  left: Record<string, T> | undefined,
  right: Record<string, T> | undefined,
  add: (a: T, b: T) => T,
): Record<string, T> | undefined {
  if (!left && !right) return undefined;
  const merged = emptyRecord<T>();
  for (const [key, value] of Object.entries(left ?? {})) merged[key] = value;
  for (const [key, value] of Object.entries(right ?? {})) {
    const current = merged[key];
    merged[key] = current === undefined ? value : add(current, value);
  }
  return merged;
}

function dayStatsToTotals(stats: DayStats): DayTotals {
  const totals: DayTotals = {
    tokens: stats.tokens,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cacheReadTokens: stats.cacheReadTokens,
    cacheCreationTokens: stats.cacheCreationTokens,
    sessions: stats.sessions.size,
    requests: stats.requests,
    toolCalls: stats.toolCalls,
    events: stats.events,
  };
  const modelTokens = mapToRecord(stats.modelTokens, data => ({
    total: data.total, input: data.input, cacheRead: data.cacheRead,
  }));
  if (modelTokens) totals.modelTokens = modelTokens;
  const agentStats = mapToRecord(stats.agentStats, data => ({
    sessions: data.sessions.size, events: data.events, tokens: data.tokens,
  }));
  if (agentStats) totals.agentStats = agentStats;
  const providerTokens = mapToRecord(stats.providerTokens, tokens => tokens);
  if (providerTokens) totals.providerTokens = providerTokens;
  const repoStats = mapToRecord(stats.repoStats, data => ({
    sessions: data.sessions.size, events: data.events,
  }));
  if (repoStats) totals.repoStats = repoStats;
  return totals;
}

/** Only the day totals of a digest entry, without its tracking state. */
function totalsOf(day: DayTotals): DayTotals {
  const totals: DayTotals = {
    tokens: finiteNumber(day.tokens),
    inputTokens: finiteNumber(day.inputTokens),
    outputTokens: finiteNumber(day.outputTokens),
    cacheReadTokens: finiteNumber(day.cacheReadTokens),
    cacheCreationTokens: finiteNumber(day.cacheCreationTokens),
    sessions: finiteNumber(day.sessions),
    requests: finiteNumber(day.requests),
    toolCalls: finiteNumber(day.toolCalls),
    events: finiteNumber(day.events),
  };
  if (day.modelTokens) totals.modelTokens = day.modelTokens;
  if (day.agentStats) totals.agentStats = day.agentStats;
  if (day.providerTokens) totals.providerTokens = day.providerTokens;
  if (day.repoStats) totals.repoStats = day.repoStats;
  return totals;
}

/**
 * Session counts add up here: the two sides have no identities in common to
 * deduplicate against. Identities are only compared inside per-file stats.
 */
function addTotals(left: DayTotals | undefined, right: DayTotals): DayTotals {
  if (!left) return right;
  const totals: DayTotals = {
    tokens: left.tokens + right.tokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    sessions: left.sessions + right.sessions,
    requests: left.requests + right.requests,
    toolCalls: left.toolCalls + right.toolCalls,
    events: left.events + right.events,
  };
  const modelTokens = mergeRecords(left.modelTokens, right.modelTokens, (a, b) => ({
    total: a.total + b.total, input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead,
  }));
  if (modelTokens) totals.modelTokens = modelTokens;
  const agentStats = mergeRecords(left.agentStats, right.agentStats, (a, b) => ({
    sessions: a.sessions + b.sessions, events: a.events + b.events, tokens: a.tokens + b.tokens,
  }));
  if (agentStats) totals.agentStats = agentStats;
  const providerTokens = mergeRecords(left.providerTokens, right.providerTokens, (a, b) => a + b);
  if (providerTokens) totals.providerTokens = providerTokens;
  const repoStats = mergeRecords(left.repoStats, right.repoStats, (a, b) => ({
    sessions: a.sessions + b.sessions, events: a.events + b.events,
  }));
  if (repoStats) totals.repoStats = repoStats;
  return totals;
}

function isEmptyTotals(totals: DayTotals): boolean {
  return totals.events === 0
    && totals.tokens === 0
    && totals.sessions === 0
    && !totals.modelTokens
    && !totals.agentStats
    && !totals.providerTokens
    && !totals.repoStats;
}

/** The part of a day that is not attributed to any tracked file's stats. */
function baseOf(day: DayDigest): DayTotals | undefined {
  if (day.files?.some(file => file.stats)) return day.base;
  return totalsOf(day);
}

function composeDay(
  base: DayTotals | undefined,
  files: TrackedFileState[],
  breakdownsIncomplete: boolean | undefined,
): DayDigest {
  const merged = createDayStats();
  let hasStats = false;
  for (const file of files) {
    if (!file.stats) continue;
    hasStats = true;
    mergeDayStats(merged, deserializeDayStats(file.stats));
  }
  const totals = hasStats || !base
    ? addTotals(base, dayStatsToTotals(merged))
    : base;
  const day: DayDigest = { ...totals, files };
  if (hasStats && base && !isEmptyTotals(base)) day.base = base;
  if (breakdownsIncomplete) day.breakdownsIncomplete = true;
  return day;
}

/**
 * Drop tracking state that cannot be trusted, keeping the day's totals. Such a
 * day is treated like one written by an older version.
 */
function sanitizeDayDigest(day: DayDigest): DayDigest {
  const valid = Array.isArray(day.files) && day.files.every(file => {
    if (!file
      || typeof file.fileName !== 'string'
      || !Number.isFinite(file.dev)
      || !Number.isFinite(file.ino)
      || !Number.isFinite(file.birthtimeMs)
      || !Number.isFinite(file.offset)
      || file.offset < 0
      || !Number.isFinite(file.size)
      || file.size < 0) {
      return false;
    }
    if (file.stats === undefined) return true;
    try {
      deserializeDayStats(file.stats);
      return true;
    } catch {
      return false;
    }
  });
  if (valid) return day;
  const { files: _files, base: _base, ...rest } = day;
  return rest;
}

function buildModelShares(
  modelMap: Map<string, { total: number; input: number; cacheRead: number }>,
  totalTokens: number,
): ModelShareEntry[] {
  return Array.from(modelMap.entries())
    .map(([model, data]) => ({
      model,
      totalTokens: data.total,
      inputTokens: data.input,
      cacheReadTokens: data.cacheRead,
      share: totalTokens > 0 ? data.total / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildAgentShares(
  agentMap: Map<string, { sessions: number; events: number; tokens: number }>,
  totalEvents: number,
): AgentShareEntry[] {
  return Array.from(agentMap.entries())
    .map(([agentType, data]) => ({
      agentType,
      sessions: data.sessions,
      events: data.events,
      tokens: data.tokens,
      share: totalEvents > 0 ? data.events / totalEvents : 0,
    }))
    .sort((a, b) => b.events - a.events);
}

function buildProviderShares(
  providerMap: Map<string, number>,
  totalTokens: number,
): ProviderShareEntry[] {
  return Array.from(providerMap.entries())
    .map(([provider, tokens]) => ({
      provider,
      totalTokens: tokens,
      share: totalTokens > 0 ? tokens / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildRepoShares(
  repoMap: Map<string, { sessions: number; events: number }>,
): RepoShareEntry[] {
  return Array.from(repoMap.entries())
    .map(([repo, data]) => ({
      repo,
      sessions: data.sessions,
      events: data.events,
    }))
    .sort((a, b) => b.events - a.events);
}
