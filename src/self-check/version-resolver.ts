import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentVersionSource } from '../types/deployment.js';
import { resolveHome } from '../utils/fs-utils.js';

const MAX_BYTES = 32 * 1024;
const MAX_DIRECTORY_ENTRIES = 128;
const UNKNOWN = 'unknown';

export async function resolveAgentVersion(
  source: AgentVersionSource | null | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!source || signal.aborted) return UNKNOWN;
  try {
    if (source.type === 'command') return await runCommand(source.command, signal);
    if (source.type === 'jsonFile' || source.type === 'jsonlTail') {
      return await readVersion(resolveHome(source.file), source.key, source.type === 'jsonlTail');
    }
    const name = await newestPath(resolveHome(source.dir), source.type === 'newestSubdirFile', signal);
    if (!name || signal.aborted) return UNKNOWN;
    if (source.type === 'newestSubdirFile' && path.basename(source.file) !== source.file) return UNKNOWN;
    const file = source.type === 'newestSubdirFile' ? path.join(name, source.file) : name;
    return await readVersion(file, source.key, false);
  } catch {
    return UNKNOWN;
  }
}

function cleanVersion(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return text.length <= 100 && /^(?:[A-Za-z][\w.-]* )?v?\d+\.\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)*$/.test(text)
    ? text : UNKNOWN;
}

async function readVersion(file: string, key: string, tail: boolean): Promise<string> {
  if (!path.isAbsolute(file)) return UNKNOWN;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (!tail && stat.size > MAX_BYTES)) return UNKNOWN;
    const size = Math.min(stat.size, MAX_BYTES);
    const offset = stat.size - size;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    const text = buffer.toString('utf8', 0, bytesRead);
    if (!tail) return cleanVersion(JSON.parse(text)?.[key]);
    const lines = text.split('\n');
    // The beginning of a bounded suffix can be a partial JSON record.
    if (offset > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const version = cleanVersion(JSON.parse(lines[i])?.[key]);
        if (version !== UNKNOWN) return version;
      } catch { /* unsupported or incomplete record */ }
    }
    return UNKNOWN;
  } finally {
    await handle.close();
  }
}

async function newestPath(dir: string, nested: boolean, signal: AbortSignal): Promise<string | null> {
  if (!path.isAbsolute(dir)) return null;
  const entries = await fs.opendir(dir);
  let seen = 0;
  let newest: { file: string; mtime: number } | undefined;
  for await (const entry of entries) {
    // Avoid claiming an older version when the search cannot cover the directory.
    if (signal.aborted || ++seen > MAX_DIRECTORY_ENTRIES) return null;
    if (nested ? !entry.isDirectory() : !entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && (!newest || stat.mtimeMs > newest.mtime)) newest = { file, mtime: stat.mtimeMs };
  }
  return newest?.file ?? null;
}

function runCommand(command: string, signal: AbortSignal): Promise<string> {
  // Agent definitions may be local. Always run a fixed version-only command.
  const match = /^(codex|opencode|qwen) --version$/.exec(command);
  if (!match) return Promise.resolve(UNKNOWN);
  const [executable, args]: [string, string[]] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', match[1], '--version']]
    : [match[1], ['--version']];
  return new Promise(resolve => {
    execFile(executable, args, { signal, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 }, (error, stdout) => {
      resolve(error ? UNKNOWN : cleanVersion(stdout.split(/\r?\n/, 1)[0]));
    });
  });
}
