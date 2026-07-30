import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_SERVICE_LOG_TAIL_BYTES = 512 * 1024;
const DEFAULT_JSONL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FAILED_LOG_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMELINE_LIMIT = 200;
const DEFAULT_CACHED_OUTPUT_EVENTS_PER_FILE = 50;
const OVERVIEW_CACHE_VERSION = 1;
const DEFAULT_INDEX_BYTES_PER_REFRESH = 5 * 1024 * 1024;
const DEFAULT_INDEX_LINES_PER_REFRESH = 20_000;
const partialIndexLogState = new Map();
const STALE_AFTER_MS = 30 * 60 * 1000;

export const AGENTS = [
  {
    id: 'cursor',
    label: 'Cursor',
    methods: ['cursor-hook'],
    collectionTypes: ['Hook events'],
  },
  {
    id: 'qoder',
    label: 'Qoder',
    methods: ['qoder-sqlite'],
    collectionTypes: ['Conversation events', 'Token usage'],
  },
  {
    id: 'qoder-cli',
    label: 'Qoder CLI',
    methods: ['qoder-cli-hook', 'qoder-cli-session'],
    collectionTypes: ['CLI transcript events', 'CLI session logs'],
  },
  {
    id: 'qoder-combined',
    label: 'Qoder / Qoder CLI',
    methods: ['qoder-cli-hook', 'qoder-cli-session'],
    collectionTypes: ['Ambiguous Qoder-family events'],
    hiddenWhenEmpty: true,
  },
  {
    id: 'qoder-work',
    label: 'Qoder Work',
    methods: ['qoder-work-hook'],
    collectionTypes: ['Hook events'],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    methods: ['claude-code-log'],
    collectionTypes: ['OpenTelemetry logs'],
  },
  {
    id: 'codex',
    label: 'Codex',
    methods: ['codex-log'],
    collectionTypes: ['OpenTelemetry logs'],
  },
];

const AGENT_BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

const METHOD_LABELS = {
  'cursor-hook': 'Cursor hook events',
  'qoder-sqlite': 'Qoder token usage',
  'qoder-cli-hook': 'Qoder/Qoder CLI hook events',
  'qoder-cli-session': 'Qoder CLI session logs',
  'qoder-work-hook': 'Qoder Work hook events',
  'claude-code-log': 'Claude Code logs',
  'codex-log': 'Codex logs',
};

