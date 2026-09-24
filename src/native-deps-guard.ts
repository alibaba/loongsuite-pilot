// native-deps-guard — fail loudly when this Node cannot provide node:sqlite.
//
// SQLite reads go through the builtin. It is unflagged from Node 22.13 and
// 23.4 (added in 22.5 behind --experimental-sqlite). The managed runtime is
// 22.22.x and already includes it. A load failure means this process is not
// a usable Pilot runtime: Node 18/20, 22.0–22.12, and 23.0–23.3 cannot load
// the builtin without a flag, and a damaged 22.22 build cannot either.
// There is no degrade path — continuing would report a healthy collector
// whose SQLite reads then fail. Install and upgrade must pick a node that
// passes the same require(), or refuse and keep the previous version.
//
// build.mjs prepends `import './native-deps-guard.cjs'` so this runs first
// and turns the failure into a thrown error plus a daemon.fatal marker. The
// throw is what collector-daemon.js's import().catch uses to write
// last-startup-crash.json; process.exit here would skip that breadcrumb.
//
// Never import this from the daemon itself — it must run before the daemon's
// imports execute, which is only possible from a separately loaded module.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from './utils/data-dir.js';

// esbuild emits this file as CJS (`packages: 'external'`), so this stays a
// runtime require of the Node builtin. typeof guards the ESM test runner,
// where an undeclared require must not throw before the call.
function loadBuiltin(id: string): unknown {
  if (typeof require !== 'function') {
    throw new Error(`cannot load ${id}`);
  }
  return require(id);
}

export type SqliteGuardDecision = 'ok' | 'fatal';

/**
 * True when node:sqlite is part of the binary without --experimental-sqlite.
 * That starts at 22.13.0, 23.4.0, and every major after 23. The guard does
 * not trust this predicate alone: a failed require() is fatal on every version.
 */
export function sqliteBuiltinExpected(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

/** A failed require('node:sqlite') is fatal. A successful load is ok. */
export function decideSqliteGuard(loadError: unknown): SqliteGuardDecision {
  return loadError ? 'fatal' : 'ok';
}

/** Best-effort libc identification for the diagnostic; never throws. */
function libcInfo(): string {
  try {
    const r = spawnSync('ldd', ['--version'], { encoding: 'utf8', timeout: 2000 });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find(l => l.trim()) ?? '';
    if (line) return line.trim();
  } catch { /* ldd missing (distroless etc.) — fall through */ }
  return 'unknown';
}

/**
 * Identity of "this container instance", matching k8s-preload.cjs: container
 * id from the process's own cgroup (changes on every container (re)creation),
 * falling back to the host boot_id outside a container, then 'unknown'. The
 * preload compares the marker against this same identity, so writer and reader
 * must compute it the same way, or the crash-loop breaker silently disarms.
 * boot_id alone is wrong on K8s: it is the HOST's, so a fixed init image
 * restarted on the same node would stay blocked until the node reboots.
 */
function containerIdentity(): string {
  try {
    const m = readFileSync('/proc/self/cgroup', 'utf8').match(/[0-9a-f]{64}/);
    if (m) return m[0];
  } catch { /* not containerized, or /proc unavailable */ }
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown'; // non-Linux or /proc unavailable
  }
}

/**
 * Record the failure so k8s-preload.cjs does not respawn the daemon. Without
 * this, the failure below is deterministic while the preload's stale-lock
 * takeover has no backoff: every node process in the container would take over
 * the lock, spawn a daemon, and watch it die here again — a crash loop, plus
 * one appended diagnostic per round in daemon.stderr.log.
 */
function writeFatalMarker(reasonFirstLine: string): void {
  try {
    // Both halves of this call must resolve exactly as k8s-preload.cjs does, or
    // the marker lands somewhere the preload never looks and the crash-loop
    // breaker silently disarms: resolveDataDir is the shared chain the preload
    // mirrors, containerIdentity the same token the preload compares against.
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    // The marker is whitespace-delimited (`fatal <identity> <timestamp> <reason>`)
    // and the reader splits it on whitespace, so any newline/tab the loader put in
    // the message must not spill into extra fields; collapse to single spaces.
    const reason = reasonFirstLine.trim().replace(/\s+/g, ' ');
    writeFileSync(
      path.join(dir, 'daemon.fatal'),
      `fatal ${containerIdentity()} ${new Date().toISOString()} ${reason}\n`,
      'utf8',
    );
  } catch { /* the stderr diagnostic is the primary channel; the marker is best-effort */ }
}

function fail(moduleName: string, err: unknown): never {
  const raw = (err as Error)?.message ?? String(err);
  const firstLine = raw.split('\n').find(l => l.trim()) ?? raw;
  const lines = [
    `[pilot] FATAL: native module "${moduleName}" cannot be loaded in this container.`,
    '[pilot]',
    `[pilot]   loader said: ${firstLine}`,
    `[pilot]   system libc: ${libcInfo()}`,
    '[pilot]',
    '[pilot] node:sqlite ships unflagged from Node.js 22.13 and 23.4.',
    '[pilot] Node.js 18/20 and 22.0-22.12 / 23.0-23.3 cannot load it.',
    '[pilot] On 22.13+ a load failure means this Node was built without',
    '[pilot] SQLite, or the binary is damaged.',
    '[pilot]',
    '[pilot] Impact: the collector cannot start. Hooks already installed keep',
    '[pilot] writing events to local files, but nothing will ship them.',
    '[pilot] Fix: use the installer managed Node.js runtime, or any Node.js',
    '[pilot] build that includes the node:sqlite module.',
  ];
  try {
    process.stderr.write(lines.join('\n') + '\n');
  } catch { /* last-ditch: there is nowhere else to write */ }
  writeFatalMarker(firstLine);
  // Throw, do not process.exit. The daemon banner import is inside
  // collector-daemon.js's import().catch, which writes last-startup-crash.json
  // from this error before exiting. The message must contain "node:sqlite" so
  // classifyStartupCrash marks it native_module_missing.
  throw new Error(`node:sqlite cannot be loaded: ${firstLine}`);
}

function probeNodeSqlite(): unknown {
  try {
    loadBuiltin('node:sqlite');
    return null;
  } catch (err) {
    return err;
  }
}

export function runSqliteGuard(loadError: unknown): void {
  if (decideSqliteGuard(loadError) === 'fatal') fail('node:sqlite', loadError);
}

// Top-level on purpose: the daemon banner imports this module, and the check
// has to run then. Vitest imports this file for the pure helpers; skipping
// the side effect there keeps a Node 18/20 test worker from exiting before
// those assertions. The spawned CJS (VITEST unset) is the production check.
if (process.env.VITEST !== 'true') {
  runSqliteGuard(probeNodeSqlite());
}
