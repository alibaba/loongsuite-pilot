import https from 'node:https';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

// Kubernetes log timestamps retain the date missing from Multica's tint output.
export function freshLines(body, cursor = { time: '', counts: {} }) {
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
    const time = line.match(/^(\d{4}-\d{2}-\d{2}T\S+) /)?.[1];
    if (!time || !Number.isFinite(Date.parse(time)) || (cursor.time && Date.parse(time) < Date.parse(cursor.time))) continue;
    const hash = crypto.createHash('sha256').update(line).digest('hex');
    const count = (seenCounts.get(hash) ?? 0) + 1;
    seenCounts.set(hash, count);
    if (!latest || Date.parse(time) > Date.parse(latest) || (Date.parse(time) === Date.parse(latest) && time > latest)) {
      latest = time;
      latestCounts = new Map();
    }
    // A bounded replay may contain fewer old occurrences; never lower its checkpoint.
    if (time === latest) latestCounts.set(hash, Math.max(latestCounts.get(hash) ?? 0, count));
    if (time === cursor.time && count <= (previousCounts.get(hash) ?? 0)) continue;
    lines.push(line);
  }
  return { lines, cursor: { time: latest, counts: Object.fromEntries(latestCounts) } };
}

async function main() {
  const namespace = process.env.NAMESPACE;
  const podSelector = process.env.POD_LABEL_SELECTOR;
  const containerNames = new Set((process.env.MULTICA_LOG_CONTAINERS || 'backend,daemon').split(',').map(name => name.trim()).filter(Boolean));
  const directory = process.env.LOG_DIRECTORY || '/logs';
  const credentials = process.env.KUBE_CREDENTIAL_DIRECTORY || '/var/run/collector-kube';
  const activationFile = process.env.MULTICA_ACTIVATION_STATE_FILE;
  const allowed = () => readActivationPermit(activationFile);
  const maxBytes = 4 * 1024 * 1024;
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
      }, (response) => {
        const chunks = []; let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('Kubernetes log response exceeded limit'));
          else chunks.push(chunk);
        });
        response.on('end', () => response.statusCode === 200
          ? resolve(Buffer.concat(chunks).toString('utf8'))
          : reject(new Error(`Kubernetes API status ${response.statusCode}`)));
        response.on('error', reject);
      });
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
        if (!namespace || !podSelector) throw new Error('NAMESPACE and POD_LABEL_SELECTOR are required for log collection');
        if (!initialized) {
          await fs.mkdir(directory, { recursive: true });
          try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          initialized = true;
        }
        const selector = encodeURIComponent(podSelector);
        const namespacePath = encodeURIComponent(namespace);
        const pods = JSON.parse(await request(`/api/v1/namespaces/${namespacePath}/pods?labelSelector=${selector}`));
        for (const pod of pods.items ?? []) {
          for (const container of pod.spec.containers.filter(c => containerNames.has(c.name))) {
            try {
              const stream = `${pod.metadata.uid}/${container.name}`;
              const cursor = state[stream];
              const query = new URLSearchParams({ container: container.name, timestamps: 'true', limitBytes: String(1024 * 1024) });
              // Bound initial history; subsequent pulls resume inclusively and deduplicate the boundary.
              if (cursor?.time) query.set('sinceTime', cursor.time);
              else query.set('tailLines', '1000');
              const body = await request(`/api/v1/namespaces/${namespacePath}/pods/${encodeURIComponent(pod.metadata.name)}/log?${query}`);
              const result = freshLines(body, cursor);
              if (body.length && !body.includes('\n')) {
                throw new Error('Log record exceeds bridge chunk size; source requires manual backfill');
              }
              const file = path.join(directory, `${container.name}.log`);
              const size = await fs.stat(file).then(s => s.size).catch(e => e.code === 'ENOENT' ? 0 : Promise.reject(e));
              if (size + Buffer.byteLength(result.lines.join('\n')) > 128 * 1024 * 1024) {
                throw new Error('Log spool full; archive and restart bridge after collector catches up');
              }
              if (result.lines.length) await fs.appendFile(file, result.lines.join('\n') + '\n', { mode: 0o600 });
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