export function localDateString(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function parseAttributes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function classifyMethod(inputId) {
  switch (inputId) {
    case 'cursor-hook':
      return 'cursor';
    case 'qoder-sqlite':
      return 'qoder';
    case 'qoder-work-hook':
    case 'qoder-work':
      return 'qoder-work';
    case 'qoder-cli-hook':
    case 'qoder-cli-session':
      return 'qoder-combined';
    case 'claude-code-log':
      return 'claude-code';
    case 'codex-log':
      return 'codex';
    default:
      return 'unknown';
  }
}

export function classifyRecord(record) {
  const attributes = parseAttributes(record.attributes);
  const agentType = stringValue(record['gen_ai.agent.type'] ?? record['agent.type']).toLowerCase();
  const source = stringValue(attributes.source ?? record['agent.source']).toLowerCase();
  const variant = stringValue(
    attributes.qoder_variant ??
    record['agent.qoder_variant'] ??
    record['agent.qoder.variant'] ??
    record['agent.qoderwork.variant'],
  ).toLowerCase();
  const entrypoint = stringValue(
    attributes.entrypoint ?? record['agent.entrypoint'] ?? record.entrypoint,
  ).toLowerCase();

  if (agentType === 'cursor' || agentType === 'cursor-cli') return 'cursor';
  if (agentType === 'qoder-work' || variant === 'qoder-work') return 'qoder-work';
  if (agentType === 'qoder-cli' || variant === 'qoder-cli' || entrypoint === 'cli') return 'qoder-cli';
  if (agentType === 'qoder' || variant === 'qoder') return 'qoder';
  if (source === 'qoder-sqlite-chat-message') return 'qoder';
  if (source === 'qoder-cli-session-segment') return 'qoder-cli';
  if (agentType.includes('claude')) return 'claude-code';
  if (agentType.includes('codex')) return 'codex';
  return 'unknown';
}

export function createOverviewAggregator(options = {}) {
  const dataDir = options.dataDir || path.join(homedir(), '.loongsuite-pilot');
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const serviceLogTailBytes = options.serviceLogTailBytes ?? DEFAULT_SERVICE_LOG_TAIL_BYTES;
  const jsonlMaxBytes = options.jsonlMaxBytes ?? DEFAULT_JSONL_MAX_BYTES;
  const failedLogMaxBytes = options.failedLogMaxBytes ?? DEFAULT_FAILED_LOG_MAX_BYTES;
  const timelineLimit = options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
  const cachedOutputEventsPerFile = options.cachedOutputEventsPerFile ?? DEFAULT_CACHED_OUTPUT_EVENTS_PER_FILE;
  const maxIndexBytesPerRefresh = options.maxIndexBytesPerRefresh ?? DEFAULT_INDEX_BYTES_PER_REFRESH;
  const maxIndexLinesPerRefresh = options.maxIndexLinesPerRefresh ?? DEFAULT_INDEX_LINES_PER_REFRESH;
  const overviewCachePath = options.overviewCachePath
    || path.join(dataDir, 'cache', 'agent-overview', 'output-summary-cache.json');
  const nowProvider = options.nowProvider || (() => new Date());

  let cachedSummary = null;
  let cachedAt = 0;
  let overviewCache = null;
  let buildChain = Promise.resolve();

  async function getOverview({ force = false } = {}) {
    const now = nowProvider();
    if (!force && cachedSummary && now.getTime() - cachedAt < cacheTtlMs) {
      return {
        ...cachedSummary,
        cache: { ...cachedSummary.cache, hit: true },
      };
    }

    const previousBuild = buildChain;
    let releaseBuild;
    buildChain = new Promise((resolve) => {
      releaseBuild = resolve;
    });
    await previousBuild.catch(() => {});
    try {
      const lockedNow = nowProvider();
      if (!force && cachedSummary && lockedNow.getTime() - cachedAt < cacheTtlMs) {
        return {
          ...cachedSummary,
          cache: { ...cachedSummary.cache, hit: true },
        };
      }
      overviewCache ||= await loadOverviewCache(overviewCachePath);

      const summary = await buildOverview({
        dataDir,
        now: lockedNow,
        serviceLogTailBytes,
        jsonlMaxBytes,
        failedLogMaxBytes,
        timelineLimit,
        overviewCache,
        overviewCachePath,
        cachedOutputEventsPerFile,
        maxIndexBytesPerRefresh,
        maxIndexLinesPerRefresh,
      });
      cachedSummary = summary;
      cachedAt = lockedNow.getTime();
      return summary;
    } finally {
      releaseBuild();
    }
  }

  async function getAgent(agentId) {
    const overview = await getOverview();
    return overview.agents.find((agent) => agent.id === agentId) || null;
  }

  return { getOverview, getAgent };
}

async function buildOverview(opts) {
  const config = await readConfig(opts.dataDir);
  const version = await readVersion(opts.dataDir);
  const service = await buildServiceSummary(opts.dataDir, version, opts.now);
  const serviceLog = await parseServiceLog(path.join(opts.dataDir, 'logs', 'loongsuite-pilot-service.log'), {
    maxBytes: opts.serviceLogTailBytes,
    timelineLimit: opts.timelineLimit,
  });
  const output = await aggregateOutputFiles(path.join(opts.dataDir, 'logs', 'output'), {
    date: localDateString(opts.now),
    overviewCache: opts.overviewCache,
    overviewCachePath: opts.overviewCachePath,
    cachedOutputEventsPerFile: opts.cachedOutputEventsPerFile,
    maxIndexBytesPerRefresh: opts.maxIndexBytesPerRefresh,
    maxIndexLinesPerRefresh: opts.maxIndexLinesPerRefresh,
  });
  const failures = await aggregateFailedUploads(path.join(opts.dataDir, 'logs', 'sls-failed-logs'), {
    maxBytes: opts.failedLogMaxBytes,
  });

  const methodStates = buildMethodStates(serviceLog, output, opts.now);
  const agents = buildAgentSummaries({
    methodStates,
    output,
    service,
    now: opts.now,
  });
  const reporting = buildReportingSummary(config, output, failures);
  const timeline = buildTimeline({
    serviceLog,
    output,
    failures,
    limit: opts.timelineLimit,
  });

  return {
    generatedAt: opts.now.toISOString(),
    dataDir: opts.dataDir,
    service,
    reporting,
    totals: {
      eventsToday: agents.reduce((sum, agent) => sum + agent.todayEvents, 0),
      tokensToday: agents.reduce((sum, agent) => sum + agent.tokensToday, 0),
      failedUploadsToday: failures.total,
      agentsCollecting: agents.filter((agent) => agent.status === 'active').length,
    },
    agents: agents.filter((agent) => !agent.hiddenWhenEmpty || agent.todayEvents > 0),
    timeline,
    cache: {
      hit: false,
      ttlMs: DEFAULT_CACHE_TTL_MS,
      bounded: true,
      indexing: output.indexing,
      outputPartial: output.partial,
      outputProgress: output.progress,
      limits: {
        serviceLogTailBytes: opts.serviceLogTailBytes,
        timelineLimit: opts.timelineLimit,
        cachedOutputEventsPerFile: opts.cachedOutputEventsPerFile,
        maxIndexBytesPerRefresh: opts.maxIndexBytesPerRefresh,
        maxIndexLinesPerRefresh: opts.maxIndexLinesPerRefresh,
        failedLogMaxBytes: opts.failedLogMaxBytes,
      },
    },
  };
}

async function readConfig(dataDir) {
  const configPath = path.join(dataDir, 'config.json');
  const raw = await safeReadFile(configPath, 'utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function readVersion(dataDir) {
  const current = (await safeReadFile(path.join(dataDir, 'current'), 'utf8'))?.trim();
  const candidates = [
    current ? path.join(dataDir, 'versions', current, 'VERSION') : '',
    path.join(dataDir, 'package', 'VERSION'),
    path.resolve(process.cwd(), 'VERSION'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const raw = await safeReadFile(candidate, 'utf8');
    if (!raw) continue;
    const parsed = {};
    for (const line of raw.split(/\r?\n/)) {
      const [key, ...parts] = line.split('=');
      if (key && parts.length) parsed[key.trim()] = parts.join('=').trim();
    }
    if (parsed.version || raw.trim()) {
      return {
        version: parsed.version || raw.trim(),
        gitCommit: parsed.git_commit,
      };
    }
  }
  return { version: 'unknown' };
}

async function buildServiceSummary(dataDir, version, now) {
  const pidFile = path.join(dataDir, 'loongsuite-pilot.pid');
  const pidRaw = (await safeReadFile(pidFile, 'utf8'))?.trim();
  const pid = pidRaw && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
  const running = pid !== null && processIsRunning(pid);
  const serviceLogPath = path.join(dataDir, 'logs', 'loongsuite-pilot-service.log');
  const serviceStat = await safeStat(serviceLogPath);

  return {
    status: running ? 'running' : 'stopped',
    running,
    pid,
    version: version.version,
    gitCommit: version.gitCommit,
    dataDir,
    lastObservedAt: serviceStat?.mtime ? serviceStat.mtime.toISOString() : null,
    checkedAt: now.toISOString(),
  };
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function parseServiceLog(filePath, options) {
  const text = await readTail(filePath, options.maxBytes);
  const events = [];
  const methodStates = {};

  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;
    const { timestamp, level, tag, message, meta } = parsed;

    if (message === 'input registered' && meta.id) {
      ensureMethod(methodStates, meta.id).registered = true;
    }
    if ((message === 'input started' || message === 'agent detected and started') && meta.id) {
      const method = ensureMethod(methodStates, meta.id);
      method.started = true;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'agent.started',
        severity: 'info',
        agentId: classifyMethod(meta.id),
        methodId: meta.id,
        summary: `Started collecting ${agentLabel(classifyMethod(meta.id))}`,
      }));
    }
    if ((message === 'input stopped' || message === 'agent stopped') && meta.id) {
      const method = ensureMethod(methodStates, meta.id);
      method.started = false;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'agent.stopped',
        severity: 'warn',
        agentId: classifyMethod(meta.id),
        methodId: meta.id,
        summary: `Stopped collecting ${agentLabel(classifyMethod(meta.id))}`,
      }));
    }
    if (message === 'dispatching entries' && meta.inputId) {
      const count = Number(meta.count) || 0;
      const method = ensureMethod(methodStates, meta.inputId);
      method.dispatchedToday += count;
      method.lastDispatchAt = timestamp;
      method.lastSeenAt = timestamp;
      events.push(activityEvent({
        timestamp,
        type: 'collection.batch',
        severity: 'info',
        agentId: classifyMethod(meta.inputId),
        methodId: meta.inputId,
        count,
        summary: `${agentLabel(classifyMethod(meta.inputId))} collected ${count} events`,
      }));
    }
    if (tag === 'Main' && message === 'AI Agent Input is running') {
      events.push(activityEvent({
        timestamp,
        type: 'service.started',
        severity: 'info',
        summary: 'LoongSuite Pilot started',
        details: { flushers: meta.flushers },
      }));
      if (Array.isArray(meta.flushers)) {
        for (const flusher of meta.flushers) {
          events.push(activityEvent({
            timestamp,
            type: 'reporting.channel.enabled',
            severity: 'info',
            summary: `${String(flusher).toUpperCase()} reporting enabled`,
          }));
        }
      }
    }
    if (level === 'WARN' || level === 'ERROR') {
      events.push(activityEvent({
        timestamp,
        type: level === 'ERROR' ? 'collector.error' : 'collector.warning',
        severity: level === 'ERROR' ? 'error' : 'warn',
        summary: `${tag}: ${message}`,
        details: meta,
      }));
    }
  }

  return {
    events: events.slice(-options.timelineLimit),
    methodStates,
  };
}

