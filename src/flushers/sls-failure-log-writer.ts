import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';

const logger = createLogger('SlsFailureLogWriter');

const MEBIBYTE = 1024 * 1024;

export const SLS_FAILURE_LOG_SCHEMA_VERSION = 2;
export const SLS_FAILURE_LOG_MAX_FILE_BYTES = 10 * MEBIBYTE;
export const SLS_FAILURE_LOG_MAX_TOTAL_BYTES = 50 * MEBIBYTE;
export const SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES = 2 * 1024;

export interface SlsFailureLogInput {
  endpoint: string;
  mode: string;
  project: string;
  logstore: string;
  kind: string;
  batchCount: number;
  batchBytes: number;
  error: unknown;
}

export interface SlsFailureLogRecord {
  schema_version: 2;
  ts: number;
  endpoint: string;
  mode: string;
  project: string;
  logstore: string;
  kind: string;
  error_type: string;
  error_code: string;
  http_status: number;
  error_summary: string;
  batch_count: number;
  batch_bytes: number;
}

export interface SlsFailureLogWriterOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

interface FileState {
  date: string;
  segment: number;
  filePath: string;
}

interface LogFileInfo {
  file: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
  group: string | null;
  segment: number | null;
  date: string | null;
}

const ROTATED_FILE_REGEX = /^(.*)-(\d+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class SlsFailureLogWriter {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => Date;
  private readonly states = new Map<string, FileState>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(directory: string, options: SlsFailureLogWriterOptions = {}) {
    this.directory = path.resolve(directory);
    this.maxFileBytes = options.maxFileBytes ?? SLS_FAILURE_LOG_MAX_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? SLS_FAILURE_LOG_MAX_TOTAL_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await ensureDir(this.directory);
  }

  async write(input: SlsFailureLogInput): Promise<boolean> {
    let written = false;
    const operation = this.writeChain.then(async () => {
      written = await this.writeOnce(input);
    });
    this.writeChain = operation.catch(() => {});
    try {
      await operation;
      return written;
    } catch (err) {
      logger.warn('failed to persist SLS failure metadata', {
        endpoint: input.endpoint,
        error: String(err),
      });
      return false;
    }
  }

  private async writeOnce(input: SlsFailureLogInput): Promise<boolean> {
    await ensureDir(this.directory);

    const now = this.now();
    const record = buildSlsFailureLogRecord(input, now);
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    const safeEndpoint = safeEndpointFilePrefix(input.endpoint);
    const state = await this.resolveFileState(safeEndpoint, localDateString(now), lineBytes);

    if (!isPathInside(this.directory, state.filePath)) {
      logger.warn('refusing SLS failure log path outside target directory', {
        endpoint: input.endpoint,
      });
      return false;
    }

    const hasCapacity = await this.ensureCapacity(lineBytes, state.filePath);
    if (!hasCapacity) {
      logger.warn('SLS failure metadata dropped because directory limit is exhausted', {
        endpoint: input.endpoint,
        maxTotalBytes: this.maxTotalBytes,
      });
      return false;
    }

    await fs.appendFile(state.filePath, line, 'utf8');
    return true;
  }

  private async resolveFileState(
    safeEndpoint: string,
    date: string,
    lineBytes: number,
  ): Promise<FileState> {
    const key = `${safeEndpoint}|${date}`;
    let state = this.states.get(key);
    if (!state) {
      const segment = await this.findLatestSegment(safeEndpoint, date);
      state = {
        date,
        segment,
        filePath: this.buildFilePath(safeEndpoint, segment, date),
      };
    }

    const stat = await safeLstat(state.filePath);
    if (stat?.isFile() && stat.size > 0 && stat.size + lineBytes > this.maxFileBytes) {
      state = {
        date,
        segment: state.segment + 1,
        filePath: this.buildFilePath(safeEndpoint, state.segment + 1, date),
      };
    }

    this.states.set(key, state);
    return state;
  }

  private async findLatestSegment(safeEndpoint: string, date: string): Promise<number> {
    let latest = 0;
    const prefix = `${safeEndpoint}-`;
    const suffix = `-${date}.jsonl`;
    const entries = await safeReaddir(this.directory);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
      const segmentText = entry.name.slice(prefix.length, -suffix.length);
      if (!/^\d+$/.test(segmentText)) continue;
      latest = Math.max(latest, Number(segmentText));
    }
    return latest;
  }

  private buildFilePath(safeEndpoint: string, segment: number, date: string): string {
    return path.join(
      this.directory,
      `${safeEndpoint}-${String(segment).padStart(4, '0')}-${date}.jsonl`,
    );
  }

  private async ensureCapacity(incomingBytes: number, targetPath: string): Promise<boolean> {
    const files = await this.collectLogFiles();
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes + incomingBytes <= this.maxTotalBytes) return true;

    const activePaths = findActivePaths(files, targetPath, localDateString(this.now()));
    const candidates = files
      .filter(file => !activePaths.has(file.fullPath))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')
        || a.mtimeMs - b.mtimeMs
        || a.file.localeCompare(b.file));

    for (const file of candidates) {
      if (totalBytes + incomingBytes <= this.maxTotalBytes) break;
      try {
        await fs.unlink(file.fullPath);
        totalBytes -= file.size;
      } catch (err) {
        logger.warn('failed to remove sealed SLS failure log segment', {
          file: file.file,
          error: String(err),
        });
      }
    }

    return totalBytes + incomingBytes <= this.maxTotalBytes;
  }

  private async collectLogFiles(): Promise<LogFileInfo[]> {
    const result: LogFileInfo[] = [];
    const entries = await safeReaddir(this.directory);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const fullPath = path.join(this.directory, entry.name);
      const stat = await safeLstat(fullPath);
      if (!stat?.isFile()) continue;
      const parsed = parseRotatedFile(entry.name);
      result.push({
        file: entry.name,
        fullPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        group: parsed?.group ?? null,
        segment: parsed?.segment ?? null,
        date: parsed?.date ?? null,
      });
    }
    return result;
  }
}

