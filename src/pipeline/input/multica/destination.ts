import type { PipelineSlsFlusherConfig } from '../../types.js';
import type { SlsEndpoint, SlsFlusherConfig, SlsMode } from '../../../types/index.js';

export type MulticaSlsFlusherConfig = Omit<PipelineSlsFlusherConfig, 'Endpoint' | 'Project' | 'Logstore'> & {
  Endpoint?: string;
  Project?: string;
  Logstore?: string;
};
export type MulticaSlsDefaults = Pick<SlsFlusherConfig, 'enabled' | 'endpoints'>;
export type MulticaDestination = PipelineSlsFlusherConfig & { mode: SlsMode; apiKey?: string };

/** Inherit installed SLS reporting configuration, never CMS trace credentials. */
export function resolveMulticaDestination(flusher?: MulticaSlsFlusherConfig, sls?: MulticaSlsDefaults): MulticaDestination {
  if (flusher !== undefined && flusher.Type !== 'flusher_sls') throw new Error('Expected Multica SLS flusher');
  const explicit = flusher?.Endpoint !== undefined || flusher?.Project !== undefined;
  let target: { Endpoint: string; Project: string } | undefined;
  if (explicit) {
    if (typeof flusher?.Endpoint !== 'string' || typeof flusher.Project !== 'string') {
      throw new Error('Multica SLS Endpoint and Project must be set together');
    }
    target = normalizeTarget(flusher.Endpoint, flusher.Project);
  }
  const logstore = flusher?.Logstore === undefined ? 'multica-logs' : flusher.Logstore.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(logstore)) throw new Error('Invalid Multica SLS Logstore');

  // Multiple original logstores can converge on multica-logs only if their
  // destination AND authentication agree. Do not silently pick the first one.
  const candidates = new Map<string, { target: { Endpoint: string; Project: string }; endpoint: SlsEndpoint }>();
  for (const endpoint of sls?.endpoints ?? []) {
    if (endpoint.kind !== 'agentActivity') continue;
    let normalized: { Endpoint: string; Project: string };
    try { normalized = normalizeTarget(endpoint.endpoint, endpoint.project); }
    catch {
      // A malformed installed target cannot supply inherited credentials, but
      // must not break an independently configured standalone destination.
      if (target) continue;
      throw new Error('Invalid inherited Multica SLS destination');
    }
    if (target && (target.Endpoint !== normalized.Endpoint || target.Project !== normalized.Project)) continue;
    const key = JSON.stringify([normalized.Endpoint, normalized.Project, endpoint.mode,
      endpoint.apiKey ?? '', endpoint.accessKeyId ?? '', endpoint.accessKeySecret ?? '']);
    candidates.set(key, {target: normalized, endpoint});
  }
  if (candidates.size && sls?.enabled === false) throw new Error('Inherited Multica SLS output is disabled');
  if (candidates.size > 1) throw new Error('Ambiguous Multica SLS destination; set Endpoint and Project to select one');
  const inherited = candidates.values().next().value;
  if (!target && !inherited) throw new Error('Multica requires an enabled SLS destination or explicit Endpoint and Project');
  target ??= inherited!.target;

  let mode: SlsMode = 'webtracking';
  let apiKey: string | undefined;
  if (inherited) {
    const endpoint = inherited.endpoint;
    if (endpoint.apiKey && (endpoint.accessKeyId || endpoint.accessKeySecret)) throw new Error('Ambiguous Multica SLS credentials');
    if (endpoint.mode !== 'webtracking' && endpoint.mode !== 'apiKey') throw new Error('Multica SLS supports apiKey or webtracking mode');
    mode = endpoint.mode;
    if (mode === 'apiKey') {
      if (!endpoint.apiKey?.trim()) throw new Error('Multica SLS API Key is missing');
      apiKey = endpoint.apiKey;
    }
  }
  return {...flusher, Type: 'flusher_sls', ...target, Logstore: logstore, mode, ...(apiKey ? {apiKey} : {})};
}

function normalizeTarget(endpoint: string, rawProject: string): { Endpoint: string; Project: string } {
  if (typeof endpoint !== 'string' || typeof rawProject !== 'string') throw new Error('Invalid Multica SLS destination');
  const project = rawProject.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) throw new Error('Invalid Multica SLS Project');
  const rawEndpoint = endpoint.trim();
  if (!rawEndpoint) throw new Error('Invalid Multica SLS Endpoint');
  let url: URL;
  try { url = new URL(/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`); }
  catch { throw new Error('Invalid Multica SLS Endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Multica SLS Endpoint must be an HTTP(S) origin');
  }
  if (url.hostname.startsWith(`${project}.`) && url.hostname.endsWith('.log.aliyuncs.com')) {
    throw new Error('Multica SLS Endpoint must not include the Project prefix');
  }
  return { Endpoint: url.origin, Project: project };
}