function parseLogLine(line) {
  const match = line.match(/^\[([^\]]+)] \[([^\]]+)] \[([^\]]+)] ([^{]*?)(?: (\{.*\}))?$/);
  if (!match) return null;
  const [, timestamp, level, tag, rawMessage, rawMeta] = match;
  let meta = {};
  if (rawMeta) {
    try {
      meta = JSON.parse(rawMeta);
    } catch {
      meta = {};
    }
  }
  return {
    timestamp,
    level,
    tag,
    message: rawMessage.trim(),
    meta,
  };
}

async function aggregateOutputFiles(outputDir, options) {
  const result = {
    files: [],
    byAgent: {},
    events: [],
    total: 0,
    tokens: 0,
    partial: false,
    indexing: false,
    progress: {
      indexedFiles: 0,
      totalFiles: 0,
      indexedBytes: 0,
      totalBytes: 0,
      files: [],
    },
  };
  const entries = await safeReaddir(outputDir);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(`-${options.date}.jsonl`))
    .map((entry) => path.join(outputDir, entry.name));
  const activeFileKeys = new Set(files);
  result.progress.totalFiles = files.length;

  for (const filePath of files) {
    const fileSummary = await summarizeJsonlFile(filePath, options);
    logPartialIndexProgress(fileSummary);
    result.files.push(fileSummary.file);
    result.total += fileSummary.total;
    result.tokens += fileSummary.tokens;
    result.partial = result.partial || fileSummary.partial;
    result.indexing = result.indexing || fileSummary.indexing;
    result.progress.indexedBytes += fileSummary.file.indexedBytes || 0;
    result.progress.totalBytes += fileSummary.file.sizeBytes || 0;
    if (!fileSummary.indexing) result.progress.indexedFiles += 1;
    result.progress.files.push({
      name: fileSummary.file.name,
      sizeBytes: fileSummary.file.sizeBytes,
      indexedBytes: fileSummary.file.indexedBytes || 0,
      indexing: Boolean(fileSummary.indexing),
    });
    for (const [agentId, agentSummary] of Object.entries(fileSummary.byAgent)) {
      const target = ensureAgentOutput(result.byAgent, agentId);
      mergeAgentOutput(target, agentSummary);
    }
    result.events.push(...fileSummary.events);
  }

  result.events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  pruneOverviewCache(options.overviewCache, activeFileKeys, options.date);
  await saveOverviewCache(options.overviewCachePath, options.overviewCache);
  return result;
}

