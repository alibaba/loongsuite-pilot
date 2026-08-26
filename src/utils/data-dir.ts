import * as fs from 'node:fs';
import { resolveHome } from './fs-utils.js';

// The single home of "where is the pilot data dir". Three consumers used to
// carry private copies of this precedence chain — loadConfig() here,
// inject-hooks.ts, and the plain-CJS k8s-preload.cjs — with a comment asking
// the reader to keep them in sync. A comment is not a mechanism: when
// loadConfig() grew the config-file `dataDir` source, the preload copy did not
// follow, and the two resolved different directories (the daemon read one, the
// preload's symlinks/sentinels/lock and the injected hookCommand pointed at the
// other, and isHookInstalled saw every hook as "not installed" and appended
// duplicates). The chain now lives here; the CJS preload still cannot import
// this file (it runs from the shared volume with no daemon bundle around), so
// it mirrors the chain — but k8s-preload-coordination.test.mjs asserts the two
// agree, which is what turns "keep in sync" from a wish into a check.

/** Default data dir (`~`-prefixed; resolve with resolveHome()). */
export const DEFAULT_DATA_DIR = '~/.loongsuite-pilot';

/** Default config-file location when AGENT_DATA_COLLECTION_CONFIG is unset. */
export const DEFAULT_CONFIG_PATH = `${DEFAULT_DATA_DIR}/config.json`;

/**
 * The config file loadConfig() reads: AGENT_DATA_COLLECTION_CONFIG (if set)
 * else the default location, `~` expanded. Whitespace-only values count as
 * unset (a path cannot meaningfully start or end with a space).
 */
export function configJsonPath(): string {
  const fromEnv = (process.env.AGENT_DATA_COLLECTION_CONFIG ?? '').trim();
  return resolveHome(fromEnv || DEFAULT_CONFIG_PATH);
}

/**
 * The config file's `dataDir` field, or undefined when the file is absent,
 * unreadable, unparsable, or the field is missing/empty/non-string. Mirrors
 * loadConfig()'s view of the same file, including the BOM readJsonFile()
 * strips (Windows writes BOMs routinely; JSON.parse rejects them).
 */
export function readConfigFileDataDir(): string | undefined {
  try {
    const text = fs.readFileSync(configJsonPath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text) as { dataDir?: unknown };
    if (typeof parsed.dataDir === 'string' && parsed.dataDir) return parsed.dataDir;
  } catch {
    // No readable/parsable config file — the same conclusion loadConfig()
    // reaches via readJsonFile(), and the chain falls through to the default.
  }
  return undefined;
}

/**
 * The raw (unresolved) precedence chain, highest first:
 *   1. explicit value / LOONGSUITE_PILOT_DATA_DIR env
 *   2. config file `dataDir`
 *   3. DEFAULT_DATA_DIR
 *
 * Empty strings count as unset: loadConfig() historically returned them raw
 * and the orchestrator's `config.dataDir || DEFAULT` already treated them as
 * the default — skipping them here makes every consumer agree without any of
 * them resolving an empty path.
 */
export function pickDataDir(explicit: string | undefined, fileDataDir: string | undefined): string {
  if (explicit) return explicit;
  if (fileDataDir) return fileDataDir;
  return DEFAULT_DATA_DIR;
}

/**
 * Fully resolved data dir (absolute, `~` expanded) for callers outside the
 * daemon module graph — inject-hooks.ts today. The daemon itself keeps the
 * two-step shape: loadConfig() returns the raw value via pickDataDir(), and
 * the orchestrator resolves it, so the config object stays a faithful echo of
 * what was configured.
 */
export function resolveDataDir(explicit?: string): string {
  return resolveHome(
    pickDataDir(explicit ?? process.env.LOONGSUITE_PILOT_DATA_DIR, readConfigFileDataDir()),
  );
}