export function buildSlsFailureLogRecord(
  input: SlsFailureLogInput,
  now = new Date(),
): SlsFailureLogRecord {
  const errorObject = asErrorObject(input.error);
  return {
    schema_version: SLS_FAILURE_LOG_SCHEMA_VERSION,
    ts: now.getTime(),
    endpoint: boundedString(input.endpoint, 256),
    mode: boundedString(input.mode, 64),
    project: boundedString(input.project, 256),
    logstore: boundedString(input.logstore, 256),
    kind: boundedString(input.kind, 128),
    error_type: boundedString(errorObject.type, 128),
    error_code: boundedString(errorObject.code, 128),
    http_status: errorObject.httpStatus,
    error_summary: truncateUtf8(redactErrorSummary(errorObject.summary), SLS_FAILURE_ERROR_SUMMARY_MAX_BYTES),
    batch_count: boundedNonNegativeInteger(input.batchCount),
    batch_bytes: boundedNonNegativeInteger(input.batchBytes),
  };
}

export function safeEndpointFilePrefix(endpoint: string): string {
  const normalized = endpoint.normalize('NFKC');
  const base = normalized
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48) || 'endpoint';
  const hash = createHash('sha256').update(endpoint).digest('hex').slice(0, 10);
  return `${base}-${hash}`;
}

export function estimateStringRecordBytes(records: Record<string, string>[]): number {
  let total = 0;
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      total += Buffer.byteLength(key) + Buffer.byteLength(value) + 6;
    }
    total += 2;
  }
  return total;
}

function asErrorObject(error: unknown): {
  type: string;
  code: string;
  httpStatus: number;
  summary: string;
} {
  const value = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : null;
  const status = Number(value?.status ?? value?.statusCode ?? 0);
  const type = error instanceof Error
    ? error.name || error.constructor.name
    : typeof error;
  const summary = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return {
    type: type || 'Error',
    code: typeof value?.code === 'string' ? value.code : '',
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
    summary,
  };
}

function redactErrorSummary(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, '[REDACTED_ACCESS_KEY]')
    .replace(
      /((?:access[_-]?key(?:[_-]?(?:id|secret))?|api[_-]?key|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

function boundedString(value: string, maxBytes: number): string {
  return truncateUtf8(String(value ?? ''), maxBytes);
}

function boundedNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseRotatedFile(file: string): { group: string; segment: number; date: string } | null {
  const match = ROTATED_FILE_REGEX.exec(file);
  if (!match) return null;
  return { group: `${match[1]}|${match[3]}`, segment: Number(match[2]), date: match[3] };
}

function findActivePaths(files: LogFileInfo[], targetPath: string, today: string): Set<string> {
  const latestByGroup = new Map<string, LogFileInfo>();
  for (const file of files) {
    if (!file.group || file.date !== today || file.segment === null) continue;
    const current = latestByGroup.get(file.group);
    if (!current || (current.segment ?? -1) < file.segment) latestByGroup.set(file.group, file);
  }

  const target = parseRotatedFile(path.basename(targetPath));
  if (target?.date === today) latestByGroup.delete(target.group);
  return new Set([...latestByGroup.values()].map(file => file.fullPath).concat(targetPath));
}

async function safeReaddir(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeLstat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}
