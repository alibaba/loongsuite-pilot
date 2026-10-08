// native-deps-guard — diagnose native addon capabilities before logging starts.
// Linux riscv64 can keep Hook/session collection running without sqlite3; its
// SQLite readers import lazily and SQLite-only listeners are disabled. Other
// platforms retain the existing fatal/preload crash-loop contract.
//
// Earlier bundles imported sqlite3 throughout the startup graph, so a loader
// failure killed collection before file logging existed. The build banner still
// loads this diagnostic first. On riscv64 a missing/broken addon is reported as a
// reduced capability; other platforms retain the established fatal behavior.
//
// Only sqlite3 is checked: zstd-napi is shipped but no src/ collector imports it.
// A broken unused compression addon must not prevent core collection.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from './utils/data-dir.js';
import { recordSqliteStartupFailure } from './utils/sqlite3-runtime.js';

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
    '[pilot] The sqlite3 in this payload is the upstream prebuilt binary, which',
    '[pilot] needs only a very old glibc (~2.4), and the process printing this',
    '[pilot] is already running a working node. A load failure here typically',
    "[pilot] means this container's libc is musl-based (Alpine), where glibc-linked",
    '[pilot] addons cannot load — or the payload on the shared volume is corrupted.',
    '[pilot]',
    '[pilot] Impact: the collector cannot start. Hooks already installed keep',
    '[pilot] writing events to local files, but nothing will ship them.',
    '[pilot] Fix: run the agent container on a glibc base image (Debian/Ubuntu/',
    '[pilot] Alibaba Cloud Linux), not musl/Alpine, and ensure the payload was',
    '[pilot] built with a working node + native addon pairing.',
  ];
  try {
    process.stderr.write(lines.join('\n') + '\n');
  } catch { /* last-ditch: there is nowhere else to write */ }
  writeFatalMarker(firstLine);
  process.exit(1);
}

// The project's Node18 type definitions predate the riscv64 Architecture member.
const canDegrade = process.platform === 'linux' && String(process.arch) === 'riscv64';

function recordSqliteCapability(available: boolean, detail?: string): void {
  if (!canDegrade) return;
  try {
    const dir = resolveDataDir();
    mkdirSync(dir, { recursive: true });
    const destination = path.join(dir, 'native-capabilities.json');
    const temporary = `${destination}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      schema: 1,
      checked_at: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      sqlite3: { available, ...(detail ? { reason: detail } : {}) },
      recovery: available ? null : 'Rebuild sqlite3 for this Node/runtime and restart Pilot.',
    }, null, 2) + '\n', 'utf8');
    renameSync(temporary, destination);
  } catch (err) {
    process.stderr.write(`[pilot] Cannot record native capabilities: ${String(err)}\n`);
  }
}

try {
  if (canDegrade) {
    // A mismatched N-API binary can terminate Node with SIGSEGV instead of a
    // catchable loader exception. Probe in a child before the collector loads it.
    const entry = require.resolve('sqlite3');
    const probe = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', entry], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
    });
    if (probe.error || probe.status !== 0) {
      throw new Error(`sqlite3 probe failed (${(probe.error as NodeJS.ErrnoException | undefined)?.code ?? probe.signal ?? probe.status}): ${probe.stderr || probe.error?.message || 'native process terminated'}`);
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('sqlite3');
  }
  recordSqliteCapability(true);
} catch (err) {
  if (!canDegrade) fail('sqlite3', err);
  const detail = ((err as Error)?.message || String(err)).replace(/\s+/g, ' ').slice(0, 2000);
  recordSqliteStartupFailure(detail);
  recordSqliteCapability(false, detail);
  process.stderr.write([
    '[pilot] WARNING: native module "sqlite3" is unavailable on linux-riscv64.',
    `[pilot] Loader: ${detail}`,
    '[pilot] SQLite-only listeners are disabled; SQLite token enrichment is unavailable.',
    '[pilot] Hook and session-file collection can continue. No SQLite checkpoint is advanced by a failed read.',
    '[pilot] Install a C/C++ toolchain and Python, rebuild sqlite3 for this Node/runtime, then restart Pilot.',
    '[pilot] See native-capabilities.json in the Pilot data directory for the current startup result.',
    '',
  ].join('\n'));
}
