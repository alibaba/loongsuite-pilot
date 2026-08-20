import path from 'node:path';
import { inferGitContext } from '../utils/git-context.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GitContextEnrichment');

const NAMESPACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'cursor-cli': ['cursor-cli', 'cursor_cli'],
  cursor_cli: ['cursor_cli', 'cursor-cli'],
  'qoder-cli': ['qoder-cli', 'qoder'],
  'qoder-idea': ['qoder-idea', 'qoder'],
  'qoder-cn': ['qoder-cn', 'qodercn', 'qoder'],
  qodercn: ['qodercn', 'qoder-cn', 'qoder'],
  'qoder-work': ['qoder-work', 'qoderwork'],
  'qoder-work-cn': ['qoder-work-cn', 'qoderwork'],
  'qwen-work-cn': ['qwen-work-cn', 'qwenworkcn'],
};

export async function enrichCanonicalEntryWithGit(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string | readonly string[],
): Promise<void> {
  const probeDir = extractProbeDir(entry, record, namespace);
  if (probeDir && !entry['workspace.path']) entry['workspace.path'] = probeDir;

  if (entry['git.repo'] && entry['git.branch']) return;
  if (!probeDir) return;

  const inferred = await inferGitContext(probeDir);
  if (!entry['git.repo'] && inferred.repo) entry['git.repo'] = inferred.repo;
  if (!entry['git.branch'] && inferred.branch) entry['git.branch'] = inferred.branch;
  if (!entry['git.domain'] && inferred.domain) entry['git.domain'] = inferred.domain;
  if (!entry['workspace.current_root'] && inferred.root) entry['workspace.current_root'] = inferred.root;
}

/**
 * Last-mile enrichment for inputs that emit canonical Agent records directly.
 *
 * Hook-based inputs normally enrich before reaching InputManager. Transcript
 * inputs such as Codex can emit from several recovery/fusion paths, so doing a
 * guarded pass at the shared dispatch boundary keeps those paths consistent.
 * Enrichment only fills missing canonical values, while inferGitContext caches
 * repeated probes (including non-repository directories), so this is safe for
 * entries that were already enriched upstream.
 */
export async function enrichCanonicalEntriesWithGit(
  entries: Record<string, unknown>[],
): Promise<void> {
  for (const entry of entries) {
    try {
      const agentType = normalizeString(entry['gen_ai.agent.type']);
      if (!agentType) continue;
      await enrichCanonicalEntryWithGit(entry, entry, agentType);
    } catch (err) {
      logger.warn('git context enrichment failed for entry (skipped)', {
        error: String(err),
      });
    }
  }
}

function extractProbeDir(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string | readonly string[],
): string | undefined {
  const workspacePath = normalizeString(entry['workspace.path'])
    ?? normalizeString(record['workspace.path']);
  if (workspacePath && isAbsolutePath(workspacePath)) return workspacePath;

  for (const candidate of expandNamespaces(namespace)) {
    const cwd = normalizeString(entry[`agent.${candidate}.cwd`])
      ?? normalizeString(record[`agent.${candidate}.cwd`]);
    if (cwd && isAbsolutePath(cwd)) return cwd;

    const roots = entry[`agent.${candidate}.workspace_roots`]
      ?? record[`agent.${candidate}.workspace_roots`];
    const rootList = normalizeStringArray(roots);
    if (rootList.length > 0 && isAbsolutePath(rootList[0])) return rootList[0];
  }

  return undefined;
}

function expandNamespaces(namespace: string | readonly string[]): string[] {
  const requested = typeof namespace === 'string' ? [namespace] : namespace;
  const expanded: string[] = [];
  for (const value of requested) {
    for (const candidate of NAMESPACE_ALIASES[value] ?? [value]) {
      if (!expanded.includes(candidate)) expanded.push(candidate);
    }
  }
  return expanded;
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch { /* not JSON, treat as single value */ }
    return [value].map(v => v.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : undefined)
    .filter((item): item is string => !!item);
}
