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
// Digests written before the breakdowns were persisted are backfilled by
// rescanning a complete closed day, but only inside retention's default
// window: older days are unlikely to still have every segment, and a bounded
// window keeps an upgrade from rescanning months of history.
const DIGEST_BACKFILL_DAYS = 7;
// Session identities per agent/repository are kept in the digest so that
// incremental batches of the same closed day cannot count one session twice.
// The list is capped: beyond it the count falls back to additive semantics.
const MAX_DIGEST_SESSION_IDS = 2_000;
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

interface DayDigest {
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
  /**
   * Basenames of the output segments already folded into this day. Kept so a
   * later refresh can tell a genuine new segment apart from a rebuild of data
   * that is already counted, and therefore never drop totals that belong to a
   * segment retention has already removed.
   */
  segments?: string[];
  /**
   * Set when a day written by an older version could not be rebuilt from its
   * remaining segments. The totals stay correct but the per-dimension
   * breakdowns for that day are knowingly incomplete.
   */
  breakdownsIncomplete?: true;
  /**
   * Set once an upgrade tried to rebuild this legacy day. A rebuild that could
   * not account for every segment is not retried on every refresh.
   */
  backfillAttempted?: true;
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
  /** Session identities behind `sessions`, so incremental batches dedupe. */
  sessionIds?: string[];
  /** Set when the identity list hit MAX_DIGEST_SESSION_IDS for this day. */
  sessionIdsTruncated?: true;
}

interface RepoDigest {
  sessions: number;
  events: number;
  sessionIds?: string[];
  sessionIdsTruncated?: true;
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

interface CurrentDayFileState {
  fileName: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  offset: number;
  size: number;
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
    // double-count the day on restart.
    if (currentDayState && currentDayState.day !== today) {
      currentDayState = await this.refreshCurrentDayState(currentDayState, files);
      const completedStats = mergeCurrentDayStats(currentDayState);
      const completedDay = this.dayStatsToDigest(completedStats);
      completedDay.segments = currentDayState.files
        .map(file => file.fileName)
        .sort();
      delete completedDay.breakdownsIncomplete;
      digest.days[currentDayState.day] = completedDay;
      this.copyCurrentDayOffsetsToScanState(currentDayState, scanState);
      currentDayState = null;
    }

    const liveStats = new Map<string, DayStats>();
    const fullScanDays = new Set<string>();
    // Days where at least one segment was rebuilt from offset 0 without the
    // digest being replaceable: the rebuilt data is authoritative for the
    // segments still present, but segments already retired are only known from
    // the digest.
    const rebuiltDays = new Set<string>();
    const backfillDays = new Set<string>();
    const presentSegments = new Map<string, Set<string>>();

    for (const file of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(file));
      if (!match) continue;
      const day = match[2];
      if (day === today) continue;

      const fileStat = await this.safeStat(file);
      if (!fileStat) continue;
      if (this.skipOversizedOutput(file, fileStat)) continue;

      const baseName = path.basename(file);
      let startOffset = 0;
      const hasDigest = !!digest.days[day];
      const cached = scanState.files[baseName];
      if (hasDigest && cached && cached.ino === fileStat.ino && cached.size <= fileStat.size) {
        startOffset = cached.offset;
      }
      // A day written before breakdowns were persisted has no per-dimension
      // data at all; inside the backfill window rescan it from the start so an
      // upgrade repairs recent days instead of waiting for them to age out.
      if (hasDigest && this.needsBackfill(digest.days[day], day, today)) {
        startOffset = 0;
        backfillDays.add(day);
      }
      if (startOffset >= fileStat.size && hasDigest) {
        this.ensureDayStats(liveStats, day);
        this.noteSegment(presentSegments, day, baseName);
        continue;
      }

      if (startOffset === 0) {
        fullScanDays.add(day);
        // A digest without segment provenance cannot prove that a zero-offset
        // rescan covers every segment already counted, so replacing it would
        // silently drop the totals of retired segments.
        if (hasDigest && !digest.days[day].segments) rebuiltDays.add(day);
      }
      this.noteSegment(presentSegments, day, baseName);

      const dayStats = this.ensureDayStats(liveStats, day);
      const newOffset = await this.scanFile(file, startOffset, fileStat.size, dayStats);

      scanState.files[baseName] = {
        offset: newOffset,
        size: fileStat.size,
        ino: fileStat.ino,
      };
    }

