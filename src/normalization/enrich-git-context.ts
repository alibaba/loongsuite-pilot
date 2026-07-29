import { inferGitContext } from '../utils/git-context.js';

export async function enrichCanonicalEntryWithGit(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string,
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

function extractProbeDir(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string,
): string | undefined {
  const cwd = normalizeString(entry[`agent.${namespace}.cwd`])
    ?? normalizeString(record[`agent.${namespace}.cwd`]);
  if (cwd?.startsWith('/')) return cwd;

  const roots = entry[`agent.${namespace}.workspace_roots`]
    ?? record[`agent.${namespace}.workspace_roots`];
  const rootList = normalizeStringArray(roots);
  if (rootList.length > 0 && rootList[0].startsWith('/')) return rootList[0];

  return undefined;
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
