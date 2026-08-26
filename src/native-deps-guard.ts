// native-deps-guard — fail loudly and early when the payload's native modules
// cannot load on this container's libc.
//
// Why this exists: the daemon's module graph imports sqlite3 unconditionally at
// startup (orchestrator.ts → the qoder-*-sqlite inputs), so on a container whose
// libc cannot load the prebuilt addon — most commonly musl/Alpine, where no
// glibc-linked .node can be dlopen'd at all, but also a glibc older than the
// addon's own requirement — the daemon crashes
// during module load. That crash used to be invisible twice over: it happens
// before initFileLogging() runs, and the spawners redirected daemon stderr to
// /dev/null. The user saw "no telemetry" and nothing else.
//
// build.mjs prepends `import './native-deps-guard.cjs'` to the daemon bundle, so
// this runs before any of that graph loads and turns the silent crash into an
// actionable diagnostic with a non-zero exit.
//
// Deliberately checks ONLY what the startup graph actually loads: sqlite3.
// zstd-napi also ships in the payload but nothing in src/ imports it, so a
// broken zstd-napi must not stop the daemon. Keep this list in sync with the
// daemon's real top-level native imports, not with package.json.
//
// Never import this from the daemon itself — it must run before the daemon's
// imports execute, which is only possible from a separately loaded module.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from './utils/data-dir.js';

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
    writeFileSync(
      path.join(dir, 'daemon.fatal'),
      `fatal ${containerIdentity()} ${new Date().toISOString()} ${reasonFirstLine}\n`,
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
    '[pilot] See the compatibility matrix in deploy/docker/README.md.',
  ];
  try {
    process.stderr.write(lines.join('\n') + '\n');
  } catch { /* last-ditch: there is nowhere else to write */ }
  writeFatalMarker(firstLine);
  process.exit(1);
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('sqlite3');
} catch (err) {
  fail('sqlite3', err);
}