    // Merge live data into digest for history; past days commit to digest permanently
    for (const [day, stats] of liveStats) {
      if (day === today) continue;
      const existing = digest.days[day];
      if (existing && stats.events === 0) continue;
      const segments = presentSegments.get(day);
      const provenance = segments ? Array.from(segments).sort() : undefined;

      if (!existing) {
        const next = this.dayStatsToDigest(stats);
        if (provenance) next.segments = provenance;
        digest.days[day] = next;
        continue;
      }

      // Replacing the entry is only sound when this refresh rescanned every
      // segment the day ever had. A segment that retention already removed —
      // or a digest written before segment provenance was recorded — cannot be
      // re-read, so its totals must be kept instead of overwritten.
      const knownSegments = existing.segments;
      const coversEverySegment = fullScanDays.has(day)
        && !rebuiltDays.has(day)
        && !!knownSegments
        && knownSegments.every(name => segments?.has(name));
      // Backfilling a legacy digest rescans the segments that survived. Equal
      // totals prove that no segment was retired before the upgrade, so the
      // rescan is a complete picture of the day and may replace it.
      const backfillCoversDay = backfillDays.has(day)
        && stats.tokens === existing.tokens
        && stats.events === existing.events;
      // A legacy digest whose rescan does not add up has lost segments. The
      // rescan also re-reads records the digest already counted, so merging it
      // would double count them: keep the stored totals and stop claiming that
      // the breakdowns describe the day.
      const backfillAmbiguous = backfillDays.has(day) && !backfillCoversDay;

      let next: DayDigest;
      if (backfillAmbiguous) {
        next = { ...existing, breakdownsIncomplete: true, backfillAttempted: true };
      } else if (coversEverySegment || backfillCoversDay) {
        next = this.dayStatsToDigest(stats);
        delete next.breakdownsIncomplete;
      } else {
        next = this.dayStatsToDigest(stats, existing);
        // The stored day already carried totals without breakdowns, so this
        // incremental batch cannot make the day's distribution complete.
        if (existing.breakdownsIncomplete || (!existing.modelTokens && !existing.agentStats)) {
          next.breakdownsIncomplete = true;
        }
      }
      if (provenance) {
        // Retired names stay listed: their totals live on in the digest and a
        // later refresh must not assume a zero-offset rescan covered them.
        next.segments = Array.from(new Set([...(existing.segments ?? []), ...provenance])).sort();
      }
      if (backfillDays.has(day)) {
        // Remember which segments the repair already read so it runs once.
        next.backfillAttempted = true;
      }
      digest.days[day] = next;
    }

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
   * A day needs a rebuild when it was written before the breakdowns existed.
   * Only days inside the backfill window qualify: older days are likely to have
   * lost segments to retention, and their breakdown stays marked incomplete.
   */
  private needsBackfill(day: DayDigest | undefined, dayKey: string, today: string): boolean {
    if (!day) return false;
    if (day.modelTokens || day.agentStats) return false;
    if (day.backfillAttempted || day.breakdownsIncomplete) return false;
    return dayKey >= dateDaysAgo(DIGEST_BACKFILL_DAYS, today);
  }

  private noteSegment(
    map: Map<string, Set<string>>,
    day: string,
    fileName: string,
  ): void {
    let set = map.get(day);
    if (!set) {
      set = new Set();
      map.set(day, set);
    }
    set.add(fileName);
  }

  private ensureDayStats(map: Map<string, DayStats>, day: string): DayStats {
    let stats = map.get(day);
    if (!stats) {
      stats = createDayStats();
      map.set(day, stats);
    }
    return stats;
  }

  private async scanFile(
    filePath: string,
    startOffset: number,
    endOffset: number,
    stats: DayStats,
  ): Promise<number> {
    const result = await scanJsonlTail(filePath, startOffset, endOffset, {
      onRecord: record => {
        this.applyRecord(record as Record<string, string>, stats);
      },
    });
    logger.debug('metrics summary file scanned', {
      file: path.basename(filePath),
      startOffset,
      endOffset,
      nextOffset: result.nextOffset,
      bytesRead: result.bytesRead,
      mode: startOffset === 0 ? 'rebuild' : 'incremental',
    });
    return result.nextOffset;
  }