async function summarizeJsonlFile(filePath, options) {
  const fileStat = await safeStat(filePath);
  if (!fileStat) {
    return emptyFileSummary(filePath);
  }

  const cached = validOutputCacheEntry(options.overviewCache.files[filePath], filePath, fileStat);
  const shouldRebuild = !cached || fileStat.size < cached.indexedThroughOffset;
  const entry = shouldRebuild
    ? newOutputCacheEntry(filePath, options.date, fileStat)
    : {
      ...cached,
      file: fileMetadata(filePath, fileStat, cached.indexedThroughOffset, cached.indexing),
    };

  if (entry.indexedThroughOffset < fileStat.size) {
    const readResult = await readJsonlChunk(filePath, {
      start: entry.indexedThroughOffset,
      fileSize: fileStat.size,
      maxBytes: options.maxIndexBytesPerRefresh,
      maxLines: options.maxIndexLinesPerRefresh,
    });
    applyOutputLines(entry.summary, readResult.lines, options.cachedOutputEventsPerFile);
    entry.indexedThroughOffset = readResult.nextOffset;
    entry.indexing = entry.indexedThroughOffset < fileStat.size;
  } else {
    entry.indexing = false;
  }
  trimCachedOutputEvents(entry.summary, options.cachedOutputEventsPerFile);

  entry.size = fileStat.size;
  entry.mtimeMs = fileStat.mtimeMs;
  entry.dev = fileStat.dev;
  entry.ino = fileStat.ino;
  entry.file = fileMetadata(filePath, fileStat, entry.indexedThroughOffset, entry.indexing);
  entry.summary.file = entry.file;
  entry.summary.partial = entry.indexing;
  entry.summary.indexing = entry.indexing;
  options.overviewCache.files[filePath] = entry;
  return cloneSummary(entry.summary);
}

