import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const METRICS_HEADER = 'timestamp,pid,ppid,command,cpu_percent,mem_percent,rss_kb,vsz_kb,elapsed,threads,open_files,inet_connections,tcp_established,tcp_listen,udp_connections';

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 24 * 60;

export function localHourString(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
  ].join('-');
}

export function parseWindowMinutes(rawValue, fallback = DEFAULT_WINDOW_MINUTES) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.ceil(parsed), MAX_WINDOW_MINUTES);
}

export function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

export async function getMetricsCsv(options) {
  const summary = await collectMetricsWindow(options);
  return [
    METRICS_HEADER,
    ...summary.rows.map((row) => row.line),
  ].join('\n') + '\n';
}

export async function getMetricsStatus(options) {
  const summary = await collectMetricsWindow(options);
  return {
    paths: summary.files.map((file) => file.path),
    files: summary.files,
    windowMinutes: summary.windowMinutes,
    rows: summary.rows.length,
    from: summary.from.toISOString(),
    to: summary.to.toISOString(),
    updatedAt: summary.files
      .map((file) => file.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
}

export async function collectMetricsWindow({
  monitorDir,
  minutes = DEFAULT_WINDOW_MINUTES,
  now = new Date(),
} = {}) {
  const windowMinutes = parseWindowMinutes(minutes);
  const to = now;
  const from = new Date(to.getTime() - windowMinutes * 60_000);
  const files = await listCandidateFiles(monitorDir, from, to);
  const rows = [];

  for (const file of files) {
    const text = await safeReadFile(file.path);
    if (!text) continue;
    const lines = text.split(/\r?\n/).filter(Boolean);
    const body = lines[0] === METRICS_HEADER ? lines.slice(1) : lines.filter((line) => !line.startsWith('timestamp,'));
    for (const line of body) {
      const values = parseCsvLine(line);
      const timestamp = parseMetricTimestamp(values[0]);
      if (!timestamp) continue;
      if (timestamp >= from && timestamp <= to) {
        rows.push({ timestamp, line });
      }
    }
  }

  rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return { files, rows, from, to, windowMinutes };
}

async function listCandidateFiles(monitorDir, from, to) {
  const entries = await safeReaddir(monitorDir);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const hourly = entry.name.match(/^loongsuite-pilot-process-(\d{4})-(\d{2})-(\d{2})-(\d{2})\.csv$/);
    const daily = entry.name.match(/^loongsuite-pilot-process-(\d{4})-(\d{2})-(\d{2})\.csv$/);
    if (!hourly && !daily) continue;

    const filePath = path.join(monitorDir, entry.name);
    const fileStat = await safeStat(filePath);
    if (!fileStat) continue;

    if (hourly) {
      const start = new Date(Number(hourly[1]), Number(hourly[2]) - 1, Number(hourly[3]), Number(hourly[4]));
      const end = new Date(start.getTime() + 60 * 60_000);
      if (end < from || start > to) continue;
    } else if (fileStat.mtime < from) {
      continue;
    }

    candidates.push({
      path: filePath,
      name: entry.name,
      sizeBytes: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

function parseMetricTimestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}