  private async refreshCurrentDayState(
    state: CurrentDayState,
    files: string[],
  ): Promise<CurrentDayState> {
    const existingByIdentity = new Map(state.files.map(file => [fileIdentity(file), file]));
    const nextByIdentity = new Map(existingByIdentity);
    let totalBytesRead = 0;

    for (const filePath of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(filePath));
      if (!match || match[2] !== state.day) continue;

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
        }
      }
      const canResume = existing !== undefined
        && sameFileIdentity(existing, fileStat)
        && existing.offset <= fileStat.size
        && existing.size <= fileStat.size;
      const startOffset = canResume ? existing.offset : 0;
      // In-place truncation starts a new read range without retracting events
      // already observed today, just as deleting a closed segment does not.
      const stats = existing ? deserializeDayStats(existing.stats) : createDayStats();
      const result = await scanJsonlTail(filePath, startOffset, fileStat.size, {
        expectedFileIdentity: fileStat,
        onRecord: record => {
          this.applyRecord(record as Record<string, string>, stats);
        },
      });
      totalBytesRead += result.bytesRead;

      nextByIdentity.set(identity, {
        fileName,
        dev: fileStat.dev,
        ino: fileStat.ino,
        birthtimeMs: fileStat.birthtimeMs,
        offset: result.nextOffset,
        size: fileStat.size,
        stats: serializeDayStats(stats),
      });
    }

    logger.debug('metrics current-day files refreshed', {
      day: state.day,
      fileCount: nextByIdentity.size,
      bytesRead: totalBytesRead,
    });

    return {
      version: 1,
      day: state.day,
      files: Array.from(nextByIdentity.values())
        .sort((left, right) => left.fileName.localeCompare(right.fileName)),
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

  private dayStatsToDigest(stats: DayStats, existing?: DayDigest): DayDigest {
    if (existing && stats.events === 0) return existing;
    const digest: DayDigest = {
      tokens: (existing?.tokens ?? 0) + stats.tokens,
      inputTokens: (existing?.inputTokens ?? 0) + stats.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + stats.outputTokens,
      cacheReadTokens: (existing?.cacheReadTokens ?? 0) + stats.cacheReadTokens,
      cacheCreationTokens: (existing?.cacheCreationTokens ?? 0) + stats.cacheCreationTokens,
      sessions: (existing?.sessions ?? 0) + stats.sessions.size,
      requests: (existing?.requests ?? 0) + stats.requests,
      toolCalls: (existing?.toolCalls ?? 0) + stats.toolCalls,
      events: (existing?.events ?? 0) + stats.events,
    };

    // Persist the per-dimension breakdowns as well, otherwise every range
    // wider than one day comes back with empty modelShares / agentShares /
    // providerShares / repoShares once the raw JSONL is gone.
    const modelTokens = mergeModelDigests(existing?.modelTokens, stats.modelTokens);
    if (modelTokens) digest.modelTokens = modelTokens;
    const agentStats = mergeAgentDigests(existing?.agentStats, stats.agentStats);
    if (agentStats) digest.agentStats = agentStats;
    const providerTokens = mergeProviderDigests(existing?.providerTokens, stats.providerTokens);
    if (providerTokens) digest.providerTokens = providerTokens;
    const repoStats = mergeRepoDigests(existing?.repoStats, stats.repoStats);
    if (repoStats) digest.repoStats = repoStats;
    // Provenance and incompleteness describe the day, not this batch; the
    // caller decides how they evolve.
    if (existing?.segments) digest.segments = existing.segments;
    if (existing?.breakdownsIncomplete) digest.breakdownsIncomplete = true;

    return digest;
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
        if (d.breakdownsIncomplete || (d.tokens > 0 && !d.modelTokens && !d.agentStats)) {
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
    return data && data.days ? data : { version: 1, days: {} };
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

function sameFileIdentity(file: CurrentDayFileState, stat: fsSync.Stats): boolean {
  return file.dev === stat.dev
    && file.ino === stat.ino
    && file.birthtimeMs === stat.birthtimeMs;
}

function fileIdentity(file: Pick<CurrentDayFileState, 'dev' | 'ino' | 'birthtimeMs'>): string {
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

/**
 * Merge the persisted session identities of a closed day with the ids of an
 * incremental batch. Counts stay exact as long as the identity list is intact,
 * so a second batch about the same session cannot inflate `sessions`.
 */
function mergeSessionIds(
  existing: Partial<AgentDigest & RepoDigest>,
  live: Set<string>,
): Pick<AgentDigest, 'sessions' | 'sessionIds' | 'sessionIdsTruncated'> {
  const knownSessions = existing.sessions ?? 0;
  if (knownSessions === 0 && existing.sessionIds === undefined) {
    // Fresh accumulator for this day: the batch is the whole population.
    const ids = Array.from(live).sort();
    if (ids.length <= MAX_DIGEST_SESSION_IDS) return { sessions: ids.length, sessionIds: ids };
    return { sessions: ids.length, sessionIdsTruncated: true };
  }
  // A legacy digest (count only) or an already-capped list cannot deduplicate
  // the batch against identities it never stored; stay additive, exactly like
  // the scalar day-level session total.
  if (existing.sessionIds === undefined || existing.sessionIdsTruncated) {
    return {
      sessions: knownSessions + live.size,
      sessionIds: existing.sessionIds,
      sessionIdsTruncated: existing.sessionIdsTruncated,
    };
  }

  const known = new Set(existing.sessionIds);
  const unseen = Array.from(live).filter(id => !known.has(id));
  const merged = new Set([...existing.sessionIds, ...unseen]);
  if (merged.size <= MAX_DIGEST_SESSION_IDS) {
    return { sessions: merged.size, sessionIds: Array.from(merged).sort() };
  }
  // Past the cap the exact identity list is dropped, but the count stays right.
  return {
    sessions: knownSessions + unseen.length,
    sessionIdsTruncated: true,
  };
}

function mergeModelDigests(
  existing: Record<string, ModelTokenDigest> | undefined,
  live: Map<string, { total: number; input: number; cacheRead: number }>,
): Record<string, ModelTokenDigest> | undefined {
  if (!existing && live.size === 0) return undefined;
  const merged = emptyRecord<ModelTokenDigest>();
  for (const [model, data] of Object.entries(existing ?? {})) {
    merged[model] = { total: data.total, input: data.input, cacheRead: data.cacheRead };
  }
  for (const [model, data] of live) {
    const current = merged[model] ?? { total: 0, input: 0, cacheRead: 0 };
    current.total += data.total;
    current.input += data.input;
    current.cacheRead += data.cacheRead;
    merged[model] = current;
  }
  return merged;
}

function mergeAgentDigests(
  existing: Record<string, AgentDigest> | undefined,
  live: Map<string, { sessions: Set<string>; events: number; tokens: number }>,
): Record<string, AgentDigest> | undefined {
  if (!existing && live.size === 0) return undefined;
  const merged = emptyRecord<AgentDigest>();
  for (const [agentType, data] of Object.entries(existing ?? {})) {
    merged[agentType] = {
      sessions: data.sessions,
      events: data.events,
      tokens: data.tokens,
      sessionIds: data.sessionIds,
      sessionIdsTruncated: data.sessionIdsTruncated,
    };
  }
  for (const [agentType, data] of live) {
    const current = merged[agentType] ?? { sessions: 0, events: 0, tokens: 0 };
    const identity = mergeSessionIds(current, data.sessions);
    merged[agentType] = {
      sessions: identity.sessions,
      events: current.events + data.events,
      tokens: current.tokens + data.tokens,
      sessionIds: identity.sessionIds,
      sessionIdsTruncated: identity.sessionIdsTruncated,
    };
  }
  return merged;
}

function mergeProviderDigests(
  existing: Record<string, number> | undefined,
  live: Map<string, number>,
): Record<string, number> | undefined {
  if (!existing && live.size === 0) return undefined;
  const merged = emptyRecord<number>();
  for (const [provider, tokens] of Object.entries(existing ?? {})) {
    merged[provider] = tokens;
  }
  for (const [provider, tokens] of live) {
    merged[provider] = (merged[provider] ?? 0) + tokens;
  }
  return merged;
}

function mergeRepoDigests(
  existing: Record<string, RepoDigest> | undefined,
  live: Map<string, { sessions: Set<string>; events: number }>,
): Record<string, RepoDigest> | undefined {
  if (!existing && live.size === 0) return undefined;
  const merged = emptyRecord<RepoDigest>();
  for (const [repo, data] of Object.entries(existing ?? {})) {
    merged[repo] = {
      sessions: data.sessions,
      events: data.events,
      sessionIds: data.sessionIds,
      sessionIdsTruncated: data.sessionIdsTruncated,
    };
  }
  for (const [repo, data] of live) {
    const current = merged[repo] ?? { sessions: 0, events: 0 };
    const identity = mergeSessionIds(current, data.sessions);
    merged[repo] = {
      sessions: identity.sessions,
      events: current.events + data.events,
      sessionIds: identity.sessionIds,
      sessionIdsTruncated: identity.sessionIdsTruncated,
    };
  }
  return merged;
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
