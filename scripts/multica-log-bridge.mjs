import https from 'node:https';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOG_CHUNK_BYTES = 1024 * 1024;
const MAX_LOG_REPLAY_BYTES = 4 * LOG_CHUNK_BYTES;
// Kubernetes treats limitBytes as approximate. Allow a bounded overrun on the wire.
const MAX_RESPONSE_BYTES = MAX_LOG_REPLAY_BYTES + 64 * 1024;

class KubernetesResponseTooLarge extends Error {}

/** The collector publishes a short-lived lease; missing state never enables collection. */
export function isCollectionActive(value, now = Date.now()) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.enabled === true && value.mode === 'on' && value.stopped === false
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now;
}

export async function readActivationPermit(file, now = Date.now()) {
  if (typeof file !== 'string' || !file) return false;
  let handle;
  try {
    handle = await fs.open(file, 'r');
    if (!(await handle.stat()).isFile()) return false;
    // Bound local control data too, and never log its contents on parse/read errors.
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return false;
    return isCollectionActive(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')), now);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function logTimestamp(line) {
  const time = line.match(/^(\d{4}-\d{2}-\d{2}T\S+) /)?.[1];
  return time && Number.isFinite(Date.parse(time)) ? time : undefined;
}

function compareTimestamps(a, b) {
  // The API server can round sinceTime to whole seconds. Keep nanosecond
  // ordering locally when discarding earlier records from an inclusive replay.
  const fraction = time => (time.match(/\.(\d+)/)?.[1] ?? '').padEnd(9, '0');
  return Date.parse(a) - Date.parse(b) || Number(fraction(a)) - Number(fraction(b));
}

// Kubernetes log timestamps retain the date missing from Multica's tint output.
export function freshLines(body, cursor = { time: '', counts: {} }, format = line => line) {
  // Older checkpoints only establish one known occurrence per hash.
  const previousCounts = new Map(cursor.counts
    ? Object.entries(cursor.counts)
    : (cursor.hashes ?? []).map(hash => [hash, 1]));
  const seenCounts = new Map();
  let latest = cursor.time;
  let latestCounts = new Map(previousCounts);
  const lines = [];
  // limitBytes may end in the middle of a record; leave that record for the next pull.
  const complete = body.slice(0, body.lastIndexOf('\n') + 1);
  for (const line of complete.split('\n')) {
    const time = logTimestamp(line);
    if (!time || (cursor.time && compareTimestamps(time, cursor.time) < 0)) continue;
    const hash = crypto.createHash('sha256').update(line).digest('hex');
    const count = (seenCounts.get(hash) ?? 0) + 1;
    seenCounts.set(hash, count);
    if (!latest || compareTimestamps(time, latest) > 0) {
      latest = time;
      latestCounts = new Map();
    }
    // A bounded replay may contain fewer old occurrences; never lower its checkpoint.
    if (time === latest) latestCounts.set(hash, Math.max(latestCounts.get(hash) ?? 0, count));
    if (time === cursor.time && count <= (previousCounts.get(hash) ?? 0)) continue;
    lines.push(format(line, hash, count));
  }
  return { lines, cursor: { time: latest, counts: Object.fromEntries(latestCounts) } };
}

export async function readPodLogBatch(request, resource, container, cursor, format) {
  const query = new URLSearchParams({ container, timestamps: 'true' });
  const read = limit => {
    query.set('limitBytes', String(limit));
    return request(`${resource}?${query}`);
  };
  if (!cursor?.time) {
    // A cold tail may start in the middle of identical timestamped lines.
    // Use it only to locate the start time; assign ordinals on the inclusive
    // replay from that timestamp so independent bridges count the same prefix.
    query.set('tailLines', '1000');
    const tail = await read(LOG_CHUNK_BYTES);
    // Only the timestamp prefix is needed for discovery, even on a cut line.
    const time = tail.split('\n').map(logTimestamp).find(Boolean);
    if (!time) {
      if (tail && !tail.includes('\n')) throw new Error('Missing Kubernetes log timestamp; source requires manual backfill');
      return freshLines(tail, cursor, format);
    }
    cursor = { time, counts: {} };
    query.delete('tailLines');
  }
  query.set('sinceTime', cursor.time);
  for (const limit of [LOG_CHUNK_BYTES, MAX_LOG_REPLAY_BYTES]) {
    const result = freshLines(await read(limit), cursor, format);
    if (result.lines.length) return result;
  }

  // limitBytes is approximate. To distinguish an idle stream from an unread
  // suffix, inspect the tail without a server byte limit (the transport is bounded).
  // N acknowledged occurrences can hide N identical rows; allow one new row
  // and a possible unterminated final line. Never advance or emit from a tail.
  const acknowledged = cursor.counts
    ? Object.values(cursor.counts).reduce((total, count) => total + count, 0)
    : (cursor.hashes ?? []).length;
  query.delete('limitBytes');
  query.set('tailLines', String(acknowledged + 2));
  try {
    const tail = await request(`${resource}?${query}`);
    if (!freshLines(tail, cursor).lines.length) return { lines: [], cursor };
  } catch (error) {
    if (!(error instanceof KubernetesResponseTooLarge)) throw error;
  }
  throw new Error('Cannot confirm the end of the Kubernetes log after a 4 MiB replay; cursor unchanged, source requires manual backfill');
}

// Frame the original timestamped line without escaping or modifying its body.
// readPodLogBatch supplies occurrence counts from the start of the retained timestamp group.
export function podLogFormatter(pod, container) {
  const {uid, name} = pod.metadata;
  const prefix = ['@multica-k8s-v1', uid, name, pod.status?.podIP ?? '', container].join('\t');
  return (line, hash, occurrence) => {
    const id = crypto.createHash('sha256').update(`${uid}\0${container}\0${hash}\0${occurrence}`).digest('hex');
    return `${prefix}\t${id}\t${line}`;
  };
}

export function podListPath(namespace, podSelector, scope, podName = hostname()) {
  if (!namespace || !podSelector) throw new Error('NAMESPACE and POD_LABEL_SELECTOR are required for log collection');
  const query = new URLSearchParams({labelSelector: podSelector});
  if (scope === 'pod') {
    if (!podName || !/^[a-z0-9][a-z0-9.-]*$/.test(podName)) throw new Error('Pod-scoped log collection requires a valid hostname or POD_NAME override');
    query.set('fieldSelector', `metadata.name=${podName}`);
  } else if (scope !== 'namespace') {
    throw new Error('MULTICA_LOG_SCOPE must be pod or namespace');
  }
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?${query}`;
}

export async function readKubernetesResponse(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new KubernetesResponseTooLarge('Kubernetes log response exceeded limit');
    chunks.push(chunk);
  }
  if (response.statusCode !== 200) throw new Error(`Kubernetes API status ${response.statusCode}`);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const namespace = process.env.NAMESPACE;
  const podSelector = process.env.POD_LABEL_SELECTOR;
  const scope = process.env.MULTICA_LOG_SCOPE ?? 'namespace';
  const containerNames = new Set((process.env.MULTICA_LOG_CONTAINERS || 'backend,daemon').split(',').map(name => name.trim()).filter(Boolean));
  const directory = process.env.LOG_DIRECTORY || '/logs';
  const credentials = process.env.KUBE_CREDENTIAL_DIRECTORY || '/var/run/collector-kube';
  const activationFile = process.env.MULTICA_ACTIVATION_STATE_FILE;
  const allowed = () => readActivationPermit(activationFile);
  const statePath = path.join(directory, '.bridge-state.json');
  let state = {};
  let initialized = false;
  const request = async (resource) => {
    // Recheck before every request, not just before listing Pods: a collector
    // can stop while this loop is processing the previous response.
    if (!await allowed()) throw new Error('Multica collection inactive');
    const ca = await fs.readFile(path.join(credentials, 'ca.crt'));
    const token = (await fs.readFile(path.join(credentials, 'token'), 'utf8')).trim();
    return new Promise((resolve, reject) => {
      const req = https.get(`https://kubernetes.default.svc${resource}`, {
        ca, headers: { Authorization: `Bearer ${token}` }, timeout: 15000,
      }, response => readKubernetesResponse(response).then(resolve, reject));
      req.on('timeout', () => req.destroy(new Error('Kubernetes API timeout')));
      req.on('error', reject);
    });
  };
  let stopped = false;
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  while (!stopped) {
    try {
      if (await allowed()) {
        const listPath = podListPath(namespace, podSelector, scope, process.env.POD_NAME);
        if (!initialized) {
          await fs.mkdir(directory, { recursive: true });
          try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          initialized = true;
        }
        const namespacePath = encodeURIComponent(namespace);
        const pods = JSON.parse(await request(listPath));
        for (const pod of pods.items ?? []) {
          for (const container of pod.spec.containers.filter(c => containerNames.has(c.name))) {
            try {
              const stream = `${pod.metadata.uid}/${container.name}`;
              const cursor = state[stream];
              const resource = `/api/v1/namespaces/${namespacePath}/pods/${encodeURIComponent(pod.metadata.name)}/log`;
              const result = await readPodLogBatch(request, resource, container.name, cursor, podLogFormatter(pod, container.name));
              const file = path.join(directory, `${container.name}.log`);
              const size = await fs.stat(file).then(s => s.size).catch(e => e.code === 'ENOENT' ? 0 : Promise.reject(e));
              const addition = result.lines.length ? result.lines.join('\n') + '\n' : '';
              if (size + Buffer.byteLength(addition) > 128 * 1024 * 1024) {
                throw new Error('Log spool full; archive and restart bridge after collector catches up');
              }
              if (addition) await fs.appendFile(file, addition, { mode: 0o600 });
              state[stream] = result.cursor;
              await fs.writeFile(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
              await fs.rename(statePath + '.tmp', statePath);
            } catch (error) { console.error(JSON.stringify({ source: container.name, error: error.message })); }
          }
        }
      }
    } catch (error) { console.error(JSON.stringify({ source: 'kubernetes', error: error.message })); }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
