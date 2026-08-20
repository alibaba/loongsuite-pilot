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
 */
import { appendFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const AGENT = 'loongsuite-pilot-observability';
const SENSITIVE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY)([_.-]|$)/i;
const ENABLED_MARKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '.collection-enabled');

function dataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR
    || process.env.PILOT_DATA
    || path.join(os.homedir(), '.loongsuite-pilot');
}
function logDir() { return path.join(dataDir(), 'logs', 'dsh'); }
function collectionEnabled() { return existsSync(ENABLED_MARKER); }
function ensureDir(d) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(d, 0o700);
}
function sessionFile(sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(logDir(), `dsh-${safe}.jsonl`);
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
  if (!existsSync(file)) ensureDir(path.dirname(file));
  appendFileSync(file, JSON.stringify(obj) + '\n');
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

export default function apply(ctx) {
  if (!collectionEnabled()) {
    ctx.logger(AGENT).info('loongsuite-pilot-observability collection is disabled');
    return;
  }
  ensureDir(logDir());
  appendLine(path.join(logDir(), `dsh-${process.pid}.jsonl`), {
    type: `${AGENT}/loaded`,
    logDir: logDir(),
    time: Date.now(),
  });
  ctx.on('session/created', (s) => {
    if (!collectionEnabled()) return;
    appendLine(sessionFile(s.id), {
      type: 'session/created', sid: String(s.id), time: Date.now(),
    });
  });
  ctx.on('session/event', (s, e) => {
    if (!collectionEnabled()) return;
    appendLine(sessionFile(s.id), {
      sid: String(s.id),
      seq: e.seq,
      time: e.time,
      type: e.type,
      data: redact(e.data),
    });
  });
  ctx.logger(AGENT).info('loongsuite-pilot-observability plugin loaded; logDir=%s', logDir());
}
