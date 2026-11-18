import type { PipelineSlsFlusherConfig } from '../../types.js';

export type MulticaSlsFlusherConfig = Omit<PipelineSlsFlusherConfig, 'Logstore'> & { Logstore?: string };

/** The dispatched pipeline owns its destination; CMS trace credentials are unrelated. */
export function resolveMulticaDestination(flusher?: MulticaSlsFlusherConfig): PipelineSlsFlusherConfig {
  if (flusher?.Type !== 'flusher_sls' || typeof flusher.Endpoint !== 'string' || typeof flusher.Project !== 'string') {
    throw new Error('Expected Multica SLS Endpoint and Project');
  }
  const project = flusher.Project.trim();
  const logstore = flusher.Logstore === undefined ? 'multica-logs' : flusher.Logstore.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(logstore)) {
    throw new Error('Invalid Multica SLS Project or Logstore');
  }
  const rawEndpoint = flusher.Endpoint.trim();
  let url: URL;
  try { url = new URL(/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`); }
  catch { throw new Error('Invalid Multica SLS Endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Multica SLS Endpoint must be an HTTP(S) origin');
  }
  if (url.hostname.startsWith(`${project}.`) && url.hostname.endsWith('.log.aliyuncs.com')) {
    throw new Error('Multica SLS Endpoint must not include the Project prefix');
  }
  return { ...flusher, Endpoint: url.origin, Project: project, Logstore: logstore };
}
