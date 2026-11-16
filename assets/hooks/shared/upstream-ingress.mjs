import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_RECORD_BYTES = 8192;

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
}

export function normalizeUpstreamCarrier(carrier) {
  if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) return null;
  const traceparent = carrier.traceparent ?? carrier.TRACEPARENT;
  const tracestate = carrier.tracestate ?? carrier.TRACESTATE;
  if (typeof traceparent !== 'string' || traceparent.length > 512) return null;
  const normalized = traceparent.trim().toLowerCase();
  const match = /^(?!ff)([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/.exec(normalized);
  if (!match || /[\r\n\0]/.test(normalized) || /^0+$/.test(match[2]) || /^0+$/.test(match[3]) || (match[1] === '00' && match[5])) return null;
  if (tracestate !== undefined && (typeof tracestate !== 'string' || tracestate.length > 512 || /[\r\n\0]/.test(tracestate))) return null;
  return { traceparent: normalized, ...(tracestate ? { tracestate } : {}) };
}

function readRecord(file) {
  let descriptor;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > MAX_RECORD_BYTES) return null;
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishUpstreamRecord(file, record) {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error('record too large');
  const temporary = path.join(path.dirname(file), `.ingress-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, file);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function turnFile(correlateDir, agentId, sessionId, nativeTurnId) {
  const digest = createHash('sha256').update(JSON.stringify([agentId, sessionId, nativeTurnId])).digest('hex');
  return path.join(correlateDir, `ingress-${digest}.json`);
}

export function readUpstreamTurn(correlateDir, agentId, sessionId, nativeTurnId) {
  if (![agentId, sessionId, nativeTurnId].every(validIdentity)) return null;
  const record = readRecord(turnFile(correlateDir, agentId, sessionId, nativeTurnId));
  if (record?.schema !== 1 || record.type !== 'ingress' || record.agentId !== agentId
    || record.sessionId !== sessionId || record.nativeTurnId !== nativeTurnId) return null;
  return normalizeUpstreamCarrier(record);
}

export function bindUpstreamTurn({ agentId, sessionId, nativeTurnId, carrier, dataDir } = {}) {
  try {
    const context = normalizeUpstreamCarrier(carrier);
    if (![agentId, sessionId, nativeTurnId].every(validIdentity) || !context) return { recorded: false, reason: 'invalid' };
    const dir = path.join(dataDir || process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot'), 'acp-correlate');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = turnFile(dir, agentId, sessionId, nativeTurnId);
    if (publishUpstreamRecord(file, { schema: 1, type: 'ingress', agentId, sessionId, nativeTurnId, ...context })) return { recorded: true };
    const existing = readUpstreamTurn(dir, agentId, sessionId, nativeTurnId);
    return existing && JSON.stringify(existing) === JSON.stringify(context)
      ? { recorded: true } : { recorded: false, reason: 'conflict' };
  } catch {
    return { recorded: false, reason: 'io' };
  }
}

export function readUpstreamSession(correlateDir, sessionId) {
  if (!validIdentity(sessionId)) return null;
  const base = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const record = readRecord(path.join(correlateDir, `${base}.env.lock`));
  if (record?.type !== 'session' || record.sessionId !== sessionId) return null;
  return normalizeUpstreamCarrier(record);
}
