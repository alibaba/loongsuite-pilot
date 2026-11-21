#!/usr/bin/env node
/**
 * Sync hook assets from the installed version's `assets/hooks/` directory
 * into the runtime `data/hooks/` directory.
 *
 * Problem this solves: the hook entry script (`data/hooks/<agent>-loongsuite-pilot-hook.sh`)
 * references `$SCRIPT_DIR/<agent>-hook-processor.mjs`, i.e. siblings in `data/hooks/`.
 * The deploy flow drops a new build under `versions/<current>/assets/hooks/` but
 * does NOT refresh the `data/hooks/` copy. Result: a new hook-processor fix lands
 * in the versioned source but the running hook keeps reading the stale copy.
 *
 * This script runs at pilot startup (invoked by `scripts/loongsuite-pilot.sh`'s
 * `cmd_run` after `sync_bootstrap_scripts`). It:
 *   1. Reads `$dataDir/current` (managed by the deploy flow) to resolve the
 *      active version directory.
 *   2. Walks `versions/<current>/assets/hooks/` recursively.
 *   3. For each file: if `data/hooks/<relpath>` is missing → copy. If present
 *      and byte-identical (cmp-style) → skip (no mtime churn). If present and
 *      differs → back up to `<path>.bak.<version-short>` then overwrite.
 *
 * Non-fatal: any per-file error is recorded in the returned `errors` list and
 * the walk continues. A missing `current` pointer or missing source dir is a
 * no-op (returns zeroed summary) so first-run and pre-deploy states don't
 * break startup.
 *
 * Exported for unit tests; CLI mode reads LOONGSUITE_PILOT_DATA_DIR /
 * LOONGSUITE_PILOT_CACHE_DIR or defaults to ~/.loongsuite-pilot-v2.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DATA_DIR =
  process.env.LOONGSUITE_PILOT_DATA_DIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', '.loongsuite-pilot-v2');
const DEFAULT_CACHE_DIR =
  process.env.LOONGSUITE_PILOT_CACHE_DIR || DEFAULT_DATA_DIR;

function readCurrentVersion(currentFile) {
  if (!fs.existsSync(currentFile)) return null;
  const raw = fs.readFileSync(currentFile, 'utf8').trim();
  return raw.length > 0 ? raw : null;
}

function shortVersion(version) {
  // Use the first 7 chars of the version name (matches git short SHA when the
  // version dir is named main-<sha>-multica-attribution). Falls back to the
  // full string if shorter.
  if (!version) return 'unknown';
  return version.length > 12 ? version.slice(0, 12) : version;
}

function* walkFiles(rootDir, base = '') {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    const abs = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(abs, rel);
    } else if (entry.isFile()) {
      yield { rel, abs };
    }
  }
}

function filesEqual(a, b) {
  // cmp-style byte comparison. Returns true iff both files exist and have
  // identical content. Avoids hashing for speed; uses Buffer comparison.
  let sa, sb;
  try {
    sa = fs.readFileSync(a);
    sb = fs.readFileSync(b);
  } catch {
    return false;
  }
  if (sa.length !== sb.length) return false;
  return sa.equals(sb);
}

/**
 * Synchronize hook assets from the installed version into the data dir.
 *
 * @param {object} opts
 * @param {string} opts.dataDir    Runtime data dir (contains hooks/, current).
 * @param {string} opts.cacheDir   Cache dir (contains versions/<current>/).
 * @param {string} [opts.currentFile] Override path to `current` pointer file.
 * @returns {{synced:number, skipped:number, backed:number, errors:Array<{rel:string,error:string}>, version:string|null}}
 */
export function syncHooksAssets({ dataDir, cacheDir, currentFile }) {
  const summary = { synced: 0, skipped: 0, backed: 0, errors: [], version: null };
  const currentPath = currentFile || path.join(cacheDir, 'current');
  const version = readCurrentVersion(currentPath);
  summary.version = version;
  if (!version) return summary;

  const sourceRoot = path.join(cacheDir, 'versions', version, 'assets', 'hooks');
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    return summary;
  }

  const targetRoot = path.join(dataDir, 'hooks');
  if (!fs.existsSync(targetRoot)) {
    try {
      fs.mkdirSync(targetRoot, { recursive: true });
    } catch (err) {
      summary.errors.push({ rel: '<hooks-root>', error: `mkdir failed: ${err.message}` });
      return summary;
    }
  }

  const shortV = shortVersion(version);

  for (const { rel, abs } of walkFiles(sourceRoot)) {
    const targetPath = path.join(targetRoot, rel);
    try {
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(abs, targetPath);
        summary.synced += 1;
        continue;
      }
      if (filesEqual(abs, targetPath)) {
        summary.skipped += 1;
        continue;
      }
      const backupPath = `${targetPath}.bak.${shortV}`;
      try {
        fs.copyFileSync(targetPath, backupPath);
        summary.backed += 1;
      } catch (err) {
        summary.errors.push({ rel, error: `backup failed: ${err.message}` });
        // Continue: still try to overwrite target with source.
      }
      fs.copyFileSync(abs, targetPath);
      summary.synced += 1;
    } catch (err) {
      summary.errors.push({ rel, error: err.message });
    }
  }

  return summary;
}

// CLI mode: invoked by loongsuite-pilot.sh `sync_hooks_assets`.
if (import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dataDir = args[0] || DEFAULT_DATA_DIR;
  const cacheDir = args[1] || DEFAULT_CACHE_DIR;
  const currentFile = args[2] || path.join(cacheDir, 'current');
  try {
    const r = syncHooksAssets({ dataDir, cacheDir, currentFile });
    if (r.version) {
      console.log(
        `[sync-hooks-assets] version=${r.version} synced=${r.synced} skipped=${r.skipped} backed=${r.backed} errors=${r.errors.length}`,
      );
      for (const e of r.errors) {
        console.error(`[sync-hooks-assets] error: ${e.rel}: ${e.error}`);
      }
    }
  } catch (err) {
    console.error(`[sync-hooks-assets] fatal: ${err.message}`);
    process.exitCode = 0; // non-blocking: never break pilot startup
  }
}
