// Read-only: source JSONL bodies are never opened. No locks are acquired,
// checkpoints advanced, files removed, or Agent processes restarted.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const day = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const metadataError = error => error instanceof SyntaxError ? 'invalid-metadata-json' : error.code ?? error.name ?? 'metadata-read-error';
async function readSmall(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Diagnostic metadata exceeds size/type limit');
  return fs.readFile(file, 'utf8');
}

export async function auditHookHistory(dataDir) {
  const root = path.resolve(dataDir);
  let state = {}, stateError;
  try { state = JSON.parse(await readSmall(path.join(root, 'logs', 'input-state.json'), 64 * 1024 * 1024)); }
  catch (error) { stateError = metadataError(error); }
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 2);
  let retention = {}, retentionConfigError;
  try { retention = JSON.parse(await readSmall(path.join(root, 'config.json'), 1024 * 1024)).retention ?? {}; }
  catch (error) { if (error.code !== 'ENOENT') retentionConfigError = metadataError(error); }
  const days = Number.isInteger(retention.hookHistoryDays) && retention.hookHistoryDays >= 0 ? retention.hookHistoryDays : 7;
  const expiry = new Date(); expiry.setDate(expiry.getDate() - days);
  const families = [];
  for (const [prefix, id] of [['pi-coding-agent', 'pi-coding-agent-log'], ['opencode', 'opencode-log']]) {
    const dir = path.join(root, 'logs', prefix);
    const extra = state[id]?.extra ?? {};
    const offsets = extra.hookLogOffsets ?? {}, identities = extra.hookLogIdentities ?? {};
    const files = [], unscannedDirectories = [];
    let truncated = false;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= 20000) { truncated = true; break; }
      if (entry.isDirectory()) { unscannedDirectories.push(entry.name); continue; }
      if (!entry.name.endsWith('.jsonl') || entry.isSymbolicLink()) continue;
      const stat = await fs.lstat(path.join(dir, entry.name)).catch(() => null);
      if (!stat?.isFile()) continue;
      const name = entry.name, offset = offsets[name];
      const base = name.replace(/\.segment-\d{12}-[a-f0-9]{32}(?=\.jsonl$)/, '');
      let active;
      try { active = await readSmall(path.join(dir, base + '.active'), 1024); } catch {}
      const next = active && path.basename(active) === active && active.startsWith(base.slice(0, -6) + '.segment-')
        ? /\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$/.exec(active) : null;
      const current = /\.segment-(\d{12})-[a-f0-9]{32}\.jsonl$/.exec(name);
      const date = /-(\d{4}-\d{2}-\d{2})(?:\.segment-\d{12}-[a-f0-9]{32})?\.jsonl$/.exec(name)?.[1];
      const closed = (next && Number(next[1]) > Number(current?.[1] ?? 0))
        || (date && date < day(cutoff) && day(new Date(stat.mtimeMs)) < day(cutoff)
          && ((!active && name === base) || (active === name && name !== base)));
      const inode = `${stat.dev}:${stat.ino}`;
      const identity = process.platform === 'darwin' || process.platform === 'win32' ? `${inode}:${stat.birthtimeMs}` : inode;
      const matches = identities[name] === identity || (identity === inode && identities[name]?.startsWith(inode + ':'));
      let reason;
      if (!name.startsWith(prefix + '-') || !date) reason = 'untracked-file-name';
      else if (extra.hookLogDir !== dir || extra.hookLogPrefix !== prefix) reason = 'source-not-registered';
      else if (extra.hookLogRetentionBlocked?.[name]) reason = 'retention-blocked';
      else if (!Number.isSafeInteger(offset) || offset < 0) reason = 'offset-unknown';
      else if (!matches) reason = 'identity-unknown-or-changed';
      else if (offset < stat.size) reason = 'unread';
      else if (offset > stat.size) reason = 'truncated-or-stale-offset';
      else if (!closed) reason = 'active-or-two-day-window';
      else reason = 'candidate-needs-live-gate-check';
      files.push({ name, bytes: stat.size, offset: offset ?? null, identityMatches: Boolean(matches),
        unreadBytes: matches && Number.isSafeInteger(offset) && offset >= 0 && offset <= stat.size ? stat.size - offset : null,
        mtime: stat.mtime.toISOString(), segmented: Boolean(current), publishedActive: active === name,
        expired: Boolean(date && date < day(expiry)), reason });
    }
    const totalBytes = files.reduce((n, file) => n + file.bytes, 0);
    for (const file of files) {
      if (retention.enabled === false) file.reason = 'retention-disabled';
      else if (file.reason === 'candidate-needs-live-gate-check' && !file.expired && totalBytes <= 2 * 1024 * 1024 * 1024) {
        file.reason = 'below-retention-threshold';
      }
    }
    const byReason = {};
    for (const file of files) {
      byReason[file.reason] ??= { files: 0, bytes: 0 };
      byReason[file.reason].files++; byReason[file.reason].bytes += file.bytes;
    }
    families.push({ family: prefix, files: files.length, bytes: totalBytes,
      knownUnreadBytes: files.reduce((n, file) => n + (file.unreadBytes ?? 0), 0), byReason,
      truncated, unscannedDirectories, largestFiles: files.sort((a, b) => b.bytes - a.bytes).slice(0, 30) });
  }
  const cleanupLogs = [];
  const logsDir = path.join(root, 'logs');
  const logs = (await fs.readdir(logsDir).catch(() => []))
    .filter(name => name.startsWith('loongsuite-pilot-service.log') && !name.endsWith('.gz')).sort().slice(-6);
  for (const name of logs) {
    let handle;
    try {
      handle = await fs.open(path.join(logsDir, name), 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      const buffer = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
      for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.tag !== 'LogRetention') continue;
        const selected = {};
        for (const key of ['time', 'level', 'msg', 'input', 'bytes', 'maxBytes', 'deleted', 'deletedBytes', 'errors', 'error']) {
          if (row[key] !== undefined) selected[key] = typeof row[key] === 'string' ? row[key].slice(0, 1000) : row[key];
        }
        cleanupLogs.push(selected);
      }
    } catch (error) {
      cleanupLogs.push({ level: 'DIAGNOSTIC', msg: 'Cannot read cleanup log tail', error: String(error).slice(0, 1000) });
    } finally { await handle?.close(); }
  }
  return { sampledAt: new Date().toISOString(), readOnly: true, stateError, retentionConfigError,
    note: 'Metadata snapshot only. Does not prove the live collector has persisted its latest progress or released output holds/gates. No source bodies are emitted.',
    families, cleanupLogs: cleanupLogs.slice(-50) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.env.LOONGSUITE_PILOT_DATA_DIR ?? process.env.PILOT_DATA ?? path.join(os.homedir(), '.loongsuite-pilot');
  auditHookHistory(root).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(String(error)); process.exitCode = 1; });
}
