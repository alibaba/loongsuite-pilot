import { Orchestrator } from './core/orchestrator.js';
// HTTP Push server removed - was placeholder for future HTTP Push collection method
// import { HttpPushServer } from './server/http-server.js';
import { loadConfig } from './core/config-loader.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Main');

async function main(): Promise<void> {
  const config = await loadConfig();

  if (!config.enabled) {
    logger.info('analytics disabled via config or AAC_ENABLED=false');
    return;
  }

  const orchestrator = new Orchestrator(config);

  // HTTP Push server temporarily disabled (no collectors using HTTP push method)
  // const httpServer = new HttpPushServer(config.port);

  const shutdown = async () => {
    logger.info('shutdown signal received');
    // await httpServer.stop();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await orchestrator.start();

  // await httpServer.start();

  logger.info('AI Agent Collector is running', {
    dataDir: config.dataDir,
    port: config.port,
    reporters: Object.entries(config.reporters)
      .filter(([, v]) => v?.enabled)
      .map(([k]) => k),
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: String(err) });
  process.exit(1);
});

// Re-export for programmatic use
export { Orchestrator } from './core/orchestrator.js';
export { CollectorManager } from './core/collector-manager.js';
export { AgentControlManager } from './core/agent-control-manager.js';
export { AgentDiscoveryService } from './core/agent-discovery-service.js';
// HTTP Push server temporarily disabled
// export { HttpPushServer } from './server/http-server.js';
export { loadConfig } from './core/config-loader.js';
export { BaseCollector } from './collectors/base/base-collector.js';
export { BaseIdeCollector } from './collectors/base/base-ide-collector.js';
export { BaseSqliteCollector } from './collectors/base/base-sqlite-collector.js';
export { BaseHookCollector } from './collectors/base/base-hook-collector.js';
export { BaseCliForwarder } from './collectors/base/base-cli-forwarder.js';
export { BaseSessionCollector } from './collectors/base/base-session-collector.js';
export { BaseHttpPushCollector } from './collectors/base/base-http-push-collector.js';
export { BaseReporter } from './reporters/base-reporter.js';
export { SlsReporter } from './reporters/sls-reporter.js';
export { JsonlReporter } from './reporters/jsonl-reporter.js';
export { HttpReporter } from './reporters/http-reporter.js';
export { MultiReporter } from './reporters/multi-reporter.js';
export { HookManager } from './hooks/hook-manager.js';
export * from './types/index.js';
