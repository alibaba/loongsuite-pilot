import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { StatusBarConfig } from '../types/index.js';
import { writeJsonFile, readJsonFile, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { scanJsonlTail } from './jsonl-tail-reader.js';

const logger = createLogger('MetricsSummaryWriter');

const STARTUP_DELAY_MS = 5_000;
const DIGEST_MAX_DAYS = 200;
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
  private isRefreshing = false;

  constructor(dataDir: string, config: StatusBarConfig) {
    this.dataDir = dataDir;
    this.config = config;
    this.outputDir = path.join(dataDir, 'logs', 'output');
    this.summaryPath = path.join(dataDir, 'logs', 'metrics-summary.json');
    this.digestPath = path.join(dataDir, 'cache', 'metrics-daily-digest.json');
    this.scanStatePath = path.join(dataDir, 'cache', 'metrics-scan-state.json');
    this.currentDayStatePath = path.join(dataDir, 'cache', 'metrics-current-day-state.json');
  }

  start(): void {
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
    });
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    logger.info('metrics summary writer stopped');
  }

  async refresh(): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      await this.aggregate();
    } catch (err) {
      logger.warn('metrics summary refresh failed', { error: String(err) });
    } finally {
      this.isRefreshing = false;
    }
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
      digest.days[currentDayState.day] = this.dayStatsToDigest(completedStats);
      this.copyCurrentDayOffsetsToScanState(currentDayState, scanState);
      currentDayState = null;
    }

    const liveStats = new Map<string, DayStats>();
    const fullScanDays = new Set<string>();

    for (const file of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(file));
      if (!match) continue;
      const day = match[2];
      if (day === today) continue;

      const fileStat = await this.safeStat(file);
      if (!fileStat) continue;

      const baseName = path.basename(file);
      let startOffset = 0;
      const hasDigest = !!digest.days[day];
      const cached = scanState.files[baseName];
      if (hasDigest && cached && cached.ino === fileStat.ino && cached.size <= fileStat.size) {
        startOffset = cached.offset;
      }
      if (startOffset >= fileStat.size && hasDigest) {
        this.ensureDayStats(liveStats, day);
        continue;
      }

      if (startOffset === 0) fullScanDays.add(day);

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
      if (day !== today) {
        const existing = digest.days[day];
        if (!existing || stats.events > 0) {
          // If any file for this day was scanned from offset 0, replace digest entirely
          // to avoid double-counting when scan-state cache is lost but digest is retained
          digest.days[day] = fullScanDays.has(day)
            ? this.dayStatsToDigest(stats)
            : this.dayStatsToDigest(stats, existing);
        }
      }
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
    const existingByName = new Map(state.files.map(file => [file.fileName, file]));
    const nextByName = new Map(existingByName);
    let totalBytesRead = 0;

    for (const filePath of files) {
      const match = FILE_NAME_PATTERN.exec(path.basename(filePath));
      if (!match || match[2] !== state.day) continue;

      const fileStat = await this.safeStat(filePath);
      if (!fileStat) continue;

      const fileName = path.basename(filePath);
      const existing = existingByName.get(fileName);
      const canResume = existing !== undefined
        && sameFileIdentity(existing, fileStat)
        && existing.offset <= fileStat.size
        && existing.size <= fileStat.size;
      const startOffset = canResume ? existing.offset : 0;
      const stats = canResume ? deserializeDayStats(existing.stats) : createDayStats();
      const result = await scanJsonlTail(filePath, startOffset, fileStat.size, {
        onRecord: record => {
          this.applyRecord(record as Record<string, string>, stats);
        },
      });
      totalBytesRead += result.bytesRead;

      nextByName.set(fileName, {
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
      fileCount: nextByName.size,
      bytesRead: totalBytesRead,
    });

    return {
      version: 1,
      day: state.day,
      files: Array.from(nextByName.values())
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

    if (eventName === 'llm.request') {
      stats.requests++;
    }

    if (eventName === 'tool.call') {
      stats.toolCalls++;
    }

    if (eventName === 'llm.response') {
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
    return {
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
        totalTokens += d.tokens;
        inputTokens += d.inputTokens;
        outputTokens += d.outputTokens;
        cacheReadTokens += d.cacheReadTokens;
        cacheCreationTokens += d.cacheCreationTokens;
        totalSessions += d.sessions;
        totalRequests += d.requests;
        totalToolCalls += d.toolCalls;
        totalEvents += d.events;
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
