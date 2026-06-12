import type { JsonValue } from '../types/index.js';

export interface SourceContextInput {
  repo?: unknown;
  branch?: unknown;
  domain?: unknown;
  cwd?: unknown;
  workspaceRoots?: unknown;
  absolutePaths?: unknown[];
}

export interface NormalizedSourceContext {
  repo?: string;
  branch?: string;
  currentRoot?: string;
  domain?: string;
}

export function normalizeSourceContext(input: SourceContextInput): NormalizedSourceContext {
  const cwd = normalizeString(input.cwd);
  const roots = normalizeStringArray(input.workspaceRoots);
  const absolutePaths = (input.absolutePaths ?? [])
    .flatMap(value => normalizeStringArray(value))
    .filter(isAbsolutePath);

  return {
    repo: normalizeRepo(input.repo),
    branch: normalizeString(input.branch),
    domain: normalizeString(input.domain),
    currentRoot: selectCurrentRoot({ cwd, roots, absolutePaths }),
  };
}

export function sourceFieldsFromContext(context: NormalizedSourceContext): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  if (context.repo) {
    fields['git.repo'] = context.repo;
  }
  if (context.branch) fields['git.branch'] = context.branch;
  if (context.domain) fields['git.domain'] = context.domain;
  if (context.currentRoot) fields['workspace.current_root'] = context.currentRoot;
  return fields;
}

export function pickFirstValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

export function readRecordPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function collectAbsolutePathValues(value: unknown): string[] {
  const out = new Set<string>();
  collectAbsolutePathValuesInto(value, out);
  return [...out].sort();
}

function collectAbsolutePathValuesInto(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || value === undefined || value === null) return;
  if (typeof value === 'string') {
    for (const candidate of value.split(/\s+/)) {
      const cleaned = candidate.replace(/^['"]|['",;)]$/g, '');
      if (isAbsolutePath(cleaned)) out.add(cleaned);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePathValuesInto(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectAbsolutePathValuesInto(nested, out, depth + 1);
  }
}

export function normalizeDomain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const httpsMatch = raw.match(/^https?:\/\/([^/]+)/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = raw.match(/^[^@]+@([^:]+)/);
  if (sshMatch) return sshMatch[1];
  return undefined;
}

function normalizeRepo(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;
  return raw
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^[^@]+@([^:]+)[:/]/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value].map(v => v.trim()).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : undefined)
    .filter((item): item is string => !!item);
}

function selectCurrentRoot(input: { cwd?: string; roots: string[]; absolutePaths: string[] }): string | undefined {
  const normalizedRoots = [...new Set(input.roots.map(stripTrailingSlash).filter(Boolean))];
  if (normalizedRoots.length === 0) return undefined;

  const candidates = [input.cwd, ...input.absolutePaths].filter((value): value is string => !!value && isAbsolutePath(value));
  for (const candidate of candidates) {
    const root = longestContainingRoot(candidate, normalizedRoots);
    if (root) return root;
  }
  if (normalizedRoots.length === 1) return normalizedRoots[0];
  return undefined;
}

function longestContainingRoot(value: string, roots: string[]): string | undefined {
  const normalizedValue = stripTrailingSlash(value);
  return roots
    .filter(root => normalizedValue === root || normalizedValue.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/');
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '') || '/';
}

