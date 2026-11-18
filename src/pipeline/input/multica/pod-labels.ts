import { isIP } from 'node:net';
import { hostname } from 'node:os';
import type { MulticaInputConfig, MulticaRecord } from './types.js';

// A service DNS name does not identify the Pod serving an individual request.
export function sourcePodLabels(input: MulticaInputConfig, source: string): MulticaRecord {
  const name = podLabel(process.env.POD_NAME) ?? podLabel(hostname());
  const uid = podLabel(input.PodUid ?? process.env.POD_UID);
  const ip = input.PodIp ?? process.env.POD_IP;
  const labels: MulticaRecord = {};
  if (name) labels.collector_pod_name = name;
  if (uid) labels.collector_pod_uid = uid;
  if (typeof ip === 'string' && !ip.includes('%') && isIP(ip)) labels.collector_pod_ip = ip;

  const separator = source.indexOf(':');
  const kind = source.slice(0, separator);
  let local = kind === 'stat';
  if (kind === 'metrics' || kind === 'health' || kind === 'pprof') {
    const url = kind === 'pprof' ? input.PprofBaseUrl : source.slice(separator + 1);
    if (url) {
      const host = new URL(url).hostname;
      const podIp = labels.collector_pod_ip;
      const podHost = podIp && isIP(podIp) === 6 ? new URL(`http://[${podIp}]`).hostname : podIp;
      local = host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'))
        || host === podHost;
    }
    // An explicit profile target can also describe a remote endpoint.
    const profileName = kind === 'pprof' ? podLabel(input.PprofPodName) : undefined;
    if (profileName) {
      labels.pod_name = profileName;
      if (name && profileName !== name) return labels;
    }
  }
  if (local) {
    if (name) labels.pod_name = name;
    if (uid) labels.pod_uid = uid;
    if (labels.collector_pod_ip) labels.pod_ip = labels.collector_pod_ip;
  }
  return labels;
}

function podLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(value) ? value : undefined;
}

/** Keep the old snapshot/event ID for sources without a known producer. */
export function podScopedSource(source: string, labels: MulticaRecord): string {
  const pod = labels.pod_uid || labels.pod_name || labels.pod_ip;
  return pod ? `${source}\0${pod}` : source;
}
