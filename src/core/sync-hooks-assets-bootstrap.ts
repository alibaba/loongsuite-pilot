import * as nodePath from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SyncHooksAssetsBootstrap');

export interface SyncHooksAssetsSummary {
  synced: number;
  skipped: number;
  backed: number;
  errors: Array<{ rel: string; error: string }>;
  version: string | null;
}

export interface SyncHooksAssetsArgs {
  dataDir: string;
  cacheDir: string;
  currentFile: string;
}

export type SyncHooksAssetsFn = (args: SyncHooksAssetsArgs) => SyncHooksAssetsSummary;

export interface BootstrapOptions {
  dataDir: string;
  cacheDir?: string;
  currentFile?: string;
  syncFn?: SyncHooksAssetsFn;
}

// In the bundled dist/index.js, `import.meta.url` resolves to
// `file://<package>/dist/index.js`, and `../scripts/sync-hooks-assets.mjs`
// resolves to `file://<package>/scripts/sync-hooks-assets.mjs` — which is
// where the deploy flow copies scripts/ next to dist/. The shell-side
// `sync_hooks_assets()` function invokes the same .mjs from BOOTSTRAP_DIR;
// both paths reach the same logic.
const DEFAULT_SYNC_MODULE_URL = new URL('../scripts/sync-hooks-assets.mjs', import.meta.url).href;

let defaultSyncFnPromise: Promise<SyncHooksAssetsFn | null> | null = null;

async function resolveDefaultSyncFn(): Promise<SyncHooksAssetsFn | null> {
  if (!defaultSyncFnPromise) {
    defaultSyncFnPromise = (async () => {
      try {
        const mod = (await import(DEFAULT_SYNC_MODULE_URL)) as {
          syncHooksAssets?: SyncHooksAssetsFn;
        };
        if (typeof mod.syncHooksAssets !== 'function') {
          logger.warn('sync-hooks-assets module missing syncHooksAssets export', {
            moduleUrl: DEFAULT_SYNC_MODULE_URL,
          });
          return null;
        }
        return mod.syncHooksAssets;
      } catch (err) {
        logger.warn('sync-hooks-assets module load failed (non-fatal)', {
          moduleUrl: DEFAULT_SYNC_MODULE_URL,
          error: String(err),
        });
        return null;
      }
    })();
  }
  return defaultSyncFnPromise;
}

export async function bootstrapSyncHooksAssets(
  opts: BootstrapOptions,
): Promise<SyncHooksAssetsSummary | null> {
  const cacheDir = opts.cacheDir ?? opts.dataDir;
  const currentFile = opts.currentFile ?? nodePath.join(cacheDir, 'current');
  let syncFn: SyncHooksAssetsFn | null = opts.syncFn ?? null;
  if (!syncFn) {
    syncFn = await resolveDefaultSyncFn();
  }
  if (!syncFn) {
    return null;
  }
  try {
    const summary = syncFn({ dataDir: opts.dataDir, cacheDir, currentFile });
    logger.info('sync-hooks-assets bootstrap complete', {
      version: summary.version,
      synced: summary.synced,
      skipped: summary.skipped,
      backed: summary.backed,
      errors: summary.errors.length,
    });
    return summary;
  } catch (err) {
    logger.warn('sync-hooks-assets invocation failed (non-fatal)', { error: String(err) });
    return null;
  }
}

export function __resetDefaultSyncFnCacheForTests(): void {
  defaultSyncFnPromise = null;
}
