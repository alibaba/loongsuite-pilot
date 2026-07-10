import * as fs from 'node:fs';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GlobalAttributes');

/**
 * Git/workspace attributes produced by enrich-git-context.ts. Always passed
 * through onto trace spans (independent of user-defined attributes).
 */
export const DEFAULT_GIT_PASSTHROUGH_KEYS = [
  'git.repo',
  'git.branch',
  'git.domain',
  'workspace.current_root',
] as const;

/**
 * Prefixes reserved for converter-managed / pipeline fields. User-defined
 * custom attributes matching these are dropped to avoid clobbering semantics.
 */
const RESERVED_PREFIXES = [
  'gen_ai.',
  'git.',
  'workspace.',
  'event.',
  'trace_',
  'user.',
  'cost_',
  'agent.',
  'time_unix_nano',
  'observed_time_unix_nano',
];

export function isReservedKey(key: string): boolean {
  return RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p));
}

/**
 * Parse OTel-style `key1=value1,key2=value2` into a string map. Kept simple:
 * split on `,`, then on the first `=`; trim; skip empty/malformed entries.
 */
export function parseKeyValueAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** Coerce a value to a string attribute, or undefined to skip (objects/arrays). */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * Sanitize a candidate attribute map: drop reserved-prefix keys and
 * non-string(-coercible) values.
 */
export function sanitizeAttributes(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (isReservedKey(key)) continue;
    const value = coerceString(rawValue);
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolves user-defined global span attributes from a static baseline
 * (config + env, captured at startup) merged with a mutable JSON file that is
 * re-read on change (mtime-cached). File values win over the baseline.
 *
 * These attributes are injected into trace spans only (not the event log).
 */
export class GlobalAttributesProvider {
  private readonly baseline: Record<string, string>;
  private readonly filePath: string;
  private cachedMtimeMs = -1;
  private cachedFileAttrs: Record<string, string> = {};
  private cachedMerged: Record<string, string>;

  constructor(baseline: Record<string, string>, filePath: string) {
    this.baseline = sanitizeAttributes(baseline);
    this.filePath = filePath;
    this.cachedMerged = { ...this.baseline };
  }

  /** Merged attributes (baseline < file). Cheap: only re-reads file on mtime change. */
  resolve(): Record<string, string> {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      // File missing (or stat failed): reset to baseline once.
      if (this.cachedMtimeMs !== -1) {
        this.cachedMtimeMs = -1;
        this.cachedFileAttrs = {};
        this.cachedMerged = { ...this.baseline };
      }
      return this.cachedMerged;
    }

    if (mtimeMs === this.cachedMtimeMs) return this.cachedMerged;

    this.cachedMtimeMs = mtimeMs;
    this.cachedFileAttrs = this.readFileAttrs();
    this.cachedMerged = { ...this.baseline, ...this.cachedFileAttrs };
    return this.cachedMerged;
  }

  /** Attribute keys of the current merged map. */
  keys(): string[] {
    return Object.keys(this.resolve());
  }

  private readFileAttrs(): Record<string, string> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        logger.warn('span-attributes file is not a JSON object; ignoring', { filePath: this.filePath });
        return {};
      }
      return sanitizeAttributes(parsed as Record<string, unknown>);
    } catch (err) {
      logger.warn('failed to read span-attributes file; falling back to baseline', {
        filePath: this.filePath,
        error: String(err),
      });
      return {};
    }
  }
}