function applyOutputLines(summary, lines, cachedOutputEventsPerFile) {
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    applyOutputRecord(summary, record, cachedOutputEventsPerFile);
  }
}

function applyOutputRecord(summary, record, cachedOutputEventsPerFile) {
  const agentId = classifyRecord(record);
  if (agentId === 'unknown') return;
  const timestamp = recordTime(record);
  const eventName = stringValue(record['event.name']) || 'event';
  const tokens = numberValue(record['gen_ai.usage.total_tokens'] ?? record['usage.total_tokens']);
  const agent = ensureAgentOutput(summary.byAgent, agentId);
  agent.total += 1;
  agent.tokens += tokens;
  agent.lastActivityAt = maxIso(agent.lastActivityAt, timestamp);
  agent.eventTypes[eventName] = (agent.eventTypes[eventName] || 0) + 1;

  const attributes = parseAttributes(record.attributes);
  const source = stringValue(attributes.source ?? record['agent.source']) || 'normalized-output';
  const method = ensureMethodOutput(agent.methods, source);
  method.count += 1;
  method.lastActivityAt = maxIso(method.lastActivityAt, timestamp);
  method.tokens += tokens;

  summary.total += 1;
  summary.tokens += tokens;
  if (timestamp) {
    summary.events.push(activityEvent({
      timestamp,
      type: 'output.record',
      severity: 'info',
      agentId,
      count: 1,
      summary: `${agentLabel(agentId)} processed ${eventName}`,
    }));
    trimCachedOutputEvents(summary, cachedOutputEventsPerFile);
  }
}

function trimCachedOutputEvents(summary, limit) {
  summary.events = summary.events.slice(-Math.max(0, limit));
}

function logPartialIndexProgress(fileSummary) {
  if (!fileSummary || !fileSummary.file) return;
  const filePath = fileSummary.file.path;
  if (!filePath) return;

  if (fileSummary.indexing) {
    const indexed = fileSummary.file.indexedBytes || 0;
    const total = fileSummary.file.sizeBytes || 0;
    const lastLogged = partialIndexLogState.get(filePath);
    if (lastLogged === indexed) return;
    partialIndexLogState.set(filePath, indexed);
    const remaining = Math.max(0, total - indexed);
    const indexedMib = (indexed / (1024 * 1024)).toFixed(2);
    const totalMib = (total / (1024 * 1024)).toFixed(2);
    const remainingMib = (remaining / (1024 * 1024)).toFixed(2);
    console.warn(
      `[overview] partial index: file=${fileSummary.file.name} `
        + `indexed=${indexedMib}MiB/${totalMib}MiB remaining=${remainingMib}MiB `
        + '— last activity may lag behind real time until further refreshes catch up '
        + '(per-refresh budget=5MiB / 20k lines)',
    );
    return;
  }

  if (partialIndexLogState.has(filePath)) {
    partialIndexLogState.delete(filePath);
    console.warn(
      `[overview] index caught up: file=${fileSummary.file.name} — last activity is now real-time`,
    );
  }
}

function newOutputCacheEntry(filePath, date, fileStat) {
  const summary = emptyFileSummary(filePath);
  return {
    version: OVERVIEW_CACHE_VERSION,
    path: filePath,
    date,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    dev: fileStat.dev,
    ino: fileStat.ino,
    indexedThroughOffset: 0,
    indexing: fileStat.size > 0,
    file: fileMetadata(filePath, fileStat, 0, fileStat.size > 0),
    summary,
  };
}

function validOutputCacheEntry(entry, filePath, fileStat) {
  if (!entry || entry.version !== OVERVIEW_CACHE_VERSION || entry.path !== filePath) return null;
  if (!Number.isFinite(entry.indexedThroughOffset) || entry.indexedThroughOffset < 0) return null;
  if (!entry.summary || typeof entry.summary !== 'object') return null;
  if (Number.isFinite(entry.size) && entry.size < entry.indexedThroughOffset) return null;
  if (entry.indexedThroughOffset > fileStat.size) return null;
  if (entry.indexedThroughOffset === fileStat.size) {
    if (Number.isFinite(entry.size) && entry.size !== fileStat.size) return null;
    if (Number.isFinite(entry.mtimeMs) && Math.abs(entry.mtimeMs - fileStat.mtimeMs) > 1) {
      return null;
    }
  }
  if (Number.isFinite(entry.dev) && Number.isFinite(entry.ino)
    && (entry.dev !== fileStat.dev || entry.ino !== fileStat.ino)) {
    return null;
  }
  return entry;
}

