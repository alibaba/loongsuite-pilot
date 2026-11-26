import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CURSOR_JOURNAL_DIR } from './event-journal.mjs';

const lockDir = path.join(CURSOR_JOURNAL_DIR, 'assembly.lock');

// Unlike the short journal mutation lock, assembly awaits history I/O. Never
// steal its lock based on age: a slow but live writer still owns the turn.
export async function withAssemblyLock(action) {
  fs.mkdirSync(CURSOR_JOURNAL_DIR, { recursive: true });
  const owner = path.join(lockDir, `${process.pid}-${crypto.randomUUID()}`);
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      try { fs.writeFileSync(owner, ''); }
      catch (error) { fs.rmdirSync(lockDir); throw error; }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      removeAbandonedOwner();
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Cursor turn assembly');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    return await action();
  } finally {
    fs.unlinkSync(owner);
    fs.rmdirSync(lockDir);
  }
}

function removeAbandonedOwner() {
  try {
    const owners = fs.readdirSync(lockDir);
    if (owners.length === 0) {
      // A process can die between mkdir and publishing its PID. rmdir only
      // succeeds while the directory is still empty.
      if (Date.now() - fs.statSync(lockDir).mtimeMs > 30000) fs.rmdirSync(lockDir);
      return;
    }
    if (owners.length !== 1 || !/^\d+-[a-f0-9-]+$/.test(owners[0])) return;
    const pid = Number(owners[0].split('-')[0]);
    if (pid <= 0) return;
    try { process.kill(pid, 0); return; }
    catch (error) { if (error.code !== 'ESRCH') return; }
    // Only the reaper that removes this exact owner may remove the directory.
    // A second reaper must not unlink a replacement owner's lock.
    fs.unlinkSync(path.join(lockDir, owners[0]));
    fs.rmdirSync(lockDir);
  } catch { /* another process acquired or released it; retry */ }
}
