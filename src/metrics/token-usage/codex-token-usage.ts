import { createReadStream, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import {
  type CodexDailyUsageCollectionResult,
  computeTotalTokens,
  type TokenUsageTotals,
  zeroTokenUsageTotals,
} from './types.js';

const CHARS_PER_TOKEN = 4;
const SESSION_META_PROBE_BYTES = 64 * 1024;
const SESSION_META_PROBE_CHUNK_BYTES = 256;
export const DEFAULT_MAX_CODEX_TOKEN_SCAN_BYTES = 200 * 1024 * 1024;

interface CodexScanCandidate {
  path: string;
  size: number;
}

interface CodexScanPlan {
  date: string;
  codexHome: string;
  files: CodexScanCandidate[];
  candidateBytes: number;
  scanLimitBytes: number;
}

interface JsonRecord {
  type?: unknown;
  timestamp?: unknown;
  payload?: unknown;
}

interface DeferredEstimate {
  timestamp: string;
  timestampMs: number;
  inputChars: number;
  outputChars: number;
}

interface ScanState {
  sessionId: string;
  forkCutoffMs: number | null;
  prevCumulativeTotal: number | null;
  prevInput: number;
  prevCached: number;
  prevOutput: number;
  prevReasoning: number;
  pendingInputChars: number;
  pendingOutputChars: number;
  deferredEstimates: DeferredEstimate[];
}

export interface CollectCodexDailyUsageOptions {
  date?: string;
  codexHome?: string;
  maxScanBytes?: number;
}

export async function collectCodexDailyUsage(
  opts: CollectCodexDailyUsageOptions = {},
): Promise<CodexDailyUsageCollectionResult> {
  const date = opts.date ?? localDateString();
  const codexHome = expandHome(opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const scanPlan = await buildScanPlan(
    codexHome,
    date,
    opts.maxScanBytes ?? DEFAULT_MAX_CODEX_TOKEN_SCAN_BYTES,
  );

  if (scanPlan.candidateBytes > scanPlan.scanLimitBytes) {
    return {
      status: 'skipped',
      date: scanPlan.date,
      codexHome: scanPlan.codexHome,
      reason: 'scan_bytes_limit_exceeded',
      candidateFiles: scanPlan.files.length,
      candidateBytes: scanPlan.candidateBytes,
      scanLimitBytes: scanPlan.scanLimitBytes,
    };
  }

  const totals = zeroTokenUsageTotals();
  const seenKeys = new Set<string>();

  for (const candidate of scanPlan.files) {
    addTotals(totals, await scanFile(candidate.path, candidate.size, date, seenKeys));
  }

  totals.total_tokens = computeTotalTokens(totals);
  return {
    status: 'ok',
    usage: {
      date,
      codex_home: codexHome,
      ...totals,
    },
    candidateFiles: scanPlan.files.length,
    candidateBytes: scanPlan.candidateBytes,
    scanLimitBytes: scanPlan.scanLimitBytes,
  };
}

async function buildScanPlan(codexHome: string, targetDay: string, scanLimitBytes: number): Promise<CodexScanPlan> {
  const preliminaryFiles = await preliminaryCandidateSessionFiles(codexHome, targetDay);
  const files: CodexScanCandidate[] = [];
  let candidateBytes = 0;

  for (const candidate of preliminaryFiles) {
    const firstLine = await readFirstLineBounded(candidate.path);
    if (firstLine === null || !isValidCodexSession(firstLine)) continue;
    files.push(candidate);
    candidateBytes += candidate.size;
  }

  return {
    date: targetDay,
    codexHome,
    files,
    candidateBytes,
    scanLimitBytes,
  };
}

async function preliminaryCandidateSessionFiles(
  codexHome: string,
  targetDay: string,
): Promise<CodexScanCandidate[]> {
  const sessionsDir = path.join(codexHome, 'sessions');
  const dayStartMs = localDayStartMs(targetDay);
  const files: CodexScanCandidate[] = [];

  if (await isDirectory(sessionsDir)) {
    for (const yearName of await sortedDirNames(sessionsDir, isDigits)) {
      const yearDir = path.join(sessionsDir, yearName);
      for (const monthName of await sortedDirNames(yearDir, isDigits)) {
        const monthDir = path.join(yearDir, monthName);
        for (const dayName of await sortedDirNames(monthDir, isDigits)) {
          const dayDir = path.join(monthDir, dayName);
          for (const fileName of await sortedDirNames(dayDir, isRolloutFile, false)) {
            await addCandidateFile(files, path.join(dayDir, fileName), dayStartMs);
          }
        }
      }
    }
  }

  const archivedDir = path.join(codexHome, 'archived_sessions');
  for (const fileName of await sortedDirNames(archivedDir, isRolloutFile, false)) {
    await addCandidateFile(files, path.join(archivedDir, fileName), dayStartMs);
  }

  return files;
}

async function addCandidateFile(
  files: CodexScanCandidate[],
  filePath: string,
  dayStartMs: number,
): Promise<void> {
  try {
    const st = await fsp.stat(filePath);
    if (st.isFile() && st.mtimeMs >= dayStartMs) files.push({ path: filePath, size: st.size });
  } catch (err) {
    if (!isIgnorableFileRaceError(err)) throw err;
    // A session can be archived or restored while the directory is being scanned.
  }
}

async function readFirstLineBounded(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(SESSION_META_PROBE_BYTES);
    let offset = 0;
    while (offset < buffer.length) {
      const chunkBytes = Math.min(SESSION_META_PROBE_CHUNK_BYTES, buffer.length - offset);
      const { bytesRead } = await handle.read(buffer, offset, chunkBytes, offset);
      if (bytesRead === 0) return buffer.toString('utf8', 0, offset);

      const newlineInChunk = buffer.subarray(offset, offset + bytesRead).indexOf(0x0a);
      if (newlineInChunk >= 0) {
        return buffer.toString('utf8', 0, offset + newlineInChunk);
      }

      offset += bytesRead;
    }
    return null;
  } catch (err) {
    if (isIgnorableFileRaceError(err)) return null;
    throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function scanFile(
  filePath: string,
  maxBytes: number,
  targetDay: string,
  seenKeys: Set<string>,
): Promise<TokenUsageTotals> {
  const totals = zeroTokenUsageTotals();
  totals.files_scanned = 1;

  const stem = path.basename(filePath, path.extname(filePath));
  const state: ScanState = {
    sessionId: stem,
    forkCutoffMs: null,
    prevCumulativeTotal: null,
    prevInput: 0,
    prevCached: 0,
    prevOutput: 0,
    prevReasoning: 0,
    pendingInputChars: 0,
    pendingOutputChars: 0,
    deferredEstimates: [],
  };

  let firstLine = true;
  try {
    for await (const line of readLines(filePath, maxBytes)) {
      if (firstLine) {
        firstLine = false;
        if (!isValidCodexSession(line)) return totals;
      }
      if (!line.trim()) continue;
      const entry = parseJsonRecord(line);
      if (!entry || !isRecord(entry.payload)) continue;

      const entryType = asString(entry.type);
      const payload = entry.payload;

      if (entryType === 'session_meta') {
        const sessionId = asString(payload.session_id) ?? asString(payload.id);
        if (sessionId) {
          state.sessionId = sessionId;
        }
        const forkedFromId = asString(payload.forked_from_id);
        if (forkedFromId) {
          const parsedTs = parseTimestampMs(asString(entry.timestamp));
          if (parsedTs !== null) state.forkCutoffMs = parsedTs + 5000;
        }
        continue;
      }

      if (entryType === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = contentText(payload.content, new Set(['input_text', 'text']));
        if (text) {
          state.pendingInputChars += text.length;
        }
        continue;
      }

      if (entryType === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
        state.pendingOutputChars += contentText(payload.content, new Set(['output_text', 'text'])).length;
        continue;
      }

      if (!(entryType === 'event_msg' && payload.type === 'token_count')) continue;

      const timestamp = asString(entry.timestamp);
      const info = payload.info;

      if (!isRecord(info)) {
        deferEstimatedUsage(state, timestamp);
        continue;
      }

      const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : null;
      const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : null;
      const cumulativeTotal = usageNumber(totalUsage, 'total_tokens');
      const parsedEventMs = parseTimestampMs(timestamp);

      if (state.forkCutoffMs !== null && parsedEventMs !== null && parsedEventMs < state.forkCutoffMs) {
        updateCumulativeState(state, totalUsage, cumulativeTotal);
        clearPendingUsage(state);
        continue;
      }

      if (cumulativeTotal > 0 && state.prevCumulativeTotal !== null && cumulativeTotal === state.prevCumulativeTotal) {
        clearPendingUsage(state);
        continue;
      }
      if (cumulativeTotal > 0) state.prevCumulativeTotal = cumulativeTotal;

      let inputTokens = 0;
      let cachedTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;

      if (lastUsage) {
        inputTokens = usageNumber(lastUsage, 'input_tokens');
        cachedTokens = usageNumber(lastUsage, 'cached_input_tokens');
        outputTokens = usageNumber(lastUsage, 'output_tokens');
        reasoningTokens = usageNumber(lastUsage, 'reasoning_output_tokens');
      } else if (cumulativeTotal > 0 && totalUsage) {
        inputTokens = usageNumber(totalUsage, 'input_tokens') - state.prevInput;
        cachedTokens = usageNumber(totalUsage, 'cached_input_tokens') - state.prevCached;
        outputTokens = usageNumber(totalUsage, 'output_tokens') - state.prevOutput;
        reasoningTokens = usageNumber(totalUsage, 'reasoning_output_tokens') - state.prevReasoning;
      }

      updateCumulativeState(state, totalUsage, cumulativeTotal);

      inputTokens = Math.max(0, inputTokens);
      cachedTokens = Math.max(0, cachedTokens);
      outputTokens = Math.max(0, outputTokens);
      reasoningTokens = Math.max(0, reasoningTokens);

      if (parsedEventMs === null) continue;

      if (inputTokens + cachedTokens + outputTokens + reasoningTokens === 0) {
        clearPendingUsage(state);
        continue;
      }

      // A preceding info:null token_count is normally an in-flight heartbeat for
      // this same call. Once exact usage arrives, discard its deferred estimate.
      state.deferredEstimates = [];

      const totalInput = totalUsage ? usageNumber(totalUsage, 'input_tokens') : 0;
      const totalCached = totalUsage ? usageNumber(totalUsage, 'cached_input_tokens') : 0;
      const totalOutput = totalUsage ? usageNumber(totalUsage, 'output_tokens') : 0;
      const totalReasoning = totalUsage ? usageNumber(totalUsage, 'reasoning_output_tokens') : 0;
      const dedupKey =
        cumulativeTotal > 0
          ? `codex:${state.sessionId}:${cumulativeTotal}:` +
            `${totalInput}:${totalCached}:${totalOutput}:${totalReasoning}`
          : `codex:${state.sessionId}:${timestamp}:last:` +
            `${inputTokens}:${cachedTokens}:${outputTokens}:${reasoningTokens}`;
      if (seenKeys.has(dedupKey)) {
        clearPendingUsage(state);
        continue;
      }
      seenKeys.add(dedupKey);

      if (localDateString(new Date(parsedEventMs)) !== targetDay) {
        clearPendingUsage(state);
        continue;
      }

      const freshInput = Math.max(0, inputTokens - cachedTokens);
      totals.calls += 1;
      totals.input_tokens += freshInput;
      totals.cache_read_tokens += cachedTokens;
      totals.output_tokens += outputTokens;
      totals.reasoning_tokens += reasoningTokens;

      clearPendingUsage(state);
    }
  } catch {
    return totals;
  }

  flushDeferredEstimates(state, totals, seenKeys, targetDay);
  if (totals.calls) totals.files_with_usage = 1;
  totals.total_tokens = computeTotalTokens(totals);
  return totals;
}

function deferEstimatedUsage(state: ScanState, timestamp: string | undefined): void {
  const parsedEventMs = parseTimestampMs(timestamp);
  if (parsedEventMs === null || !timestamp) {
    clearPending(state);
    return;
  }
  if (state.forkCutoffMs !== null && parsedEventMs < state.forkCutoffMs) {
    clearPending(state);
    return;
  }

  if (state.pendingInputChars || state.pendingOutputChars) {
    state.deferredEstimates.push({
      timestamp,
      timestampMs: parsedEventMs,
      inputChars: state.pendingInputChars,
      outputChars: state.pendingOutputChars,
    });
  }
  clearPending(state);
}

function flushDeferredEstimates(
  state: ScanState,
  totals: TokenUsageTotals,
  seenKeys: Set<string>,
  targetDay: string,
): void {
  for (const estimate of state.deferredEstimates) {
    const estInput = Math.ceil(estimate.inputChars / CHARS_PER_TOKEN);
    const estOutput = Math.ceil(estimate.outputChars / CHARS_PER_TOKEN);
    const dedupKey = `codex:${state.sessionId}:${estimate.timestamp}:est:${estInput}:${estOutput}`;
    if (seenKeys.has(dedupKey)) {
      continue;
    }
    seenKeys.add(dedupKey);
    if (localDateString(new Date(estimate.timestampMs)) === targetDay) {
      totals.calls += 1;
      totals.estimated_calls += 1;
      totals.input_tokens += estInput;
      totals.output_tokens += estOutput;
      totals.total_tokens = computeTotalTokens(totals);
    }
  }
  state.deferredEstimates = [];
}

function isValidCodexSession(firstLine: string): boolean {
  if (!firstLine.trim()) return false;
  const entry = parseJsonRecord(firstLine);
  if (!entry || entry.type !== 'session_meta' || !isRecord(entry.payload)) return false;
  const originator = asString(entry.payload.originator);
  return !!originator && originator.toLowerCase().startsWith('codex');
}

function contentText(content: unknown, wantedTypes: Set<string>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (wantedTypes.has(asString(item.type) ?? '') && typeof item.text === 'string') {
      texts.push(item.text);
    }
  }
  return texts.join(' ');
}

function usageNumber(obj: Record<string, unknown> | null, key: string): number {
  if (!obj) return 0;
  const value = obj[key];
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : 0;
}

function updateCumulativeState(
  state: ScanState,
  totalUsage: Record<string, unknown> | null,
  cumulativeTotal: number,
): void {
  if (!totalUsage) return;
  if (cumulativeTotal > 0) state.prevCumulativeTotal = cumulativeTotal;
  state.prevInput = usageNumber(totalUsage, 'input_tokens');
  state.prevCached = usageNumber(totalUsage, 'cached_input_tokens');
  state.prevOutput = usageNumber(totalUsage, 'output_tokens');
  state.prevReasoning = usageNumber(totalUsage, 'reasoning_output_tokens');
}

function addTotals(dst: TokenUsageTotals, src: TokenUsageTotals): void {
  dst.calls += src.calls;
  dst.input_tokens += src.input_tokens;
  dst.output_tokens += src.output_tokens;
  dst.cache_read_tokens += src.cache_read_tokens;
  dst.reasoning_tokens += src.reasoning_tokens;
  dst.estimated_calls += src.estimated_calls;
  dst.files_scanned += src.files_scanned;
  dst.files_with_usage += src.files_with_usage;
  dst.total_tokens = computeTotalTokens(dst);
}

function clearPending(state: ScanState): void {
  state.pendingInputChars = 0;
  state.pendingOutputChars = 0;
}

function clearPendingUsage(state: ScanState): void {
  clearPending(state);
  state.deferredEstimates = [];
}

function parseJsonRecord(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localDayStartMs(day: string): number {
  const [year, month, date] = day.split('-').map((v) => Number.parseInt(v, 10));
  if (!year || !month || !date) return Date.now();
  return new Date(year, month - 1, date, 0, 0, 0, 0).getTime();
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function sortedDirNames(
  dir: string,
  predicate: (name: string) => boolean,
  requireDirectory = true,
): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => (requireDirectory ? entry.isDirectory() : entry.isFile()) && predicate(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function* readLines(filePath: string, maxBytes: number): AsyncGenerator<string> {
  if (maxBytes <= 0) return;
  const input = createReadStream(filePath, { encoding: 'utf8', end: maxBytes - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

function isIgnorableFileRaceError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isDigits(name: string): boolean {
  return /^\d+$/.test(name);
}

function isRolloutFile(name: string): boolean {
  return /^rollout-.*\.jsonl$/.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
