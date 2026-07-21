#!/usr/bin/env node
import * as path from 'path';
import { Orchestrator } from './core/orchestrator.js';
import { loadConfig } from './core/config-loader.js';
import { createLogger, initFileLogging } from './utils/logger.js';
import { resolveHome, readInstalledVersion } from './utils/fs-utils.js';
import { writeStartupCrash, clearStartupCrash, resolveBreadcrumbDataDir } from './utils/crash-breadcrumb.js';
import { handleWorkerCli } from './local-workers/worker-cli.js';

const logger = createLogger('Main');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await handleWorkerCli(argv)) {
    return;
  }

  const [command, ...args] = argv;
  if (command === 'token-usage' || command === 'tokens') {
    const { runTokenUsageCommand } = await import('./cli/token-usage.js');
    process.exitCode = await runTokenUsageCommand(args);
    return;
  }

  const config = await loadConfig();

  const dataDir = resolveHome(config.dataDir);
  const logDir = path.join(dataDir, 'logs');
  await initFileLogging(path.join(logDir, 'loongsuite-pilot-service.log'));

  if (!config.enabled) {
    // A deliberate, non-crash exit: drop any stale breadcrumb so it is not later
    // misread as this run's failure cause.
    clearStartupCrash(resolveBreadcrumbDataDir());
    logger.info('analytics disabled via config or LOONGSUITE_PILOT_ENABLED=false');
    return;
  }

  const orchestrator = new Orchestrator(config);

  const shutdown = async () => {
    logger.info('shutdown signal received');
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await orchestrator.start();

  // Reached a healthy running state: clear any stale crash breadcrumb so a lingering
  // one always reflects the most recent *failed* startup attempt. The breadcrumb dir
  // must match the daemon writer and the updater reader (env-or-default), not config.dataDir.
  clearStartupCrash(resolveBreadcrumbDataDir());

  logger.info('AI Agent Input is running', {
    dataDir: config.dataDir,
    flushers: Object.entries(config.flushers)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: String(err) });
  const breadcrumbDir = resolveBreadcrumbDataDir();
  writeStartupCrash({
    dataDir: breadcrumbDir,
    phase: 'startup',
    version: readInstalledVersion(breadcrumbDir),
    error: err,
  });
  process.exit(1);
});

// Re-export for programmatic use
export { Orchestrator } from './core/orchestrator.js';
export { InputManager } from './core/input-manager.js';
export { AgentControlManager } from './core/agent-control-manager.js';
export { AgentDiscoveryService } from './core/agent-discovery-service.js';
// HTTP Push server temporarily disabled
// export { HttpPushServer } from './server/http-server.js';
export { loadConfig } from './core/config-loader.js';
export { BaseInput } from './inputs/base/base-input.js';
export { BaseIdeInput } from './inputs/base/base-ide-input.js';
export { BaseSqliteInput } from './inputs/base/base-sqlite-input.js';
export { BaseHookInput } from './inputs/base/base-hook-input.js';
export { BaseCliForwarder } from './inputs/base/base-cli-forwarder.js';
export { BaseSessionInput } from './inputs/base/base-session-input.js';
export { QoderSqliteInput } from './inputs/qoder-sqlite/qoder-sqlite-input.js';
export { QoderCnSqliteInput } from './inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
export { QoderCnInput } from './inputs/qoder-cn/qoder-cn-input.js';
export { QoderCnTraceInput } from './inputs/qoder-cn-trace/qoder-cn-trace-input.js';
export { QoderCliSessionInput } from './inputs/qoder-cli-session/qoder-cli-session-input.js';
export { CodexTranscriptInput } from './inputs/codex-transcript/codex-transcript-input.js';
export { CodexAbortedTurnInput } from './inputs/codex-aborted-turn/codex-aborted-turn-input.js';
export { BaseFlusher } from './flushers/base-flusher.js';
export { SlsFlusher } from './flushers/sls-flusher.js';
export { JsonlFlusher } from './flushers/jsonl-flusher.js';
export { HttpFlusher } from './flushers/http-flusher.js';
export { MultiFlusher } from './flushers/multi-flusher.js';
export { HookManager } from './hooks/hook-manager.js';
export { PipelineManager } from './pipeline/pipeline-manager.js';
export * from './types/index.js';
