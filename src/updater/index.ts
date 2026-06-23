import * as path from 'path';
import * as os from 'os';
import { Updater } from './updater.js';
import { UpdaterMetrics } from './updater-metrics.js';
import { buildAutoUpdateConfig, type ConfigFile } from '../core/config-loader.js';
import { createLogger, initFileLogging } from '../utils/logger.js';
import { readJsonFile, resolveHome, readInstalledVersion } from '../utils/fs-utils.js';

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
    process.exit(0);
  }

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
    const exitTimeout = setTimeout(() => process.exit(1), 10_000);
    exitTimeout.unref();
    metrics.stop()
      .catch(err => logger.warn('metrics stop failed', { error: String(err) }))
      .finally(() => process.exit(0));
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
  process.exit(1);
});