function fileMetadata(filePath, fileStat, indexedThroughOffset, indexing) {
  return {
    path: filePath,
    name: path.basename(filePath),
    sizeBytes: fileStat.size,
    indexedBytes: Math.min(indexedThroughOffset, fileStat.size),
    updatedAt: fileStat.mtime.toISOString(),
    partial: Boolean(indexing),
  };
}

function cloneSummary(summary) {
  return JSON.parse(JSON.stringify(summary));
}

function pruneOverviewCache(cache, activeFileKeys, date) {
  for (const [filePath, entry] of Object.entries(cache.files)) {
    if (entry?.date !== date || !activeFileKeys.has(filePath)) delete cache.files[filePath];
  }
}

function emptyFileSummary(filePath) {
  return {
    file: {
      path: filePath,
      name: path.basename(filePath),
      sizeBytes: 0,
      updatedAt: null,
      partial: false,
    },
    byAgent: {},
    events: [],
    total: 0,
    tokens: 0,
    partial: false,
    indexing: false,
  };
}

async function aggregateFailedUploads(failedDir, options) {
  const entries = await safeReaddir(failedDir);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(failedDir, entry.name));
  const events = [];
  let total = 0;

  for (const filePath of files) {
    const text = await readTail(filePath, options.maxBytes);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      total += 1;
      const timestamp = typeof row.ts === 'number' ? new Date(row.ts).toISOString() : new Date().toISOString();
      events.push(activityEvent({
        timestamp,
        type: 'reporting.failure',
        severity: 'error',
        summary: 'Upload failed; diagnostic metadata was saved locally',
        details: {
          endpoint: row.endpoint,
          project: row.project,
          logstore: row.logstore,
          errorType: row.error_type,
          errorCode: row.error_code,
          httpStatus: row.http_status,
          error: row.error_summary,
          batchCount: row.batch_count,
          batchBytes: row.batch_bytes,
          file: path.basename(filePath),
        },
      }));
    }
  }

  events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return { total, events };
}

function buildMethodStates(serviceLog, output, now) {
  const states = { ...serviceLog.methodStates };
  for (const agent of AGENTS) {
    for (const methodId of agent.methods) ensureMethod(states, methodId);
  }

  for (const [agentId, agentOutput] of Object.entries(output.byAgent)) {
    const agent = AGENT_BY_ID.get(agentId);
    if (!agent) continue;
    for (const methodId of agent.methods) {
      const method = ensureMethod(states, methodId);
      method.outputToday += agentOutput.total;
      method.lastOutputAt = maxIso(method.lastOutputAt, agentOutput.lastActivityAt);
      method.lastSeenAt = maxIso(method.lastSeenAt, agentOutput.lastActivityAt);
    }
  }

  for (const state of Object.values(states)) {
    state.status = methodStatus(state, now);
  }
  return states;
}

function buildAgentSummaries({ methodStates, output, service, now }) {
  return AGENTS.map((agent) => {
    const outputSummary = output.byAgent[agent.id] || emptyAgentOutput();
    const methods = agent.methods.map((methodId) => {
      const method = methodStates[methodId] || ensureMethod({}, methodId);
      return {
        id: methodId,
        label: METHOD_LABELS[methodId] || methodId,
        status: service.running ? method.status : 'not_detected',
        registered: Boolean(method.registered),
        started: Boolean(method.started),
        dispatchedToday: method.dispatchedToday,
        outputToday: method.outputToday,
        lastSeenAt: method.lastSeenAt || null,
        lastDispatchAt: method.lastDispatchAt || null,
        lastOutputAt: method.lastOutputAt || null,
      };
    });
    const lastActivityAt = outputSummary.lastActivityAt || null;
    const status = service.running ? agentStatus(outputSummary, lastActivityAt, now) : 'not_detected';
    const warnings = [];
    if (output.partial) warnings.push('Output totals are still indexing local JSONL files.');
    if (agent.id === 'qoder-combined' && outputSummary.total > 0) {
      warnings.push('Some Qoder-family records could not be split reliably.');
    }

    return {
      id: agent.id,
      label: agent.label,
      status,
      hiddenWhenEmpty: Boolean(agent.hiddenWhenEmpty),
      todayEvents: outputSummary.total,
      tokensToday: outputSummary.tokens,
      eventTypes: outputSummary.eventTypes,
      collectionTypes: agent.collectionTypes,
      lastActivityAt,
      warnings,
      methods,
    };
  });
}

