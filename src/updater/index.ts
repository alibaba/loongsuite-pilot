import * as path from 'path';
import * as os from 'os';
import { Updater } from './updater.js';
import { UpdaterMetrics } from './updater-metrics.js';
import { buildAutoUpdateConfig, type ConfigFile } from '../core/config-loader.js';
import { createLogger, initFileLogging, flushLogsSync } from '../utils/logger.js';
import { readJsonFile, resolveHome, readInstalledVersion } from '../utils/fs-utils.js';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { UPDATER_PROCESS_PATTERNS, writePidFileSync, removeOwnPidFileSync } from '../utils/pid-utils.js';

const logger = createLogger('UpdaterMain');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

async function main(): Promise<void> {
  const dataDir = resolveHome(
    process.env.LOONGSUITE_PILOT_DATA_DIR ?? path.join(os.homedir(), '.loongsuite-pilot'),
  );
  await initFileLogging(path.join(dataDir, 'logs', 'loongsuite-pilot-updater.log'));

  logger.info('updater process starting');

  const configPath = resolveHome(
    process.env.AGENT_DATA_COLLECTION_CONFIG ?? DEFAULT_CONFIG_PATH,
  );

  const file = await readJsonFile<ConfigFile>(configPath);
  const config = buildAutoUpdateConfig(file);

  if (!config.enabled) {
    logger.info('auto-update disabled via config, exiting');
    flushLogsSync();
    process.exit(0);
  }

  // Same single-instance guard as the collector: a re-registered scheduled task
  // can leave a previous updater daemon orphaned, and duplicate updaters race on
  // version pointers and rollout state. Acquire before starting any work.
  const lockPath = path.join(dataDir, 'logs', 'updater.lock');
  const { lock, holderPid } = acquireSingleInstanceLock(lockPath, UPDATER_PROCESS_PATTERNS);
  if (!lock) {
    logger.warn('another updater instance already holds the lock; exiting', {
      pid: process.pid,
      holderPid,
      lockPath,
    });
    flushLogsSync();
    process.exit(0);
  }
  logger.info('single-instance lock acquired', { pid: process.pid, lockPath });

  // Win32-only pid file: see the collector's index.ts for the rationale — Windows has no
  // exec(2), so the launcher can't record the daemon's real pid and the daemon publishes
  // its own. Unix keeps writing it from the script. dataDir is env-first and matches the
  // `$DATA_DIR\loongsuite-pilot-updater.pid` the .ps1 reads.
  const pidFile = process.platform === 'win32'
    ? path.join(dataDir, 'loongsuite-pilot-updater.pid')
    : null;
  if (pidFile) writePidFileSync(pidFile);

  process.on('exit', () => {
    lock.release();
    if (pidFile) removeOwnPidFileSync(pidFile);
  });

  const userId = process.env.LOONGSUITE_PILOT_USER_ID
    ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  const version = readInstalledVersion(dataDir);
  const metrics = new UpdaterMetrics({
    dataDir,
    version,
    collectorPidFile: path.join(dataDir, 'loongsuite-pilot.pid'),
    userId,
  });
  await metrics.start();

  const updater = new Updater(config);
  updater.setMetrics(metrics);

  const shutdown = () => {
    logger.info('received shutdown signal');
    updater.stop();
    const exitTimeout = setTimeout(() => {
      flushLogsSync();
      process.exit(1);
    }, 10_000);
    exitTimeout.unref();
    metrics.stop()
      .catch(err => logger.warn('metrics stop failed', { error: String(err) }))
      .finally(() => {
        flushLogsSync();
        process.exit(0);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  updater.start();

  logger.info('updater process running', {
    checkIntervalMs: config.checkIntervalMs,
    manifestUrl: config.manifestUrl,
  });
}

main().catch((err) => {
  logger.error('updater fatal error', { error: String(err) });
  flushLogsSync();
  process.exit(1);
});
