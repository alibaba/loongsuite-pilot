import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withSyncFileLock } from './sync-file-lock.mjs';

// Limits apply across Qoder and Qoder CN, including different sessions. Reserve
// background capacity BEFORE spawning: a semaphore inside the child is too late.
export const MAX_QODER_PARSERS = 2;
export const MAX_QODER_RETRIES = 4;
const INCOMPLETE_LEASE_GRACE_MS = 60_000;

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function readLease(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

// The short metadata gate serializes stale-file recovery as well as creation.
// Its age limit is NOT the lifetime of the processing lease. Live processing
// owners are never evicted, even when parsing or the OS is slow.
function editLease(file, action) {
  try {
    return withSyncFileLock(`${file}.guard`, 50, INCOMPLETE_LEASE_GRACE_MS, action).value;
  } catch { return undefined; }
}

export function tryAcquireLease(file, fields = {}) {
  return editLease(file, () => {
    if (fs.existsSync(file)) {
      const existing = readLease(file);
      if (existing && pidAlive(existing.pid)) return null;
      // An old deployed writer may still be filling an exclusively created file.
      if (!existing && Date.now() - fs.statSync(file).mtimeMs < INCOMPLETE_LEASE_GRACE_MS) return null;
      fs.unlinkSync(file);
    }
    const lease = { ...fields, pid: process.pid, startedAt: Date.now(), token: crypto.randomUUID() };
    fs.writeFileSync(file, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
    return { ...lease, file };
  }) || null;
}

export function releaseLease(lease) {
  if (!lease) return;
  editLease(lease.file, () => {
    const current = readLease(lease.file);
    if (current && (lease.token ? current.token === lease.token : current.pid === process.pid)) {
      fs.unlinkSync(lease.file);
    }
  });
}

function transferLease(lease, pid) {
  return editLease(lease.file, () => {
    const current = readLease(lease.file);
    if (current?.token !== lease.token || current.pid !== process.pid) return false;
    const temporary = `${lease.file}.${lease.token}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...current, pid }), { mode: 0o600 });
      fs.renameSync(temporary, lease.file);
      return true;
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
  }) === true;
}

export function tryAcquireParser(root) {
  for (let slot = 0; slot < MAX_QODER_PARSERS; slot++) {
    const lease = tryAcquireLease(path.join(root, `parser-${slot}.lock`));
    if (lease) return lease;
  }
  return null;
}

export function reserveRetry(root, key) {
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const dedup = tryAcquireLease(path.join(root, 'keys', `${keyHash}.lock`));
  if (!dedup) return null;
  for (let slot = 0; slot < MAX_QODER_RETRIES; slot++) {
    const capacity = tryAcquireLease(path.join(root, `retry-${slot}.lock`), {
      keyHash, keyToken: dedup.token,
    });
    if (capacity) return { capacity, dedup, slot };
  }
  releaseLease(dedup);
  return null;
}

export function transferRetry(reservation, childPid) {
  return transferLease(reservation.dedup, childPid)
    && transferLease(reservation.capacity, childPid);
}

export function receiveRetry(root, slot, token) {
  if (!/^\d+$/.test(String(slot)) || Number(slot) >= MAX_QODER_RETRIES) return null;
  const file = path.join(root, `retry-${slot}.lock`);
  const capacity = readLease(file);
  if (!capacity || capacity.token !== token || capacity.pid !== process.pid
    || !/^[a-f0-9]{64}$/.test(capacity.keyHash)) return null;
  const keyFile = path.join(root, 'keys', `${capacity.keyHash}.lock`);
  const dedup = readLease(keyFile);
  if (!dedup || dedup.token !== capacity.keyToken || dedup.pid !== process.pid) return null;
  return { capacity: { ...capacity, file }, dedup: { ...dedup, file: keyFile }, slot: Number(slot) };
}

export function releaseRetry(reservation) {
  if (!reservation) return;
  releaseLease(reservation.dedup);
  releaseLease(reservation.capacity);
}