function buildReportingSummary(config, output, failures) {
  const sls = config.sls || {};
  const http = config.http || {};
  const jsonl = config.jsonl || {};
  const slsEnabled = resolveSlsEnabled(config);
  const jsonlEnabled = jsonl.enabled !== false;
  const httpEnabled = Boolean(http.enabled || http.url);

  const channels = [
    {
      id: 'jsonl',
      label: 'Local JSONL backup',
      enabled: jsonlEnabled,
      status: jsonlEnabled && output.total > 0 ? 'normal' : jsonlEnabled ? 'idle' : 'disabled',
      message: jsonlEnabled ? 'Local backup normal' : 'Local backup disabled',
    },
    {
      id: 'sls',
      label: 'SLS',
      enabled: slsEnabled,
      status: !slsEnabled ? 'disabled' : failures.total > 0 ? 'warning' : 'best_available',
      message: !slsEnabled
        ? 'SLS reporting disabled'
        : failures.total > 0
          ? `${failures.total} persisted upload failures detected`
          : 'SLS enabled; no persisted upload failures detected',
    },
    {
      id: 'http',
      label: 'HTTP',
      enabled: httpEnabled,
      status: httpEnabled ? 'best_available' : 'disabled',
      message: httpEnabled ? 'HTTP reporting enabled' : 'HTTP reporting disabled',
    },
  ];

  return {
    status: failures.total > 0 ? 'warning' : 'normal',
    wording: 'Remote upload success is best available until durable success metrics are recorded.',
    processedToday: output.total,
    localBackupEventsToday: output.total,
    failedUploadsToday: failures.total,
    channels,
  };
}

function resolveSlsEnabled(config) {
  const sls = config.sls || {};
  if (sls.enabled !== undefined) return Boolean(sls.enabled);

  const destinationOverride = sls.destinationOverride === true;
  const mode = normalizeSlsMode(
    process.env.LOONGSUITE_SLS_MODE
      ?? (destinationOverride ? sls.mode : undefined)
      ?? 'webtracking',
  );

  const endpoint = process.env.LOONGSUITE_SLS_ENDPOINT
    ?? (destinationOverride ? sls.endpoint : undefined)
    ?? '__internal_sls_endpoint__';
  const project = process.env.LOONGSUITE_SLS_PROJECT
    ?? (destinationOverride ? sls.project : undefined)
    ?? '__internal_sls_project__';
  const logstore = process.env.LOONGSUITE_SLS_LOGSTORE
    ?? (destinationOverride ? sls.logstore : undefined)
    ?? '__internal_sls_logstore__';
  const hasEndpoint = Boolean(project && logstore);

  if (mode === 'webtracking') return Boolean(endpoint && hasEndpoint);

  const accessKeyId = process.env.LOONGSUITE_SLS_ACCESS_KEY_ID
    ?? (destinationOverride ? sls.accessKeyId : undefined)
    ?? '';
  const accessKeySecret = process.env.LOONGSUITE_SLS_ACCESS_KEY_SECRET
    ?? (destinationOverride ? sls.accessKeySecret : undefined)
    ?? '';
  return Boolean(accessKeyId && accessKeySecret && endpoint && hasEndpoint);
}

function normalizeSlsMode(mode) {
  return mode === 'ak' ? 'ak' : 'webtracking';
}

function buildTimeline({ serviceLog, output, failures, limit }) {
  const outputEvents = output.events
    .slice(-limit)
    .map((event) => ({
      ...event,
      type: 'collection.output',
      summary: `${agentLabel(event.agentId)} processed an event`,
    }));
  return [
    ...serviceLog.events,
    ...outputEvents,
    ...failures.events,
  ]
    .filter((event) => event.timestamp)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
    .slice(-limit)
    .reverse();
}

function ensureMethod(states, methodId) {
  if (!states[methodId]) {
    states[methodId] = {
      id: methodId,
      registered: false,
      started: false,
      dispatchedToday: 0,
      outputToday: 0,
      lastSeenAt: null,
      lastDispatchAt: null,
      lastOutputAt: null,
      status: 'unavailable',
    };
  }
  return states[methodId];
}

function ensureAgentOutput(byAgent, agentId) {
  if (!byAgent[agentId]) byAgent[agentId] = emptyAgentOutput();
  return byAgent[agentId];
}

function emptyAgentOutput() {
  return {
    total: 0,
    tokens: 0,
    eventTypes: {},
    methods: {},
    lastActivityAt: null,
  };
}

