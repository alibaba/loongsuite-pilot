/**
 * loongsuite-pilot DeepSeek Harness (dsh) observability plugin.
 *
 * Subscribes to dsh's `session/created` + `session/event` streams and
 * appends each event verbatim to a per-session JSONL file under
 * `$PILOT_DATA/logs/dsh/dsh-<sid>.jsonl`. Per-session files mean two
 * concurrent dsh processes never contend on the same file (hard gate #2).
 *
 * Event → GenAI trace conversion happens downstream in
 * `src/inputs/dsh/dsh-event-transform.ts`; this plugin only taps the
 * event stream to disk. Sensitive fields (API keys / credentials) are
 * filtered here so they never enter the JSONL, fixtures, or traces
 * (hard gate #5).
 *
 * Worker identity is captured here, inside the DSH process. The collector
 * reads the JSONL later and does not see this process environment.
 */
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectResourceAttributesFromEnv } from '../shared/resource-context.mjs';
import { createRequire } from 'node:module';
let privateLog;
try { privateLog = createRequire(import.meta.url)('../shared/private-log-dir.cjs'); }
catch { privateLog = { ensurePrivateLogDir() {}, writerSuffix: () => '' }; }
const { ensurePrivateLogDir, writerSuffix } = privateLog;
const sharedRootLogs = /^(1|true|yes|on)$/i.test(String(process.env.LOONGSUITE_PILOT_ROOT_TRIGGER || '').trim());
import { appendRawJsonl, RAW_SEGMENT_BYTES } from '../shared/raw-jsonl-writer.mjs';
import { bindProcessUpstreamTurn } from '../../hooks/shared/upstream-ingress.mjs';

const AGENT = 'loongsuite-pilot-observability';
const SENSITIVE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY)([_.-]|$)/i;
const ENABLED_MARKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '.collection-enabled');
const INSTALLED_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function dataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR
    || process.env.PILOT_DATA
    || INSTALLED_DATA_DIR;
}
function logDir() { return path.join(dataDir(), 'logs', 'dsh'); }
function collectionEnabled() { return existsSync(ENABLED_MARKER); }
function ensureDir(d) {
  if (sharedRootLogs) return ensurePrivateLogDir(d);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(d, 0o700);
}
function sessionFile(sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(logDir(), `dsh-${safe}${sharedRootLogs ? writerSuffix() : ''}.jsonl`);
}
function redact(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) continue;
    out[k] = typeof v === 'object' ? redact(v) : v;
  }
  return out;
}
function appendLine(file, obj) {
  try {
    if (!existsSync(file)) ensureDir(path.dirname(file));
    const line = JSON.stringify(obj) + '\n';
    if (obj.type === 'request/header') {
      headers.delete(file);
      headers.set(file, line);
      if (headers.size > 1024) headers.delete(headers.keys().next().value);
    }
    appendRawJsonl(file, line, RAW_SEGMENT_BYTES, {
      allowRotate: obj.type === 'turn/start' && headers.has(file),
      prefix: headers.get(file),
      privateOwner: sharedRootLogs,
    });
  } catch {
    // Collection is best effort. Retry only when another business event arrives.
  }
}
function observe(handler) {
  return (...args) => {
    try {
      if (collectionEnabled()) handler(...args);
    } catch {
      // Malformed or unserializable telemetry must not interrupt a DSH session.
    }
  };
}
const headers = new Map();
function workerFields() {
  const resourceAttributes = collectResourceAttributesFromEnv(process.env, { agentId: 'dsh' });
  return Object.keys(resourceAttributes).length > 0 ? { resourceAttributes } : {};
}

export default function apply(ctx) {
  if (!collectionEnabled()) {
    ctx.logger(AGENT).info('loongsuite-pilot-observability collection is disabled');
    return;
  }
  const identity = workerFields();
  appendLine(path.join(logDir(), `dsh-${process.pid}${sharedRootLogs ? writerSuffix() : ''}.jsonl`), {
    type: `${AGENT}/loaded`,
    logDir: logDir(),
    time: Date.now(),
    ...identity,
  });
  ctx.on('session/created', observe((s) => {
    appendLine(sessionFile(s.id), {
      type: 'session/created', sid: String(s.id), time: Date.now(),
      ...identity,
    });
  }));
  ctx.on('session/event', observe((s, e) => {
    if (e.type === 'turn/start' && Number.isSafeInteger(e.data?.turn)) {
      bindProcessUpstreamTurn({
        agentId: 'dsh',
        sessionId: String(s.id),
        nativeTurnId: String(e.data.turn),
        dataDir: dataDir(),
      });
    }
    appendLine(sessionFile(s.id), {
      sid: String(s.id),
      seq: e.seq,
      time: e.time,
      type: e.type,
      data: redact(e.data),
      ...identity,
    });
  }));
  ctx.logger(AGENT).info('loongsuite-pilot-observability plugin loaded; logDir=%s', logDir());
}