function mergeAgentOutput(target, source) {
  target.total += source.total;
  target.tokens += source.tokens;
  target.lastActivityAt = maxIso(target.lastActivityAt, source.lastActivityAt);
  for (const [eventName, count] of Object.entries(source.eventTypes)) {
    target.eventTypes[eventName] = (target.eventTypes[eventName] || 0) + count;
  }
  for (const [methodId, method] of Object.entries(source.methods)) {
    const targetMethod = ensureMethodOutput(target.methods, methodId);
    targetMethod.count += method.count;
    targetMethod.tokens += method.tokens;
    targetMethod.lastActivityAt = maxIso(targetMethod.lastActivityAt, method.lastActivityAt);
  }
}

function ensureMethodOutput(methods, methodId) {
  if (!methods[methodId]) {
    methods[methodId] = { count: 0, tokens: 0, lastActivityAt: null };
  }
  return methods[methodId];
}

function methodStatus(method, now) {
  if (method.outputToday > 0 || method.dispatchedToday > 0) {
    if (method.lastSeenAt && now.getTime() - new Date(method.lastSeenAt).getTime() > STALE_AFTER_MS) {
      return 'no_recent_activity';
    }
    return 'active';
  }
  return 'not_detected';
}

function agentStatus(outputSummary, lastActivityAt, now) {
  if (outputSummary.total > 0) {
    if (lastActivityAt && now.getTime() - new Date(lastActivityAt).getTime() > STALE_AFTER_MS) return 'no_recent_activity';
    return 'active';
  }
  return 'not_detected';
}

function activityEvent(event) {
  return {
    timestamp: event.timestamp,
    type: event.type,
    severity: event.severity || 'info',
    agentId: event.agentId,
    agentLabel: event.agentId ? agentLabel(event.agentId) : undefined,
    methodId: event.methodId,
    count: event.count,
    summary: event.summary,
    details: event.details,
  };
}

function agentLabel(agentId) {
  return AGENT_BY_ID.get(agentId)?.label || agentId || 'LoongSuite Pilot';
}

function recordTime(record) {
  const rawNano = stringValue(record.time_unix_nano || record.observed_time_unix_nano);
  if (/^\d+$/.test(rawNano)) {
    const ms = Number(BigInt(rawNano) / 1_000_000n);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const timestamp = record.timestamp || record.logTime;
  if (typeof timestamp === 'number') return new Date(timestamp).toISOString();
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

async function readTail(filePath, maxBytes) {
  const fileStat = await safeStat(filePath);
  if (!fileStat || fileStat.size === 0) return '';
  const start = Math.max(0, fileStat.size - maxBytes);
  const length = fileStat.size - start;
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    await handle.close();
  }
}

async function readJsonlChunk(filePath, options) {
  const remaining = Math.max(0, options.fileSize - options.start);
  if (remaining === 0) return { lines: [], nextOffset: options.start };
  const length = Math.min(remaining, options.maxBytes);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, options.start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const reachedEof = options.start + bytesRead >= options.fileSize;
    const lastNewline = text.lastIndexOf('\n');
    let processText = text;
    let nextOffset = options.start + bytesRead;

    if (!reachedEof) {
      if (lastNewline < 0) {
        return { lines: [], nextOffset: options.start };
      }
      processText = text.slice(0, lastNewline + 1);
      nextOffset = options.start + Buffer.byteLength(processText);
    }

    const availableLines = processText.split(/\r?\n/).filter(Boolean);
    const lines = availableLines.slice(0, options.maxLines);
    if (availableLines.length > lines.length) {
      nextOffset = options.start + Buffer.byteLength(`${lines.join('\n')}\n`);
    }
    return { lines, nextOffset };
  } finally {
    await handle.close();
  }
}

async function loadOverviewCache(cachePath) {
  const raw = await safeReadFile(cachePath, 'utf8');
  if (!raw) return emptyOverviewCache();
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== OVERVIEW_CACHE_VERSION || !parsed.files || typeof parsed.files !== 'object') {
      return emptyOverviewCache();
    }
    return {
      version: OVERVIEW_CACHE_VERSION,
      files: parsed.files,
    };
  } catch {
    return emptyOverviewCache();
  }
}

function emptyOverviewCache() {
  return {
    version: OVERVIEW_CACHE_VERSION,
    files: {},
  };
}

async function saveOverviewCache(cachePath, cache) {
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await rename(tmpPath, cachePath);
  } catch {}
}

async function safeReadFile(filePath, encoding) {
  try {
    return await readFile(filePath, encoding);
  } catch {
    return null;
  }
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function latestIso(values) {
  return values.filter(Boolean).reduce((latest, value) => maxIso(latest, value), null);
}

export async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function streamFile(filePath) {
  return createReadStream(filePath);
}
